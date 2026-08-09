const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/*
 * ============================================================
 * NOVACHAT - SERVEUR TEMPS RÉEL
 * ============================================================
 *
 * Le serveur gère :
 * - présence des utilisateurs
 * - messages publics
 * - messages privés
 * - salons vocaux
 * - signalisation WebRTC
 * - offres / réponses WebRTC
 * - ICE candidates
 *
 * Les données sont conservées en mémoire.
 * Un redémarrage du serveur remet donc les données à zéro.
 */

const wss = new WebSocket.Server({ server });

const clients = new Map();
const messages = new Map();
const privateMessages = new Map();

const users = [
  {
    id: "alex",
    username: "Alex",
    displayName: "Alex",
    status: "En ligne",
    avatar: "A",
    description: "J'aime coder et jouer.",
    role: "Administrateur"
  },
  {
    id: "lina",
    username: "Lina",
    displayName: "Lina",
    status: "En ligne",
    avatar: "L",
    description: "Créatrice de contenu 🎨",
    role: "Modératrice"
  },
  {
    id: "max",
    username: "Max",
    displayName: "Max",
    status: "En ligne",
    avatar: "M",
    description: "Toujours prêt pour une partie.",
    role: "Membre"
  },
  {
    id: "zoe",
    username: "Zoe",
    displayName: "Zoe",
    status: "Absente",
    avatar: "Z",
    description: "Musique, jeux et café ☕",
    role: "Membre"
  },
  {
    id: "nathan",
    username: "Nathan",
    displayName: "Nathan",
    status: "En ligne",
    avatar: "N",
    description: "Développeur full-stack.",
    role: "Membre"
  },
  {
    id: "emma",
    username: "Emma",
    displayName: "Emma",
    status: "Hors ligne",
    avatar: "E",
    description: "Bienvenue sur NovaChat !",
    role: "Membre"
  },
  {
    id: "leo",
    username: "Leo",
    displayName: "Leo",
    status: "En ligne",
    avatar: "L",
    description: "Gaming 🎮",
    role: "Membre"
  },
  {
    id: "chloe",
    username: "Chloe",
    displayName: "Chloe",
    status: "En ligne",
    avatar: "C",
    description: "Je teste NovaChat.",
    role: "Membre"
  },
  {
    id: "sam",
    username: "Sam",
    displayName: "Sam",
    status: "Ne pas déranger",
    avatar: "S",
    description: "Concentration maximale.",
    role: "Membre"
  },
  {
    id: "tom",
    username: "Tom",
    displayName: "Tom",
    status: "Hors ligne",
    avatar: "T",
    description: "Fan de jeux indépendants.",
    role: "Membre"
  }
];

const demoMessages = [
  {
    id: "m1",
    channel: "general",
    userId: "alex",
    username: "Alex",
    content: "Bienvenue sur NovaChat ! 🚀",
    time: Date.now() - 1000 * 60 * 70,
    reactions: {
      "🚀": ["lina", "max"],
      "❤️": ["zoe"]
    }
  },
  {
    id: "m2",
    channel: "general",
    userId: "lina",
    username: "Lina",
    content: "L'interface commence vraiment à prendre forme 😎",
    time: Date.now() - 1000 * 60 * 60,
    reactions: {
      "😎": ["alex"]
    }
  },
  {
    id: "m3",
    channel: "general",
    userId: "max",
    username: "Max",
    content: "Le vocal fonctionne aussi ?",
    time: Date.now() - 1000 * 60 * 40,
    reactions: {
      "🎙️": ["alex", "lina"]
    }
  },
  {
    id: "m4",
    channel: "general",
    userId: "alex",
    username: "Alex",
    content: "Oui ! Rejoins le salon vocal et autorise ton micro.",
    time: Date.now() - 1000 * 60 * 35,
    reactions: {
      "🔥": ["max", "leo"]
    }
  },
  {
    id: "m5",
    channel: "general",
    userId: "zoe",
    username: "Zoe",
    content: "On pourrait faire une soirée gaming ce soir 🎮",
    time: Date.now() - 1000 * 60 * 20,
    reactions: {
      "🎮": ["leo", "max"],
      "❤️": ["lina"]
    }
  }
];

messages.set("general", demoMessages);

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, except = null) {
  for (const client of clients.values()) {
    if (client.ws !== except) {
      send(client.ws, data);
    }
  }
}

function broadcastUsers() {
  const online = [...clients.values()].map(client => ({
    id: client.id,
    username: client.username,
    displayName: client.username,
    avatar: client.username.charAt(0).toUpperCase(),
    status: "En ligne"
  }));

  broadcast({
    type: "presence",
    users: online
  });
}

function getPrivateKey(a, b) {
  return [a, b].sort().join(":");
}

function sendHistory(ws, channel) {
  send(ws, {
    type: "history",
    channel,
    messages: messages.get(channel) || []
  });
}

