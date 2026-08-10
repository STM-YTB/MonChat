const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "database.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultDatabase = {
  users: [],
  servers: [],
  messages: [],
  friendships: []
};

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(defaultDatabase, null, 2),
        "utf8"
      );
      return JSON.parse(JSON.stringify(defaultDatabase));
    }

    const content = fs.readFileSync(DATA_FILE, "utf8");

    if (!content.trim()) {
      return JSON.parse(JSON.stringify(defaultDatabase));
    }

    const database = JSON.parse(content);

    database.users = Array.isArray(database.users) ? database.users : [];
    database.servers = Array.isArray(database.servers) ? database.servers : [];
    database.messages = Array.isArray(database.messages)
      ? database.messages
      : [];
    database.friendships = Array.isArray(database.friendships)
      ? database.friendships
      : [];

    return database;
  } catch (error) {
    console.error("Erreur lecture database:", error);
    return JSON.parse(JSON.stringify(defaultDatabase));
  }
}

let db = loadDatabase();

function saveDatabase() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (error) {
    console.error("Erreur sauvegarde database:", error);
  }
}

function id() {
  return crypto.randomUUID();
}

function cleanText(value, max = 1000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, max);
}

function normalizeUsername(username) {
  return cleanText(username, 32).toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .pbkdf2Sync(
      String(password),
      salt,
      100000,
      64,
      "sha512"
    )
    .toString("hex");

  return salt + ":" + hash;
}

function verifyPassword(password, storedPassword) {
  try {
    const parts = String(storedPassword).split(":");

    if (parts.length !== 2) {
      return false;
    }

    const salt = parts[0];
    const originalHash = parts[1];

    const hash = crypto
      .pbkdf2Sync(
        String(password),
        salt,
        100000,
        64,
        "sha512"
      )
      .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(originalHash, "hex")
    );
  } catch {
    return false;
  }
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || "",
    createdAt: user.createdAt
  };
}

function findUserById(userId) {
  return db.users.find((user) => user.id === userId);
}

function findUserByUsername(username) {
  const normalized = normalizeUsername(username);

  return db.users.find(
    (user) => normalizeUsername(user.username) === normalized
  );
}

function getServerForUser(serverId, userId) {
  return db.servers.find(
    (server) =>
      server.id === serverId &&
      Array.isArray(server.members) &&
      server.members.includes(userId)
  );
}

function getFriends(userId) {
  const friendships = db.friendships.filter(
    (friendship) =>
      friendship.status === "accepted" &&
      (friendship.user1 === userId || friendship.user2 === userId)
  );

  return friendships
    .map((friendship) => {
      const friendId =
        friendship.user1 === userId
          ? friendship.user2
          : friendship.user1;

      return publicUser(findUserById(friendId));
    })
    .filter(Boolean);
}

function friendshipExists(user1, user2) {
  return db.friendships.some(
    (friendship) =>
      (friendship.user1 === user1 && friendship.user2 === user2) ||
      (friendship.user1 === user2 && friendship.user2 === user1)
  );
}

function serverPublic(serverData) {
  return {
    id: serverData.id,
    name: serverData.name,
    icon: serverData.icon || "",
    ownerId: serverData.ownerId,
    members: serverData.members || [],
    channels: serverData.channels || [],
    createdAt: serverData.createdAt
  };
}

function makeDefaultChannels() {
  return [
    {
      id: id(),
      name: "general",
      type: "text",
      position: 0
    },
    {
      id: id(),
      name: "general",
      type: "voice",
      position: 1
    }
  ];
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    name: "NovaChat",
    version: "1.0.0"
  });
});

/*
==================================================
AUTHENTIFICATION
==================================================
*/

