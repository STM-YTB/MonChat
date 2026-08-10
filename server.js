const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// DONNÉES EN MÉMOIRE
// ===============================

const users = new Map();
const servers = new Map();
const messages = new Map();

// Serveur public de départ
servers.set("novalounge", {
  id: "novalounge",
  name: "Nova Lounge",
  ownerId: "system",
  inviteCode: "NOVA-0001",
  members: new Set(),
  channels: [
    { id: "general", name: "général", type: "text" },
    { id: "gaming", name: "gaming", type: "text" },
    { id: "entraide", name: "entraide", type: "text" },
    { id: "voice-general", name: "Salon général", type: "voice" },
    { id: "voice-gaming", name: "Gaming", type: "voice" },
    { id: "voice-chill", name: "Chill", type: "voice" }
  ],
  roles: [
    {
      id: "everyone",
      name: "@everyone",
      permissions: ["read", "send", "voice"]
    }
  ]
});

// ===============================
// OUTILS
// ===============================

function createId(prefix = "") {
  return (
    prefix +
    Math.random().toString(36).substring(2, 10) +
    Date.now().toString(36)
  );
}

function createInviteCode() {
  return (
    Math.random().toString(36).substring(2, 6).toUpperCase() +
    "-" +
    Math.random().toString(36).substring(2, 6).toUpperCase()
  );
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar || null,
    status: user.status || "offline",
    createdAt: user.createdAt
  };
}

function getServer(serverId) {
  return servers.get(serverId);
}

// ===============================
// API
// ===============================

app.get("/api/servers", (req, res) => {
  const result = [];

  for (const s of servers.values()) {
    result.push({
      id: s.id,
      name: s.name,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      memberCount: s.members.size,
      channels: s.channels,
      roles: s.roles
    });
  }

  res.json(result);
});

app.post("/api/users", (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({
      error: "Nom d'utilisateur obligatoire"
    });
  }

  const user = {
    id: createId("user_"),
    username: username.substring(0, 24),
    status: "online",
    createdAt: Date.now(),
    friends: new Set(),
    friendRequests: new Set(),
    servers: new Set()
  };

  users.set(user.id, user);

  res.json(publicUser(user));
});

app.get("/api/users/:id", (req, res) => {
  const user = users.get(req.params.id);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable"
    });
  }

  res.json(publicUser(user));
});

// ===============================
// CRÉER UN SERVEUR
// ===============================

app.post("/api/servers", (req, res) => {
  const { name, ownerId } = req.body;

  if (!name || !ownerId) {
    return res.status(400).json({
      error: "Nom du serveur et propriétaire requis"
    });
  }

  const owner = users.get(ownerId);

  if (!owner) {
    return res.status(404).json({
      error: "Propriétaire introuvable"
    });
  }

  const serverId = createId("server_");

  const newServer = {
    id: serverId,
    name: String(name).substring(0, 50),
    ownerId,
    inviteCode: createInviteCode(),
    members: new Set([ownerId]),
    channels: [
      {
        id: createId("channel_"),
        name: "général",
        type: "text"
      },
      {
        id: createId("channel_"),
        name: "Gaming",
        type: "text"
      },
      {
        id: createId("voice_"),
        name: "Salon vocal",
        type: "voice"
      }
    ],
    roles: [
      {
        id: "everyone",
        name: "@everyone",
        permissions: ["read", "send", "voice"]
      },
      {
        id: "owner",
        name: "Propriétaire",
        permissions: [
          "read",
          "send",
          "voice",
          "manage_server",
          "manage_channels",
          "manage_roles",
          "kick",
          "ban"
        ]
      }
    ]
  };

  servers.set(serverId, newServer);
  owner.servers.add(serverId);

  res.json({
    id: newServer.id,
    name: newServer.name,
    ownerId: newServer.ownerId,
    inviteCode: newServer.inviteCode,
    channels: newServer.channels,
    roles: newServer.roles
  });
});

// ===============================
// REJOINDRE AVEC UNE INVITATION
// ===============================

