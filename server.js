const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultDatabase = {
  users: [],
  servers: [],
  messages: [],
  friendRequests: []
};

let db = loadDatabase();

function loadDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify(defaultDatabase, null, 2),
        "utf8"
      );
      return JSON.parse(JSON.stringify(defaultDatabase));
    }

    const content = fs.readFileSync(DB_FILE, "utf8");

    if (!content.trim()) {
      return JSON.parse(JSON.stringify(defaultDatabase));
    }

    const parsed = JSON.parse(content);

    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      friendRequests: Array.isArray(parsed.friendRequests)
        ? parsed.friendRequests
        : []
    };
  } catch (error) {
    console.error("Erreur lecture database:", error);
    return JSON.parse(JSON.stringify(defaultDatabase));
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (error) {
    console.error("Erreur sauvegarde database:", error);
  }
}

function id(prefix = "") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = stored.split(":");

    if (parts.length !== 2) return false;

    const salt = parts[0];
    const originalHash = parts[1];

    const hash = crypto
      .pbkdf2Sync(password, salt, 100000, 64, "sha512")
      .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(originalHash, "hex")
    );
  } catch {
    return false;
  }
}

function cleanUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || "",
    friends: user.friends || []
  };
}

function findUser(identifier) {
  const value = String(identifier || "").trim().toLowerCase();

  return db.users.find(
    user =>
      user.id === identifier ||
      user.username.toLowerCase() === value ||
      user.email.toLowerCase() === value
  );
}

function createDefaultServer(ownerId, name) {
  const serverId = id("srv_");

  return {
    id: serverId,
    name,
    icon: "",
    ownerId,
    members: [ownerId],
    roles: [
      {
        id: "role_everyone",
        name: "@everyone",
        color: "#ffffff",
        permissions: ["view", "message", "voice"]
      },
      {
        id: "role_admin",
        name: "Administrateur",
        color: "#ff4757",
        permissions: ["all"]
      }
    ],
    channels: [
      {
        id: id("chn_"),
        name: "general",
        type: "text",
        position: 0
      },
      {
        id: id("chn_"),
        name: "general",
        type: "voice",
        position: 1
      }
    ],
    invites: [],
    emojis: [],
    stickers: [],
    soundboard: [],
    logs: [],
    bans: []
  };
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "NovaChat",
    time: new Date().toISOString()
  });
});

app.post("/api/register", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const displayName =
      String(req.body.displayName || username).trim() || username;

    if (!email || !username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Tous les champs obligatoires doivent être remplis."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Le mot de passe doit contenir au moins 6 caractères."
      });
    }

    if (db.users.some(u => u.email.toLowerCase() === email)) {
      return res.status(409).json({
        ok: false,
        error: "Cette adresse email est déjà utilisée."
      });
    }

    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({
        ok: false,
        error: "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    const user = {
      id: id("usr_"),
      email,
      username,
      displayName,
      password: hashPassword(password),
      avatar: "",
      friends: [],
      createdAt: Date.now()
    };

    db.users.push(user);

    const serverDefault = createDefaultServer(user.id, `${displayName}'s Server`);
    db.servers.push(serverDefault);

    saveDatabase();

    res.json({
      ok: true,
      user: cleanUser(user),
      servers: db.servers.filter(s => s.members.includes(user.id))
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Une erreur est survenue pendant la création du compte."
    });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const identifier = String(req.body.identifier || "").trim();
    const password = String(req.body.password || "");

    const user = findUser(identifier);

    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({
        ok: false,
        error: "Identifiants incorrects."
      });
    }

    res.json({
      ok: true,
      user: cleanUser(user),
      servers: db.servers.filter(s => s.members.includes(user.id))
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Erreur pendant la connexion."
    });
  }
});

app.get("/api/user/:userId", (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  res.json({
    ok: true,
    user: cleanUser(user)
  });
});

