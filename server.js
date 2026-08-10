const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "database.json");

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
app.use(express.static(PUBLIC_DIR));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultDatabase() {
  return {
    users: [],
    servers: [],
    messages: [],
    friendships: []
  };
}

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const db = defaultDatabase();
      saveDatabase(db);
      return db;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");

    if (!raw.trim()) {
      return defaultDatabase();
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("Erreur lecture database:", error);
    return defaultDatabase();
  }
}

let db = loadDatabase();

function saveDatabase() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(db, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Erreur sauvegarde database:", error);
  }
}

function id() {
  return crypto.randomUUID();
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

function cleanUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || "",
    createdAt: user.createdAt
  };
}

function getUser(userId) {
  return db.users.find(user => user.id === userId);
}

function findUserByUsername(username) {
  const wanted = String(username || "")
    .trim()
    .toLowerCase();

  return db.users.find(
    user =>
      user.username.toLowerCase() === wanted
  );
}

function findUserByLogin(login) {
  const wanted = String(login || "")
    .trim()
    .toLowerCase();

  return db.users.find(
    user =>
      user.username.toLowerCase() === wanted ||
      user.email.toLowerCase() === wanted
  );
}

function getFriends(userId) {
  const relations = db.friendships.filter(
    relation =>
      relation.userId === userId ||
      relation.friendId === userId
  );

  const ids = relations.map(relation =>
    relation.userId === userId
      ? relation.friendId
      : relation.userId
  );

  return ids
    .map(getUser)
    .filter(Boolean)
    .map(cleanUser);
}

function getServerForUser(serverId, userId) {
  const serverData = db.servers.find(
    serverItem => serverItem.id === serverId
  );

  if (!serverData) return null;

  if (!serverData.members.includes(userId)) {
    return null;
  }

  return serverData;
}

function publicServer(serverData) {
  return {
    id: serverData.id,
    name: serverData.name,
    icon: serverData.icon || "",
    ownerId: serverData.ownerId,
    members: serverData.members,
    channels: serverData.channels
  };
}

function makeServer(name, icon, ownerId) {
  const serverId = id();

  return {
    id: serverId,
    name,
    icon: icon || "",
    ownerId,
    members: [ownerId],
    channels: [
      {
        id: id(),
        name: "général",
        type: "text"
      },
      {
        id: id(),
        name: "Général",
        type: "voice"
      }
    ],
    createdAt: Date.now()
  };
}

function getServersForUser(userId) {
  return db.servers
    .filter(serverItem =>
      serverItem.members.includes(userId)
    )
    .map(publicServer);
}

function getMessagesForChannel(channelId) {
  return db.messages
    .filter(message =>
      message.channelId === channelId
    )
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt
    );
}

function getDmMessages(userA, userB) {
  return db.messages
    .filter(message =>
      message.type === "dm" &&
      (
        (
          message.from === userA &&
          message.to === userB
        ) ||
        (
          message.from === userB &&
          message.to === userA
        )
      )
    )
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt
    );
}

function messageForClient(message) {
  const user = getUser(message.from);

  return {
    ...message,
    displayName: user
      ? user.displayName
      : "Utilisateur",
    username: user
      ? user.username
      : "",
    avatar: user
      ? user.avatar || ""
      : ""
  };
}

const onlineUsers = new Map();
const voiceRooms = new Map();

function sendVoiceUsers(channelId) {
  const room = voiceRooms.get(channelId);

  if (!room) {
    return;
  }

  const users = [];

  for (const socketId of room) {
    const info = onlineUsers.get(socketId);

    if (!info) continue;

    const user = getUser(info.userId);

    if (!user) continue;

    users.push({
      socketId,
      user: cleanUser(user)
    });
  }

  io.to("voice:" + channelId).emit(
    "voice_users",
    {
      channelId,
      users
    }
  );
}

function leaveVoice(socket) {
  const currentVoice =
    socket.data.voiceChannelId;

  if (!currentVoice) {
    return;
  }

  const room = voiceRooms.get(
    currentVoice
  );

  if (room) {
    room.delete(socket.id);

    if (room.size === 0) {
      voiceRooms.delete(currentVoice);
    }
  }

  socket.leave(
    "voice:" + currentVoice
  );

  socket.to(
    "voice:" + currentVoice
  ).emit(
    "voice_user_left",
    {
      socketId: socket.id
    }
  );

  sendVoiceUsers(currentVoice);

  socket.data.voiceChannelId = null;
}