app.post("/api/servers/join", (req, res) => {
  const { inviteCode, userId } = req.body;

  if (!inviteCode || !userId) {
    return res.status(400).json({
      error: "Code d'invitation et utilisateur requis"
    });
  }

  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable"
    });
  }

  let targetServer = null;

  for (const s of servers.values()) {
    if (s.inviteCode.toUpperCase() === String(inviteCode).toUpperCase()) {
      targetServer = s;
      break;
    }
  }

  if (!targetServer) {
    return res.status(404).json({
      error: "Code d'invitation invalide"
    });
  }

  targetServer.members.add(userId);
  user.servers.add(targetServer.id);

  io.emit("serverMemberJoined", {
    serverId: targetServer.id,
    user: publicUser(user)
  });

  res.json({
    success: true,
    server: {
      id: targetServer.id,
      name: targetServer.name,
      ownerId: targetServer.ownerId,
      inviteCode: targetServer.inviteCode,
      channels: targetServer.channels,
      roles: targetServer.roles
    }
  });
});

// ===============================
// MEMBRES D'UN SERVEUR
// ===============================

app.get("/api/servers/:serverId/members", (req, res) => {
  const s = getServer(req.params.serverId);

  if (!s) {
    return res.status(404).json({
      error: "Serveur introuvable"
    });
  }

  const members = [];

  for (const id of s.members) {
    const user = users.get(id);

    if (user) {
      members.push(publicUser(user));
    }
  }

  res.json(members);
});

// ===============================
// MESSAGES
// ===============================

app.get("/api/messages/:channelId", (req, res) => {
  const list = messages.get(req.params.channelId) || [];

  res.json(list);
});

app.post("/api/messages", (req, res) => {
  const {
    channelId,
    userId,
    content
  } = req.body;

  if (!channelId || !userId || !content) {
    return res.status(400).json({
      error: "Message incomplet"
    });
  }

  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable"
    });
  }

  const message = {
    id: createId("msg_"),
    channelId,
    userId,
    username: user.username,
    content: String(content).substring(0, 2000),
    createdAt: Date.now()
  };

  if (!messages.has(channelId)) {
    messages.set(channelId, []);
  }

  messages.get(channelId).push(message);

  io.emit("newMessage", message);

  res.json(message);
});

// ===============================
// MESSAGES PRIVÉS
// ===============================

const privateMessages = new Map();

function dmKey(a, b) {
  return [a, b].sort().join(":");
}

app.get("/api/dm/:userA/:userB", (req, res) => {
  const key = dmKey(req.params.userA, req.params.userB);

  res.json(privateMessages.get(key) || []);
});

app.post("/api/dm", (req, res) => {
  const {
    from,
    to,
    content
  } = req.body;

  if (!from || !to || !content) {
    return res.status(400).json({
      error: "Message privé incomplet"
    });
  }

  if (!users.has(from) || !users.has(to)) {
    return res.status(404).json({
      error: "Utilisateur introuvable"
    });
  }

  const message = {
    id: createId("dm_"),
    from,
    to,
    content: String(content).substring(0, 2000),
    createdAt: Date.now()
  };

  const key = dmKey(from, to);

  if (!privateMessages.has(key)) {
    privateMessages.set(key, []);
  }

  privateMessages.get(key).push(message);

  io.to(`user:${to}`).emit("privateMessage", message);
  io.to(`user:${from}`).emit("privateMessage", message);

  res.json(message);
});

// ===============================
// SOCKET.IO
// ===============================