app.get("/api/friends/:userId", (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  const friends = (user.friends || [])
    .map(friendId => db.users.find(u => u.id === friendId))
    .filter(Boolean)
    .map(cleanUser);

  const requests = db.friendRequests
    .filter(
      r =>
        (r.from === user.id || r.to === user.id) &&
        r.status === "pending"
    )
    .map(r => ({
      ...r,
      fromUser: cleanUser(db.users.find(u => u.id === r.from)),
      toUser: cleanUser(db.users.find(u => u.id === r.to))
    }));

  res.json({
    ok: true,
    friends,
    requests
  });
});

app.post("/api/friends/request", (req, res) => {
  const from = String(req.body.from || "");
  const target = String(req.body.target || "").trim();

  const sender = db.users.find(u => u.id === from);
  const receiver = findUser(target);

  if (!sender || !receiver) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  if (sender.id === receiver.id) {
    return res.status(400).json({
      ok: false,
      error: "Tu ne peux pas t'ajouter toi-même."
    });
  }

  if ((sender.friends || []).includes(receiver.id)) {
    return res.status(400).json({
      ok: false,
      error: "Cette personne est déjà dans tes amis."
    });
  }

  const alreadyPending = db.friendRequests.some(
    r =>
      r.status === "pending" &&
      ((r.from === sender.id && r.to === receiver.id) ||
        (r.from === receiver.id && r.to === sender.id))
  );

  if (alreadyPending) {
    return res.status(400).json({
      ok: false,
      error: "Une demande est déjà en attente."
    });
  }

  const request = {
    id: id("req_"),
    from: sender.id,
    to: receiver.id,
    status: "pending",
    createdAt: Date.now()
  };

  db.friendRequests.push(request);
  saveDatabase();

  io.to(`user:${receiver.id}`).emit("friend_request", {
    request,
    from: cleanUser(sender)
  });

  res.json({
    ok: true,
    request
  });
});

app.post("/api/friends/respond", (req, res) => {
  const userId = String(req.body.userId || "");
  const requestId = String(req.body.requestId || "");
  const action = String(req.body.action || "");

  const request = db.friendRequests.find(
    r => r.id === requestId && r.to === userId && r.status === "pending"
  );

  if (!request) {
    return res.status(404).json({
      ok: false,
      error: "Demande introuvable."
    });
  }

  if (action === "accept") {
    const user = db.users.find(u => u.id === userId);
    const sender = db.users.find(u => u.id === request.from);

    if (!user || !sender) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    user.friends = Array.isArray(user.friends) ? user.friends : [];
    sender.friends = Array.isArray(sender.friends) ? sender.friends : [];

    if (!user.friends.includes(sender.id)) user.friends.push(sender.id);
    if (!sender.friends.includes(user.id)) sender.friends.push(user.id);

    request.status = "accepted";

    saveDatabase();

    io.to(`user:${sender.id}`).emit("friend_accepted", {
      user: cleanUser(user)
    });

    io.to(`user:${user.id}`).emit("friend_accepted", {
      user: cleanUser(sender)
    });
  } else if (action === "decline") {
    request.status = "declined";
    saveDatabase();
  } else {
    return res.status(400).json({
      ok: false,
      error: "Action invalide."
    });
  }

  res.json({
    ok: true
  });
});

app.get("/api/servers/:userId", (req, res) => {
  const servers = db.servers.filter(s =>
    s.members.includes(req.params.userId)
  );

  res.json({
    ok: true,
    servers
  });
});

app.post("/api/servers", (req, res) => {
  const ownerId = String(req.body.ownerId || "");
  const name = String(req.body.name || "").trim();
  const icon = String(req.body.icon || "");

  const owner = db.users.find(u => u.id === ownerId);

  if (!owner) {
    return res.status(404).json({
      ok: false,
      error: "Propriétaire introuvable."
    });
  }

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Le nom du serveur est obligatoire."
    });
  }

  const serverData = createDefaultServer(ownerId, name);
  serverData.icon = icon;

  db.servers.push(serverData);
  saveDatabase();

  res.json({
    ok: true,
    server: serverData
  });
});