/* =========================
   API
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "NovaChat",
    time: Date.now()
  });
});

/* INSCRIPTION */

app.post("/api/register", (req, res) => {
  try {
    const email = String(
      req.body.email || ""
    ).trim();

    const username = String(
      req.body.username || ""
    ).trim();

    const displayName = String(
      req.body.displayName ||
      username
    ).trim();

    const password = String(
      req.body.password || ""
    );

    if (!email || !username || !password) {
      return res.status(400).json({
        ok: false,
        error:
          "L'email, le nom d'utilisateur et le mot de passe sont obligatoires."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error:
          "Le mot de passe doit contenir au moins 6 caractères."
      });
    }

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      return res.status(400).json({
        ok: false,
        error:
          "Nom d'utilisateur invalide. Utilise 3 à 32 caractères."
      });
    }

    if (
      db.users.some(
        user =>
          user.email.toLowerCase() ===
          email.toLowerCase()
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "Cet email est déjà utilisé."
      });
    }

    if (findUserByUsername(username)) {
      return res.status(400).json({
        ok: false,
        error:
          "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    const user = {
      id: id(),
      email,
      username,
      displayName:
        displayName || username,
      passwordHash:
        hashPassword(password),
      avatar: "",
      lastUsernameChange: Date.now(),
      createdAt: Date.now()
    };

    db.users.push(user);
    saveDatabase();

    res.json({
      ok: true,
      user: cleanUser(user)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erreur serveur."
    });
  }
});

/* CONNEXION */

app.post("/api/login", (req, res) => {
  try {
    const login = String(
      req.body.login || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

    if (!login || !password) {
      return res.status(400).json({
        ok: false,
        error:
          "Remplis tous les champs."
      });
    }

    const user =
      findUserByLogin(login);

    if (
      !user ||
      user.passwordHash !==
        hashPassword(password)
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "Identifiants incorrects."
      });
    }

    res.json({
      ok: true,
      user: cleanUser(user)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erreur serveur."
    });
  }
});

/* AMIS */

app.get("/api/friends/:userId", (req, res) => {
  const user = getUser(req.params.userId);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  res.json({
    ok: true,
    friends: getFriends(user.id)
  });
});

app.post("/api/friends/add", (req, res) => {
  const userId = String(
    req.body.userId || ""
  );

  const username = String(
    req.body.username || ""
  ).trim();

  const user = getUser(userId);
  const friend =
    findUserByUsername(username);

  if (!user || !friend) {
    return res.status(404).json({
      ok: false,
      error:
        "Utilisateur introuvable."
    });
  }

  if (user.id === friend.id) {
    return res.status(400).json({
      ok: false,
      error:
        "Tu ne peux pas t'ajouter toi-même."
    });
  }

  const exists =
    db.friendships.some(
      relation =>
        (
          relation.userId === user.id &&
          relation.friendId === friend.id
        ) ||
        (
          relation.userId === friend.id &&
          relation.friendId === user.id
        )
    );

  if (exists) {
    return res.status(400).json({
      ok: false,
      error:
        "Cette personne est déjà dans tes amis."
    });
  }

  db.friendships.push({
    id: id(),
    userId: user.id,
    friendId: friend.id,
    createdAt: Date.now()
  });

  saveDatabase();

  for (const [
    socketId,
    info
  ] of onlineUsers.entries()) {
    if (
      info.userId === user.id ||
      info.userId === friend.id
    ) {
      io.to(socketId).emit(
        "friend_added",
        {
          userId: user.id,
          friendId: friend.id
        }
      );
    }
  }

  res.json({
    ok: true,
    friend: cleanUser(friend)
  });
});

/* MP */

app.get(
  "/api/dm/:userId/:friendId",
  (req, res) => {
    const userId =
      req.params.userId;

    const friendId =
      req.params.friendId;

    if (
      !getUser(userId) ||
      !getUser(friendId)
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "Utilisateur introuvable."
      });
    }

    res.json({
      ok: true,
      messages:
        getDmMessages(
          userId,
          friendId
        ).map(messageForClient)
    });
  }
);

/* SERVEURS */