io.on("connection", (socket) => {
  console.log("Connexion :", socket.id);

  // -----------------------------
  // UTILISATEUR
  // -----------------------------

  socket.on("register", (userId) => {
    const user = users.get(userId);

    if (!user) return;

    user.status = "online";
    user.socketId = socket.id;

    socket.userId = userId;
    socket.join(`user:${userId}`);

    io.emit("userStatus", {
      userId,
      status: "online"
    });

    console.log(`${user.username} est en ligne`);
  });

  // -----------------------------
  // SERVEUR
  // -----------------------------

  socket.on("joinServer", (serverId) => {
    const s = servers.get(serverId);

    if (!s || !socket.userId) return;

    if (!s.members.has(socket.userId)) return;

    socket.join(`server:${serverId}`);

    socket.emit("serverJoined", {
      serverId
    });
  });

  // -----------------------------
  // VOCAL
  // -----------------------------

  socket.on("joinVoice", ({ serverId, roomId }) => {
    if (!socket.userId) return;

    const s = servers.get(serverId);

    if (!s || !s.members.has(socket.userId)) {
      return;
    }

    const room = `voice:${serverId}:${roomId}`;

    // Quitter un ancien vocal
    if (socket.voiceRoom) {
      socket.leave(socket.voiceRoom);

      socket.to(socket.voiceRoom).emit("voiceUserLeft", {
        userId: socket.userId
      });
    }

    socket.join(room);
    socket.voiceRoom = room;
    socket.voiceServerId = serverId;
    socket.voiceRoomId = roomId;

    const clients = [];

    const roomSockets = io.sockets.adapter.rooms.get(room);

    if (roomSockets) {
      for (const socketId of roomSockets) {
        if (socketId === socket.id) continue;

        const otherSocket = io.sockets.sockets.get(socketId);

        if (otherSocket && otherSocket.userId) {
          clients.push(otherSocket.userId);
        }
      }
    }

    // On donne au nouveau la liste des personnes déjà présentes
    socket.emit("voiceUsers", {
      roomId,
      users: clients
    });

    // Les autres doivent créer une connexion WebRTC
    socket.to(room).emit("voiceUserJoined", {
      userId: socket.userId
    });

    console.log(
      `Utilisateur ${socket.userId} rejoint le vocal ${room}`
    );
  });

  // -----------------------------
  // WEBRTC SIGNALING
  // -----------------------------

  socket.on("webrtcOffer", ({ target, offer }) => {
    if (!target || !offer) return;

    io.to(`user:${target}`).emit("webrtcOffer", {
      from: socket.userId,
      offer
    });
  });

  socket.on("webrtcAnswer", ({ target, answer }) => {
    if (!target || !answer) return;

    io.to(`user:${target}`).emit("webrtcAnswer", {
      from: socket.userId,
      answer
    });
  });

  socket.on("webrtcIceCandidate", ({ target, candidate }) => {
    if (!target || !candidate) return;

    io.to(`user:${target}`).emit("webrtcIceCandidate", {
      from: socket.userId,
      candidate
    });
  });

  // -----------------------------
  // QUITTER LE VOCAL
  // -----------------------------

  socket.on("leaveVoice", () => {
    if (!socket.voiceRoom) return;

    const room = socket.voiceRoom;

    socket.leave(room);

    socket.to(room).emit("voiceUserLeft", {
      userId: socket.userId
    });

    socket.voiceRoom = null;
    socket.voiceServerId = null;
    socket.voiceRoomId = null;
  });

  // -----------------------------
  // DÉCONNEXION
  // -----------------------------

  socket.on("disconnect", () => {
    console.log("Déconnexion :", socket.id);

    if (socket.voiceRoom) {
      socket.to(socket.voiceRoom).emit("voiceUserLeft", {
        userId: socket.userId
      });
    }

    if (socket.userId) {
      const user = users.get(socket.userId);

      if (user && user.socketId === socket.id) {
        user.status = "offline";
        user.socketId = null;

        io.emit("userStatus", {
          userId: socket.userId,
          status: "offline"
        });
      }
    }
  });
});

// ===============================
// FALLBACK POUR LE SITE
// ===============================

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===============================
// DÉMARRAGE
// ===============================

server.listen(PORT, () => {
  console.log("");
  console.log("================================");
  console.log("       NOVACHAT SERVEUR");
  console.log("================================");
  console.log(`Serveur lancé sur le port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
  console.log("================================");
  console.log("");
});