app.get("/api/servers/detail/:serverId", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  const members = serverData.members
    .map(memberId => db.users.find(u => u.id === memberId))
    .filter(Boolean)
    .map(cleanUser);

  res.json({
    ok: true,
    server: serverData,
    members
  });
});

app.post("/api/servers/:serverId/join", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);
  const userId = String(req.body.userId || "");

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  if (!db.users.some(u => u.id === userId)) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  if (!serverData.members.includes(userId)) {
    serverData.members.push(userId);
    saveDatabase();
  }

  res.json({
    ok: true,
    server: serverData
  });
});

app.patch("/api/servers/:serverId", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);
  const userId = String(req.body.userId || "");

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  if (serverData.ownerId !== userId) {
    return res.status(403).json({
      ok: false,
      error: "Seul le propriétaire peut modifier ce serveur."
    });
  }

  if (typeof req.body.name === "string" && req.body.name.trim()) {
    serverData.name = req.body.name.trim();
  }

  if (typeof req.body.icon === "string") {
    serverData.icon = req.body.icon;
  }

  saveDatabase();

  io.to(`server:${serverData.id}`).emit("server_updated", serverData);

  res.json({
    ok: true,
    server: serverData
  });
});

app.post("/api/servers/:serverId/channels", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);
  const userId = String(req.body.userId || "");
  const name = String(req.body.name || "").trim();
  const type = req.body.type === "voice" ? "voice" : "text";

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  if (serverData.ownerId !== userId) {
    return res.status(403).json({
      ok: false,
      error: "Permission refusée."
    });
  }

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Nom du salon obligatoire."
    });
  }

  const channel = {
    id: id("chn_"),
    name,
    type,
    position: serverData.channels.length
  };

  serverData.channels.push(channel);

  saveDatabase();

  res.json({
    ok: true,
    channel
  });
});

app.delete("/api/servers/:serverId/channels/:channelId", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);
  const userId = String(req.body.userId || "");

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  if (serverData.ownerId !== userId) {
    return res.status(403).json({
      ok: false,
      error: "Permission refusée."
    });
  }

  serverData.channels = serverData.channels.filter(
    c => c.id !== req.params.channelId
  );

  saveDatabase();

  res.json({
    ok: true
  });
});

app.post("/api/servers/:serverId/invites", (req, res) => {
  const serverData = db.servers.find(s => s.id === req.params.serverId);
  const userId = String(req.body.userId || "");

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  if (!serverData.members.includes(userId)) {
    return res.status(403).json({
      ok: false,
      error: "Tu n'es pas membre de ce serveur."
    });
  }

  const code = crypto.randomBytes(5).toString("hex");

  const invite = {
    code,
    serverId: serverData.id,
    createdBy: userId,
    createdAt: Date.now()
  };

  serverData.invites.push(invite);
  saveDatabase();

  res.json({
    ok: true,
    invite
  });
});

app.post("/api/invites/:code/join", (req, res) => {
  const userId = String(req.body.userId || "");

  let serverData = null;

  for (const currentServer of db.servers) {
    if (currentServer.invites.some(i => i.code === req.params.code)) {
      serverData = currentServer;
      break;
    }
  }

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Invitation invalide."
    });
  }

  if (!serverData.members.includes(userId)) {
    serverData.members.push(userId);
  }

  saveDatabase();

  res.json({
    ok: true,
    server: serverData
  });
});

app.get("/api/messages/:userId/:friendId", (req, res) => {
  const messages = db.messages.filter(
    message =>
      (message.from === req.params.userId &&
        message.to === req.params.friendId) ||
      (message.from === req.params.friendId &&
        message.to === req.params.userId)
  );

  res.json({
    ok: true,
    messages
  });
});