wss.on("connection", ws => {
  let client = null;

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /*
     * --------------------------------------------------------
     * CONNEXION
     * --------------------------------------------------------
     */

    if (data.type === "login") {
      const username =
        String(data.username || "Utilisateur")
          .trim()
          .slice(0, 24);

      const id =
        `${username.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Math.random()
          .toString(36)
          .slice(2, 7)}`;

      client = {
        id,
        username,
        ws,
        voiceRoom: null
      };

      clients.set(id, client);

      send(ws, {
        type: "login-success",
        user: {
          id,
          username,
          avatar: username.charAt(0).toUpperCase()
        }
      });

      sendHistory(ws, "general");
      broadcastUsers();

      return;
    }

    if (!client) return;

    /*
     * --------------------------------------------------------
     * CHAT PUBLIC
     * --------------------------------------------------------
     */

    if (data.type === "message") {
      const channel = String(data.channel || "general");
      const content = String(data.content || "").trim();

      if (!content) return;

      const message = {
        id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        channel,
        userId: client.id,
        username: client.username,
        content: content.slice(0, 4000),
        time: Date.now(),
        reactions: {}
      };

      if (!messages.has(channel)) {
        messages.set(channel, []);
      }

      messages.get(channel).push(message);

      if (messages.get(channel).length > 200) {
        messages.get(channel).shift();
      }

      broadcast({
        type: "new-message",
        message
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * RÉACTION
     * --------------------------------------------------------
     */

    if (data.type === "reaction") {
      const channel = String(data.channel || "general");
      const messageId = String(data.messageId || "");
      const emoji = String(data.emoji || "");

      const channelMessages = messages.get(channel) || [];
      const message = channelMessages.find(m => m.id === messageId);

      if (!message || !emoji) return;

      if (!message.reactions) {
        message.reactions = {};
      }

      if (!message.reactions[emoji]) {
        message.reactions[emoji] = [];
      }

      const usersReacted = message.reactions[emoji];
      const index = usersReacted.indexOf(client.id);

      if (index >= 0) {
        usersReacted.splice(index, 1);
      } else {
        usersReacted.push(client.id);
      }

      broadcast({
        type: "reaction-update",
        channel,
        messageId,
        reactions: message.reactions
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * SUPPRESSION
     * --------------------------------------------------------
     */

    if (data.type === "delete-message") {
      const channel = String(data.channel || "general");
      const messageId = String(data.messageId || "");

      const channelMessages = messages.get(channel) || [];
      const index = channelMessages.findIndex(m => m.id === messageId);

      if (index === -1) return;

      if (channelMessages[index].userId !== client.id) {
        return;
      }

      channelMessages.splice(index, 1);

      broadcast({
        type: "message-deleted",
        channel,
        messageId
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * MODIFICATION
     * --------------------------------------------------------
     */

    if (data.type === "edit-message") {
      const channel = String(data.channel || "general");
      const messageId = String(data.messageId || "");
      const content = String(data.content || "").trim();

      const channelMessages = messages.get(channel) || [];
      const message = channelMessages.find(m => m.id === messageId);

      if (!message || message.userId !== client.id || !content) {
        return;
      }

      message.content = content.slice(0, 4000);
      message.edited = true;

      broadcast({
        type: "message-edited",
        channel,
        message
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * MESSAGES PRIVÉS
     * --------------------------------------------------------
     */

    if (data.type === "private-message") {
      const receiverId = String(data.receiverId || "");
      const content = String(data.content || "").trim();

      if (!receiverId || !content) return;

      const receiver = clients.get(receiverId);

      if (!receiver) {
        send(ws, {
          type: "error-message",
          message: "Cette personne n'est pas actuellement connectée."
        });
        return;
      }

      const key = getPrivateKey(client.id, receiverId);

      if (!privateMessages.has(key)) {
        privateMessages.set(key, []);
      }

      const message = {
        id: "dm-" + Date.now() + Math.random().toString(36).slice(2),
        senderId: client.id,
        senderName: client.username,
        receiverId,
        content: content.slice(0, 4000),
        time: Date.now()
      };

      privateMessages.get(key).push(message);

      send(receiver.ws, {
        type: "private-message",
        message
      });

      send(ws, {
        type: "private-message",
        message
      });

      return;
    }

    if (data.type === "private-history") {
      const receiverId = String(data.receiverId || "");
      const key = getPrivateKey(client.id, receiverId);

      send(ws, {
        type: "private-history",
        receiverId,
        messages: privateMessages.get(key) || []
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * ENTRÉE DANS UN SALON VOCAL
     * --------------------------------------------------------
     */

    if (data.type === "voice-join") {
      const room = String(data.room || "general");

      if (client.voiceRoom) {
        client.voiceRoom = null;
      }

      client.voiceRoom = room;

      const peers = [];

      for (const other of clients.values()) {
        if (
          other.id !== client.id &&
          other.voiceRoom === room
        ) {
          peers.push({
            id: other.id,
            username: other.username
          });
        }
      }

      send(ws, {
        type: "voice-peers",
        room,
        peers
      });

      broadcast(
        {
          type: "voice-user-joined",
          room,
          user: {
            id: client.id,
            username: client.username
          }
        },
        ws
      );

      return;
    }

    /*
     * --------------------------------------------------------
     * QUITTER LE VOCAL
     * --------------------------------------------------------
     */

    if (data.type === "voice-leave") {
      const room = client.voiceRoom;

      if (!room) return;

      client.voiceRoom = null;

      broadcast({
        type: "voice-user-left",
        room,
        userId: client.id
      });

      return;
    }

    /*
     * --------------------------------------------------------
     * SIGNALISATION WEBRTC
     * --------------------------------------------------------
     */

    if (
      data.type === "webrtc-offer" ||
      data.type === "webrtc-answer" ||
      data.type === "webrtc-ice"
    ) {
      const targetId = String(data.targetId || "");
      const target = clients.get(targetId);

      if (!target) return;

      send(target.ws, {
        ...data,
        senderId: client.id,
        senderName: client.username
      });

      return;
    }
  });

  ws.on("close", () => {
    if (!client) return;

    const oldRoom = client.voiceRoom;

    clients.delete(client.id);

    if (oldRoom) {
      broadcast({
        type: "voice-user-left",
        room: oldRoom,
        userId: client.id
      });
    }

    broadcastUsers();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NovaChat lancé sur le port ${PORT}`);
});