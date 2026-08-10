const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
====================================================
                    DONNÉES
====================================================
*/

// Utilisateurs actuellement connectés
const users = new Map();

// Relations d'amitié
// userId -> Set(userId)
const friends = new Map();

// Demandes d'amitié
// userId -> Set(userId)
const friendRequests = new Map();

// Messages privés en mémoire
// conversationId -> Array(messages)
const privateMessages = new Map();

// Salons vocaux
// roomId -> Set(socketId)
const voiceRooms = new Map();


/*
====================================================
                  UTILITAIRES
====================================================
*/

function cleanName(name) {
  return String(name || "Utilisateur")
    .trim()
    .slice(0, 24) || "Utilisateur";
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    avatar: user.username.charAt(0).toUpperCase()
  };
}

function getOnlineUsers() {
  return [...users.values()].map(publicUser);
}

function ensureSet(map, key) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }

  return map.get(key);
}

function conversationId(a, b) {
  return [a, b].sort().join(":");
}

function getFriends(userId) {
  const list = friends.get(userId);

  if (!list) {
    return [];
  }

  return [...list]
    .map(id => users.get(id))
    .filter(Boolean)
    .map(publicUser);
}

function emitFriends(userId) {
  const user = users.get(userId);

  if (!user) return;

  io.to(user.socketRoom).emit("friends-list", {
    friends: getFriends(userId)
  });
}

function emitOnlineUsers() {
  io.emit("online-users", getOnlineUsers());
}


/*
====================================================
                     CONNEXION
====================================================
*/