app.post("/api/register", (req, res) => {
  try {
    const email = cleanText(req.body.email, 150).toLowerCase();
    const username = cleanText(req.body.username, 32);
    const displayName =
      cleanText(req.body.displayName, 50) || username;
    const password = String(req.body.password || "");

    if (!email || !username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Tous les champs sont obligatoires."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Le mot de passe doit contenir au moins 6 caractères."
      });
    }

    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return res.status(400).json({
        ok: false,
        error:
          "Le nom d'utilisateur peut seulement contenir des lettres, chiffres, _, . et -."
      });
    }

    const emailExists = db.users.some(
      (user) => user.email.toLowerCase() === email
    );

    if (emailExists) {
      return res.status(409).json({
        ok: false,
        error: "Cette adresse email est déjà utilisée."
      });
    }

    if (findUserByUsername(username)) {
      return res.status(409).json({
        ok: false,
        error: "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    const user = {
      id: id(),
      email,
      username,
      displayName,
      password: hashPassword(password),
      avatar: "",
      createdAt: Date.now(),
      lastUsernameChange: Date.now()
    };

    db.users.push(user);
    saveDatabase();

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Une erreur est survenue lors de la création du compte."
    });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const login = cleanText(req.body.login, 150);
    const password = String(req.body.password || "");

    const user = db.users.find(
      (item) =>
        item.email.toLowerCase() === login.toLowerCase() ||
        normalizeUsername(item.username) === normalizeUsername(login)
    );

    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({
        ok: false,
        error: "Identifiants incorrects."
      });
    }

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible de se connecter."
    });
  }
});

/*
==================================================
PROFIL
==================================================
*/

app.post("/api/profile", (req, res) => {
  try {
    const userId = cleanText(req.body.userId, 100);
    const user = findUserById(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    if (typeof req.body.displayName === "string") {
      const displayName = cleanText(req.body.displayName, 50);

      if (displayName) {
        user.displayName = displayName;
      }
    }

    if (typeof req.body.avatar === "string") {
      if (req.body.avatar.length > 2_000_000) {
        return res.status(400).json({
          ok: false,
          error: "Image trop volumineuse."
        });
      }

      user.avatar = req.body.avatar;
    }

    saveDatabase();

    io.emit("user_updated", publicUser(user));

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("PROFILE ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible de modifier le profil."
    });
  }
});