app.post("/api/messages", (req, res) => {
  const from = String(req.body.from || "");
  const to = String(req.body.to || "");
  const content = String(req.body.content || "").trim();

  if (!from || !to || !content) {
    return res.status(400).json({
      ok: false,
      error: "Message invalide."
    });
  }

  const sender = db.users.find(u => u.id === from);
  const receiver = db.users.find(u => u.id === to);

  if (!sender || !receiver) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable."
    });
  }

  const message = {
    id: id("msg_"),
    from,
    to,
    content,
    createdAt: Date.now()
  };

  db.messages.push(message);
  saveDatabase();

  io.to(`user:${to}`).emit("private_message", message);

  res.json({
    ok: true,
    message
  });
});

app.delete("/api/servers/:serverId", (req, res) => {
  const userId = String(req.body.userId || "");

  const index = db.servers.findIndex(
    s => s.id === req.params.serverId
  );

  if (index === -1) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  const serverData = db.servers[index];

  if (serverData.ownerId !== userId) {
    return res.status(403).json({
      ok: false,
      error: "Seul le propriétaire peut supprimer le serveur."
    });
  }

  db.servers.splice(index, 1);
  saveDatabase();

  io.to(`server:${serverData.id}`).emit("server_deleted", {
    serverId: serverData.id
  });

  res.json({
    ok: true
  });
});

io.on("connection", socket => {
  socket.on("identify", userId => {
    if (!userId) return;

    socket.userId = userId;
    socket.join(`user:${userId}`);
  });

  socket.on("join_server", serverId => {
    if (serverId) {
      socket.join(`server:${serverId}`);
    }
  });

  socket.on("leave_server", serverId => {
    if (serverId) {
      socket.leave(`server:${serverId}`);
    }
  });

  socket.on("join_voice", data => {
    const serverId = String(data?.serverId || "");
    const channelId = String(data?.channelId || "");

    if (!serverId || !channelId || !socket.userId) return;

    socket.join(`voice:${channelId}`);

    socket.voiceChannelId = channelId;

    socket.to(`voice:${channelId}`).emit("voice_user_joined", {
      userId: socket.userId,
      socketId: socket.id
    });
  });

  socket.on("leave_voice", () => {
    if (!socket.voiceChannelId) return;

    const room = `voice:${socket.voiceChannelId}`;

    socket.to(room).emit("voice_user_left", {
      userId: socket.userId,
      socketId: socket.id
    });

    socket.leave(room);
    socket.voiceChannelId = null;
  });

  socket.on("voice_offer", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("voice_offer", {
      fromSocketId: socket.id,
      offer: data.offer
    });
  });

  socket.on("voice_answer", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("voice_answer", {
      fromSocketId: socket.id,
      answer: data.answer
    });
  });

  socket.on("voice_ice_candidate", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("voice_ice_candidate", {
      fromSocketId: socket.id,
      candidate: data.candidate
    });
  });

  socket.on("private_call_invite", data => {
    const target = String(data?.targetUserId || "");

    if (!target || !socket.userId) return;

    io.to(`user:${target}`).emit("private_call_incoming", {
      fromUserId: socket.userId,
      fromSocketId: socket.id,
      callId: data.callId,
      callType: data.callType || "audio"
    });
  });

  socket.on("private_call_accept", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("private_call_accepted", {
      fromSocketId: socket.id,
      callId: data.callId
    });
  });

  socket.on("private_call_reject", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("private_call_rejected", {
      callId: data.callId
    });
  });

  socket.on("private_call_end", data => {
    if (!data?.targetSocketId) return;

    io.to(data.targetSocketId).emit("private_call_ended", {
      callId: data.callId
    });
  });

  socket.on("disconnect", () => {
    if (socket.voiceChannelId) {
      socket.to(`voice:${socket.voiceChannelId}`).emit("voice_user_left", {
        userId: socket.userId,
        socketId: socket.id
      });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NovaChat lancé sur le port ${PORT}`);
});