io.on("connection", socket => {

  console.log("Nouvelle connexion :", socket.id);


  /*
  ==================================================
                    CONNEXION UTILISATEUR
  ==================================================
  */

  socket.on("login", username => {

    const name = cleanName(username);

    const user = {
      id: socket.id,
      username: name,
      socketRoom: socket.id
    };

    users.set(socket.id, user);

    socket.join(socket.id);

    ensureSet(friends, socket.id);
    ensureSet(friendRequests, socket.id);

    socket.emit("login-ok", {
      id: socket.id,
      username: name,
      friends: getFriends(socket.id)
    });

    emitOnlineUsers();

    console.log(`${name} est connecté`);
  });


  /*
  ==================================================
                    LISTE DES AMIS
  ==================================================
  */

  socket.on("get-friends", () => {

    if (!users.has(socket.id)) return;

    socket.emit("friends-list", {
      friends: getFriends(socket.id)
    });
  });


  /*
  ==================================================
                 AJOUTER UN AMI
  ==================================================
  */

  socket.on("send-friend-request", data => {

    const targetId = String(data?.userId || "");

    const sender = users.get(socket.id);
    const target = users.get(targetId);

    if (!sender || !target) {
      socket.emit("friend-error", {
        message: "Utilisateur introuvable."
      });

      return;
    }

    if (targetId === socket.id) {
      socket.emit("friend-error", {
        message: "Tu ne peux pas t'ajouter toi-même."
      });

      return;
    }

    const senderFriends = ensureSet(friends, socket.id);

    if (senderFriends.has(targetId)) {
      socket.emit("friend-error", {
        message: "Vous êtes déjà amis."
      });

      return;
    }

    const requests = ensureSet(friendRequests, targetId);

    if (requests.has(socket.id)) {
      socket.emit("friend-error", {
        message: "Demande déjà envoyée."
      });

      return;
    }

    requests.add(socket.id);

    socket.emit("friend-request-sent", {
      user: publicUser(target)
    });

    io.to(target.socketRoom).emit("friend-request", {
      from: publicUser(sender)
    });
  });


  /*
  ==================================================
                ACCEPTER UNE DEMANDE
  ==================================================
  */

  socket.on("accept-friend-request", data => {

    const requesterId = String(data?.userId || "");

    const requester = users.get(requesterId);
    const currentUser = users.get(socket.id);

    if (!currentUser || !requester) {
      return;
    }

    const requests = ensureSet(friendRequests, socket.id);

    if (!requests.has(requesterId)) {
      return;
    }

    requests.delete(requesterId);

    ensureSet(friends, socket.id).add(requesterId);
    ensureSet(friends, requesterId).add(socket.id);

    socket.emit("friend-added", {
      user: publicUser(requester)
    });

    io.to(requester.socketRoom).emit("friend-added", {
      user: publicUser(currentUser)
    });

    emitFriends(socket.id);
    emitFriends(requesterId);
  });


  /*
  ==================================================
                REFUSER UNE DEMANDE
  ==================================================
  */

  socket.on("decline-friend-request", data => {

    const requesterId = String(data?.userId || "");

    const requests = ensureSet(friendRequests, socket.id);

    requests.delete(requesterId);

    socket.emit("friend-request-declined", {
      userId: requesterId
    });
  });


  /*
  ==================================================
                     SUPPRIMER AMI
  ==================================================
  */

  socket.on("remove-friend", data => {

    const friendId = String(data?.userId || "");

    const myFriends = ensureSet(friends, socket.id);

    myFriends.delete(friendId);

    const theirFriends = ensureSet(friends, friendId);

    theirFriends.delete(socket.id);

    emitFriends(socket.id);

    if (users.has(friendId)) {
      emitFriends(friendId);

      io.to(users.get(friendId).socketRoom).emit(
        "friend-removed",
        {
          userId: socket.id
        }
      );
    }
  });


  /*
  ==================================================
                    MESSAGES PRIVÉS
  ==================================================
  */

  socket.on("get-private-messages", data => {

    const otherUserId = String(data?.userId || "");

    if (!users.has(socket.id)) return;

    const id = conversationId(socket.id, otherUserId);

    socket.emit("private-message-history", {
      userId: otherUserId,
      messages: privateMessages.get(id) || []
    });
  });


  socket.on("send-private-message", data => {

    const targetId = String(data?.to || "");
    const content = String(data?.content || "")
      .trim()
      .slice(0, 4000);

    const sender = users.get(socket.id);
    const target = users.get(targetId);

    if (!sender || !target || !content) {
      return;
    }

    const id = conversationId(socket.id, targetId);

    const message = {
      id:
        Date.now() +
        "-" +
        Math.random()
          .toString(16)
          .slice(2),

      from: socket.id,

      fromUsername: sender.username,

      to: targetId,

      content,

      createdAt: Date.now()
    };

    if (!privateMessages.has(id)) {
      privateMessages.set(id, []);
    }

    privateMessages.get(id).push(message);

    /*
    Limite l'historique à 500 messages
    */

    if (privateMessages.get(id).length > 500) {
      privateMessages.get(id).shift();
    }

    socket.emit("new-private-message", message);

    io.to(target.socketRoom).emit(
      "new-private-message",
      message
    );
  });


  /*
  ==================================================
                       VOCAL
  ==================================================
  */

  socket.on("join-voice", roomId => {

    if (!users.has(socket.id)) {
      return;
    }

    roomId = String(roomId || "general");

    /*
    Si déjà dans un vocal,
    on le retire d'abord.
    */

    leaveVoice(socket);

    if (!voiceRooms.has(roomId)) {
      voiceRooms.set(roomId, new Set());
    }

    const room = voiceRooms.get(roomId);

    /*
    Liste des utilisateurs déjà présents
    AVANT d'ajouter le nouvel utilisateur.
    */

    const existingUsers = [...room]
      .map(id => users.get(id))
      .filter(Boolean)
      .map(publicUser);

    socket.join("voice:" + roomId);

    room.add(socket.id);

    socket.data.voiceRoom = roomId;

    /*
    On donne au nouvel utilisateur
    la liste des personnes déjà présentes.
    */

    socket.emit("voice-existing-users", existingUsers);

    /*
    Les autres utilisateurs apprennent
    qu'une nouvelle personne vient d'arriver.
    */

    socket.to("voice:" + roomId).emit(
      "user-joined-voice",
      publicUser(users.get(socket.id))
    );

    emitVoiceUsers(roomId);
  });


  /*
  ==================================================
                    QUITTER VOCAL
  ==================================================
  */

  socket.on("leave-voice", () => {
    leaveVoice(socket);
  });


  /*
  ==================================================
                UTILISATEURS DU VOCAL
  ==================================================
  */

  function emitVoiceUsers(roomId) {

    const room = voiceRooms.get(roomId);

    if (!room) {
      return;
    }

    const members = [...room]
      .map(id => users.get(id))
      .filter(Boolean)
      .map(publicUser);

    io.to("voice:" + roomId).emit(
      "voice-users",
      members
    );
  }


  /*
  ==================================================
                    SIGNAL WEBRTC
  ==================================================
  */

  socket.on("webrtc-offer", data => {

    const target = String(data?.to || "");

    if (!users.has(target)) {
      return;
    }

    io.to(target).emit("webrtc-offer", {
      from: socket.id,
      offer: data.offer
    });
  });


  socket.on("webrtc-answer", data => {

    const target = String(data?.to || "");

    if (!users.has(target)) {
      return;
    }

    io.to(target).emit("webrtc-answer", {
      from: socket.id,
      answer: data.answer
    });
  });


  socket.on("webrtc-ice-candidate", data => {

    const target = String(data?.to || "");

    if (!users.has(target)) {
      return;
    }

    io.to(target).emit(
      "webrtc-ice-candidate",
      {
        from: socket.id,
        candidate: data.candidate
      }
    );
  });


  /*
  ==================================================
                   CHAT SERVEUR
  ==================================================
  */

  socket.on("send-message", data => {

    const user = users.get(socket.id);

    if (!user) {
      return;
    }

    const channel = String(
      data?.channel || "general"
    ).slice(0, 50);

    const content = String(
      data?.content || ""
    )
      .trim()
      .slice(0, 4000);

    if (!content) {
      return;
    }

    const message = {
      id:
        Date.now() +
        "-" +
        Math.random()
          .toString(16)
          .slice(2),

      userId: socket.id,

      username: user.username,

      channel,

      content,

      createdAt: Date.now()
    };

    /*
    Pour l'instant le message serveur
    est diffusé à tous les utilisateurs connectés.
    */

    io.emit("new-message", message);
  });


  /*
  ==================================================
                    DÉCONNEXION
  ==================================================
  */

  socket.on("disconnect", () => {

    console.log(
      "Utilisateur déconnecté :",
      socket.id
    );

    leaveVoice(socket);

    /*
    Supprime l'utilisateur de la mémoire.
    */

    users.delete(socket.id);

    /*
    Nettoyage des demandes d'ami
    */

    friendRequests.delete(socket.id);

    for (const requests of friendRequests.values()) {
      requests.delete(socket.id);
    }

    /*
    Nettoyage des relations d'amitié
    */

    const myFriends = friends.get(socket.id);

    if (myFriends) {

      for (const friendId of myFriends) {

        const friendSet = friends.get(friendId);

        if (friendSet) {
          friendSet.delete(socket.id);
        }

        if (users.has(friendId)) {
          emitFriends(friendId);
        }
      }
    }

    friends.delete(socket.id);

    emitOnlineUsers();
  });
});


/*
====================================================
                 QUITTER UN VOCAL
====================================================
*/

function leaveVoice(socket) {

  const roomId = socket.data.voiceRoom;

  if (!roomId) {
    return;
  }

  const room = voiceRooms.get(roomId);

  if (room) {

    room.delete(socket.id);

    socket.leave("voice:" + roomId);

    socket
      .to("voice:" + roomId)
      .emit(
        "user-left-voice",
        socket.id
      );

    if (room.size === 0) {
      voiceRooms.delete(roomId);
    } else {
      emitVoiceUsers(roomId);
    }
  }

  socket.data.voiceRoom = null;
}


/*
====================================================
                       API
====================================================
*/

app.get("/api/status", (req, res) => {

  res.json({
    online: users.size,
    voiceRooms: [...voiceRooms.entries()].map(
      ([name, members]) => ({
        name,
        users: members.size
      })
    )
  });
});


/*
====================================================
                    DÉMARRAGE
====================================================
*/

server.listen(PORT, "0.0.0.0", () => {

  console.log(
    `NovaChat lancé sur le port ${PORT}`
  );

});