app.post("/api/username", (req, res) => {
  try {
    const userId = cleanText(req.body.userId, 100);
    const newUsername = cleanText(req.body.username, 32);

    const user = findUserById(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    if (!/^[a-zA-Z0-9_.-]+$/.test(newUsername)) {
      return res.status(400).json({
        ok: false,
        error: "Nom d'utilisateur invalide."
      });
    }

    const existing = findUserByUsername(newUsername);

    if (existing && existing.id !== user.id) {
      return res.status(409).json({
        ok: false,
        error: "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    if (
      user.lastUsernameChange &&
      now - user.lastUsernameChange < TWO_WEEKS
    ) {
      const remaining =
        TWO_WEEKS - (now - user.lastUsernameChange);

      const days = Math.ceil(
        remaining / (24 * 60 * 60 * 1000)
      );

      return res.status(429).json({
        ok: false,
        error:
          "Tu dois attendre encore environ " +
          days +
          " jour(s) avant de changer ton nom d'utilisateur."
      });
    }

    user.username = newUsername;
    user.lastUsernameChange = now;

    saveDatabase();

    io.emit("user_updated", publicUser(user));

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("USERNAME ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible de modifier le nom d'utilisateur."
    });
  }
});

/*
==================================================
UTILISATEURS / AMIS
==================================================
*/

app.get("/api/users/search", (req, res) => {
  const query = cleanText(req.query.q, 50);

  if (!query) {
    return res.json({
      ok: true,
      users: []
    });
  }

  const normalized = query.toLowerCase();

  const users = db.users
    .filter(
      (user) =>
        user.username.toLowerCase().includes(normalized) ||
        user.displayName.toLowerCase().includes(normalized)
    )
    .slice(0, 20)
    .map(publicUser);

  res.json({
    ok: true,
    users
  });
});

app.get("/api/friends/:userId", (req, res) => {
  const user = findUserById(req.params.userId);

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
  try {
    const userId = cleanText(req.body.userId, 100);
    const username = cleanText(req.body.username, 32);

    const user = findUserById(userId);
    const target = findUserByUsername(username);

    if (!user || !target) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    if (user.id === target.id) {
      return res.status(400).json({
        ok: false,
        error: "Tu ne peux pas t'ajouter toi-même."
      });
    }

    if (friendshipExists(user.id, target.id)) {
      return res.status(409).json({
        ok: false,
        error: "Vous êtes déjà amis ou une demande existe déjà."
      });
    }

    const friendship = {
      id: id(),
      user1: user.id,
      user2: target.id,
      status: "accepted",
      createdAt: Date.now()
    };

    db.friendships.push(friendship);
    saveDatabase();

    io.emit("friend_added", {
      userId: user.id,
      friendId: target.id
    });

    res.json({
      ok: true,
      friend: publicUser(target)
    });
  } catch (error) {
    console.error("FRIEND ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible d'ajouter cet ami."
    });
  }
});

/*
==================================================
MESSAGERIE PRIVÉE
==================================================
*/

app.get("/api/dm/:userId/:friendId", (req, res) => {
  const userId = req.params.userId;
  const friendId = req.params.friendId;

  const messages = db.messages
    .filter(
      (message) =>
        message.type === "dm" &&
        (
          (message.from === userId && message.to === friendId) ||
          (message.from === friendId && message.to === userId)
        )
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);

  res.json({
    ok: true,
    messages
  });
});

/*
==================================================
SERVEURS
==================================================
*/

app.get("/api/servers/:userId", (req, res) => {
  const userId = req.params.userId;

  const servers = db.servers
    .filter(
      (serverData) =>
        Array.isArray(serverData.members) &&
        serverData.members.includes(userId)
    )
    .map(serverPublic);

  res.json({
    ok: true,
    servers
  });
});

app.post("/api/servers", (req, res) => {
  try {
    const ownerId = cleanText(req.body.ownerId, 100);
    const name = cleanText(req.body.name, 80);

    const owner = findUserById(ownerId);

    if (!owner) {
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable."
      });
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Le nom du serveur est obligatoire."
      });
    }

    const serverData = {
      id: id(),
      name,
      icon: typeof req.body.icon === "string"
        ? req.body.icon.slice(0, 500000)
        : "",
      ownerId: owner.id,
      members: [owner.id],
      channels: makeDefaultChannels(),
      createdAt: Date.now()
    };

    db.servers.push(serverData);
    saveDatabase();

    io.emit("server_created", serverPublic(serverData));

    res.json({
      ok: true,
      server: serverPublic(serverData)
    });
  } catch (error) {
    console.error("SERVER CREATE ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible de créer le serveur."
    });
  }
});

app.post("/api/servers/join", (req, res) => {
  try {
    const userId = cleanText(req.body.userId, 100);
    const serverId = cleanText(req.body.serverId, 100);

    const user = findUserById(userId);
    const serverData = db.servers.find(
      (item) => item.id === serverId
    );

    if (!user || !serverData) {
      return res.status(404).json({
        ok: false,
        error: "Serveur ou utilisateur introuvable."
      });
    }

    if (!serverData.members.includes(user.id)) {
      serverData.members.push(user.id);
      saveDatabase();
    }

    io.to("server:" + serverData.id).emit(
      "server_member_joined",
      {
        serverId: serverData.id,
        user: publicUser(user)
      }
    );

    res.json({
      ok: true,
      server: serverPublic(serverData)
    });
  } catch (error) {
    console.error("SERVER JOIN ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Impossible de rejoindre le serveur."
    });
  }
});