app.get(
  "/api/servers/:userId",
  (req, res) => {
    const user = getUser(
      req.params.userId
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    res.json({
      ok: true,
      servers:
        getServersForUser(user.id)
    });
  }
);

app.post("/api/servers", (req, res) => {
  const ownerId = String(
    req.body.ownerId || ""
  );

  const name = String(
    req.body.name || ""
  ).trim();

  const icon = String(
    req.body.icon || ""
  );

  const owner = getUser(ownerId);

  if (!owner) {
    return res.status(401).json({
      ok: false,
      error:
        "Utilisateur invalide."
    });
  }

  if (!name) {
    return res.status(400).json({
      ok: false,
      error:
        "Le serveur doit avoir un nom."
    });
  }

  const serverData =
    makeServer(
      name,
      icon,
      owner.id
    );

  db.servers.push(serverData);
  saveDatabase();

  res.json({
    ok: true,
    server:
      publicServer(serverData)
  });
});

app.post(
  "/api/servers/join",
  (req, res) => {
    const userId = String(
      req.body.userId || ""
    );

    const serverId = String(
      req.body.serverId || ""
    );

    const user = getUser(userId);
    const serverData =
      db.servers.find(
        item => item.id === serverId
      );

    if (!user || !serverData) {
      return res.status(404).json({
        ok: false,
        error:
          "Serveur ou utilisateur introuvable."
      });
    }

    if (
      !serverData.members.includes(
        user.id
      )
    ) {
      serverData.members.push(
        user.id
      );

      saveDatabase();
    }

    res.json({
      ok: true,
      server:
        publicServer(serverData)
    });
  }
);

/* MESSAGES SALON */

app.get(
  "/api/channels/:channelId/messages",
  (req, res) => {
    const channelId =
      req.params.channelId;

    res.json({
      ok: true,
      messages:
        getMessagesForChannel(
          channelId
        ).map(messageForClient)
    });
  }
);

/* PROFIL */

app.post(
  "/api/profile",
  (req, res) => {
    const userId = String(
      req.body.userId || ""
    );

    const user = getUser(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      req.body.displayName !==
      undefined
    ) {
      const displayName = String(
        req.body.displayName
      ).trim();

      if (displayName) {
        user.displayName =
          displayName;
      }
    }

    if (
      req.body.avatar !==
      undefined
    ) {
      user.avatar =
        String(req.body.avatar || "");
    }

    saveDatabase();

    io.emit(
      "user_updated",
      cleanUser(user)
    );

    res.json({
      ok: true,
      user: cleanUser(user)
    });
  }
);

/* NOM UTILISATEUR */

app.post(
  "/api/username",
  (req, res) => {
    const userId = String(
      req.body.userId || ""
    );

    const username = String(
      req.body.username || ""
    ).trim();

    const user = getUser(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(
        username
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Nom d'utilisateur invalide."
      });
    }

    if (
      username.toLowerCase() !==
      user.username.toLowerCase()
    ) {
      const existing =
        findUserByUsername(username);

      if (
        existing &&
        existing.id !== user.id
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Ce nom d'utilisateur est déjà pris."
        });
      }

      const twoWeeks =
        14 * 24 * 60 * 60 * 1000;

      if (
        user.lastUsernameChange &&
        Date.now() -
          user.lastUsernameChange <
          twoWeeks
      ) {
        const remaining =
          twoWeeks -
          (
            Date.now() -
            user.lastUsernameChange
          );

        const days = Math.ceil(
          remaining /
            (24 * 60 * 60 * 1000)
        );

        return res.status(400).json({
          ok: false,
          error:
            `Tu dois attendre encore ${days} jour(s) avant de changer ton nom d'utilisateur.`
        });
      }

      user.username =
        username;

      user.lastUsernameChange =
        Date.now();

      saveDatabase();

      io.emit(
        "user_updated",
        cleanUser(user)
      );
    }

    res.json({
      ok: true,
      user: cleanUser(user)
    });
  }
);

/* PAGE */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      "index.html"
    )
  );
});

/* =========================
   SOCKET.IO
========================= */