app.get("/api/servers/:serverId/details", (req, res) => {
  const serverData = db.servers.find(
    (item) => item.id === req.params.serverId
  );

  if (!serverData) {
    return res.status(404).json({
      ok: false,
      error: "Serveur introuvable."
    });
  }

  res.json({
    ok: true,
    server: serverPublic(serverData)
  });
});

/*
==================================================
MESSAGES DANS LES SALONS
==================================================
*/

app.get("/api/channels/:channelId/messages", (req, res) => {
  const channelId = req.params.channelId;

  const messages = db.messages
    .filter(
      (message) =>
        message.type === "channel" &&
        message.channelId === channelId
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);

  res.json({
    ok: true,
    messages
  });
});

/*
==================================================
SOCKET.IO
==================================================
*/

const connectedUsers = new Map();

function getSocketUser(socket) {
  const userId = connectedUsers.get(socket.id);

  if (!userId) {
    return null;
  }

  return findUserById(userId);
}

io.on("connection", (socket) => {
  console.log("Connexion Socket.IO:", socket.id);

  socket.on("identify", (userId) => {
    const user = findUserById(userId);

    if (!user) {
      return;
    }

    connectedUsers.set(socket.id, user.id);

    socket.data.userId = user.id;

    socket.emit("identified", {
      user: publicUser(user)
    });

    io.emit("presence", {
      userId: user.id,
      online: true
    });
  });

  /*
  -------------------------
  DM
  -------------------------
  */

  socket.on("dm_send", (data) => {
    const user = getSocketUser(socket);

    if (!user) {
      return;
    }

    const to = cleanText(data && data.to, 100);
    const content = cleanText(data && data.content, 4000);

    if (!to || !content) {
      return;
    }

    const target = findUserById(to);

    if (!target) {
      return;
    }

    const message = {
      id: id(),
      type: "dm",
      from: user.id,
      to: target.id,
      content,
      createdAt: Date.now()
    };

    db.messages.push(message);
    saveDatabase();

    io.emit("dm_message", message);
  });

  /*
  -------------------------
  Salons texte
  -------------------------
  */

  socket.on("channel_send", (data) => {
    const user = getSocketUser(socket);

    if (!user) {
      return;
    }

    const serverId = cleanText(data && data.serverId, 100);
    const channelId = cleanText(data && data.channelId, 100);
    const content = cleanText(data && data.content, 4000);

    if (!serverId || !channelId || !content) {
      return;
    }

    const serverData = getServerForUser(serverId, user.id);

    if (!serverData) {
      return;
    }

    const channel = serverData.channels.find(
      (item) => item.id === channelId && item.type === "text"
    );

    if (!channel) {
      return;
    }

    const message = {
      id: id(),
      type: "channel",
      serverId,
      channelId,
      from: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar || "",
      content,
      createdAt: Date.now()
    };

    db.messages.push(message);
    saveDatabase();

    io.to("server:" + serverId).emit(
      "channel_message",
      message
    );
  });

  /*
  -------------------------
  Rejoindre un serveur
  -------------------------
  */

  socket.on("server_join", (serverId) => {
    const user = getSocketUser(socket);

    if (!user) {
      return;
    }

    const serverData = getServerForUser(serverId, user.id);

    if (!serverData) {
      return;
    }

    socket.join("server:" + serverId);

    socket.emit("server_joined", {
      server: serverPublic(serverData)
    });
  });

  /*
  -------------------------
  Salon vocal
  -------------------------
  */

  socket.on("voice_join", (data) => {
    const user = getSocketUser(socket);

    if (!user) {
      return;
    }

    const serverId = cleanText(data && data.serverId, 100);
    const channelId = cleanText(data && data.channelId, 100);

    const serverData = getServerForUser(serverId, user.id);

    if (!serverData) {
      return;
    }

    const channel = serverData.channels.find(
      (item) =>
        item.id === channelId &&
        item.type === "voice"
    );

    if (!channel) {
      return;
    }

    socket.join("voice:" + channelId);

    socket.data.voiceChannelId = channelId;
    socket.data.voiceServerId = serverId;

    socket.to("voice:" + channelId).emit(
      "voice_user_joined",
      {
        socketId: socket.id,
        user: publicUser(user)
      }
    );

    const room = io.sockets.adapter.rooms.get(
      "voice:" + channelId
    );

    const users = [];

    if (room) {
      for (const socketId of room) {
        const roomSocket = io.sockets.sockets.get(socketId);

        if (!roomSocket || !roomSocket.data.userId) {
          continue;
        }

        const roomUser = findUserById(
          roomSocket.data.userId
        );

        if (roomUser) {
          users.push({
            socketId,
            user: publicUser(roomUser)
          });
        }
      }
    }

    socket.emit("voice_users", {
      channelId,
      users
    });

    io.to("server:" + serverId).emit(
      "voice_presence",
      {
        channelId,
        user: publicUser(user),
        joined: true
      }
    );
  });

  socket.on("voice_leave", () => {
    leaveVoice(socket);
  });

  /*
  -------------------------
  WebRTC SIGNALING
  -------------------------
  */

  socket.on("webrtc_offer", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("webrtc_offer", {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on("webrtc_answer", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("webrtc_answer", {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on("webrtc_ice", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("webrtc_ice", {
      from: socket.id,
      candidate: data.candidate
    });
  });

  /*
  -------------------------
  Appel privé
  -------------------------
  */

  socket.on("call_user", (data) => {
    const user = getSocketUser(socket);

    if (!user || !data || !data.targetUserId) {
      return;
    }

    const targetUserId = data.targetUserId;

    for (const [
      socketId,
      connectedUserId
    ] of connectedUsers.entries()) {
      if (connectedUserId === targetUserId) {
        io.to(socketId).emit("incoming_call", {
          fromSocketId: socket.id,
          fromUser: publicUser(user),
          callType: data.callType || "audio"
        });
      }
    }
  });

  socket.on("call_accept", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("call_accepted", {
      from: socket.id
    });
  });

  socket.on("call_reject", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("call_rejected", {
      from: socket.id
    });
  });

  socket.on("call_end", (data) => {
    if (!data || !data.target) {
      return;
    }

    io.to(data.target).emit("call_ended", {
      from: socket.id
    });
  });

  /*
  -------------------------
  Déconnexion
  -------------------------
  */

  socket.on("disconnect", () => {
    const userId = connectedUsers.get(socket.id);
    const user = findUserById(userId);

    leaveVoice(socket);

    connectedUsers.delete(socket.id);

    if (user) {
      io.emit("presence", {
        userId: user.id,
        online: false
      });
    }

    console.log("Déconnexion Socket.IO:", socket.id);
  });
});

function leaveVoice(socket) {
  const channelId = socket.data.voiceChannelId;
  const serverId = socket.data.voiceServerId;

  if (!channelId) {
    return;
  }

  const user = getSocketUser(socket);

  socket.to("voice:" + channelId).emit(
    "voice_user_left",
    {
      socketId: socket.id,
      user: publicUser(user)
    }
  );

  socket.leave("voice:" + channelId);

  if (serverId) {
    io.to("server:" + serverId).emit(
      "voice_presence",
      {
        channelId,
        user: publicUser(user),
        joined: false
      }
    );
  }

  socket.data.voiceChannelId = null;
  socket.data.voiceServerId = null;
}

/*
==================================================
PAGE PRINCIPALE
==================================================
*/

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/*
==================================================
404 API
==================================================
*/

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route API introuvable."
  });
});

/*
==================================================
ERREURS
==================================================
*/

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "Erreur interne du serveur."
  });
});

/*
==================================================
LANCEMENT
==================================================
*/

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("======================================");
  console.log("          NOVACHAT SERVEUR");
  console.log("======================================");
  console.log("Serveur lancé sur le port :", PORT);
  console.log("Adresse locale : http://localhost:" + PORT);
  console.log("======================================");
  console.log("");
});