io.on("connection", socket => {
  console.log(
    "Connexion:",
    socket.id
  );

  socket.on(
    "identify",
    userId => {
      const user =
        getUser(userId);

      if (!user) return;

      onlineUsers.set(
        socket.id,
        {
          userId
        }
      );

      socket.data.userId =
        userId;

      socket.broadcast.emit(
        "presence",
        {
          userId,
          online: true
        }
      );
    }
  );

  /* MP */

  socket.on(
    "dm_send",
    data => {
      const sender =
        getUser(
          socket.data.userId
        );

      const recipient =
        getUser(
          data.to
        );

      if (
        !sender ||
        !recipient
      ) {
        return;
      }

      const content =
        String(
          data.content || ""
        ).trim();

      if (!content) return;

      const message = {
        id: id(),
        type: "dm",
        from: sender.id,
        to: recipient.id,
        content,
        createdAt: Date.now()
      };

      db.messages.push(message);
      saveDatabase();

      const output =
        messageForClient(
          message
        );

      socket.emit(
        "dm_message",
        output
      );

      for (const [
        socketId,
        info
      ] of onlineUsers.entries()) {
        if (
          info.userId ===
          recipient.id
        ) {
          io.to(socketId).emit(
            "dm_message",
            output
          );
        }
      }
    }
  );

  /* SERVEUR */

  socket.on(
    "server_join",
    serverId => {
      const userId =
        socket.data.userId;

      if (!userId) return;

      const serverData =
        getServerForUser(
          serverId,
          userId
        );

      if (!serverData) return;

      socket.join(
        "server:" + serverId
      );
    }
  );

  /* MESSAGE SALON */

  socket.on(
    "channel_send",
    data => {
      const userId =
        socket.data.userId;

      const serverData =
        getServerForUser(
          data.serverId,
          userId
        );

      if (!serverData) return;

      const channel =
        serverData.channels.find(
          item =>
            item.id ===
            data.channelId
        );

      if (
        !channel ||
        channel.type !==
          "text"
      ) {
        return;
      }

      const content =
        String(
          data.content || ""
        ).trim();

      if (!content) return;

      const message = {
        id: id(),
        type: "channel",
        from: userId,
        serverId:
          data.serverId,
        channelId:
          data.channelId,
        content,
        createdAt: Date.now()
      };

      db.messages.push(message);
      saveDatabase();

      io.to(
        "server:" +
          data.serverId
      ).emit(
        "channel_message",
        messageForClient(
          message
        )
      );
    }
  );

  /* =====================
     VOCAL SERVEUR
  ===================== */

  socket.on(
    "voice_join",
    data => {
      const userId =
        socket.data.userId;

      const serverData =
        getServerForUser(
          data.serverId,
          userId
        );

      if (!serverData) return;

      const channel =
        serverData.channels.find(
          item =>
            item.id ===
            data.channelId
        );

      if (
        !channel ||
        channel.type !==
          "voice"
      ) {
        return;
      }

      if (
        socket.data.voiceChannelId
      ) {
        leaveVoice(socket);
      }

      const channelId =
        data.channelId;

      if (
        !voiceRooms.has(
          channelId
        )
      ) {
        voiceRooms.set(
          channelId,
          new Set()
        );
      }

      const room =
        voiceRooms.get(
          channelId
        );

      const previousUsers =
        Array.from(room);

      room.add(socket.id);

      socket.join(
        "voice:" + channelId
      );

      socket.data.voiceChannelId =
        channelId;

      socket.data.voiceServerId =
        data.serverId;

      socket.to(
        "voice:" + channelId
      ).emit(
        "voice_user_joined",
        {
          socketId: socket.id
        }
      );

      socket.emit(
        "voice_existing_users",
        {
          users: previousUsers
        }
      );

      sendVoiceUsers(
        channelId
      );
    }
  );

  socket.on(
    "voice_leave",
    () => {
      leaveVoice(socket);
    }
  );

  /* =====================
     WEBRTC MP + SERVEUR
  ===================== */

  socket.on(
    "webrtc_offer",
    data => {
      if (!data.target) return;

      io.to(
        data.target
      ).emit(
        "webrtc_offer",
        {
          from: socket.id,
          offer: data.offer
        }
      );
    }
  );

  socket.on(
    "webrtc_answer",
    data => {
      if (!data.target) return;

      io.to(
        data.target
      ).emit(
        "webrtc_answer",
        {
          from: socket.id,
          answer:
            data.answer
        }
      );
    }
  );

  socket.on(
    "webrtc_ice",
    data => {
      if (!data.target) return;

      io.to(
        data.target
      ).emit(
        "webrtc_ice",
        {
          from: socket.id,
          candidate:
            data.candidate
        }
      );
    }
  );

  socket.on(
    "disconnect",
    () => {
      const info =
        onlineUsers.get(
          socket.id
        );

      if (
        socket.data.voiceChannelId
      ) {
        leaveVoice(socket);
      }

      if (info) {
        socket.broadcast.emit(
          "presence",
          {
            userId:
              info.userId,
            online: false
          }
        );
      }

      onlineUsers.delete(
        socket.id
      );

      console.log(
        "Déconnexion:",
        socket.id
      );
    }
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `NovaChat lancé sur le port ${PORT}`
    );
  }
);