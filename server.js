```js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// DATABASE
// ============================================================

const DATA_FILE = path.join(__dirname, "data.json");

const defaultDatabase = {
  users: [],
  servers: [],
  messages: []
};

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(defaultDatabase, null, 2)
      );

      return JSON.parse(JSON.stringify(defaultDatabase));
    }

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      users: Array.isArray(data.users) ? data.users : [],
      servers: Array.isArray(data.servers) ? data.servers : [],
      messages: Array.isArray(data.messages) ? data.messages : []
    };
  } catch (error) {
    console.error("Erreur lecture database :", error);

    return JSON.parse(
      JSON.stringify(defaultDatabase)
    );
  }
}

let db = loadDatabase();

function saveDatabase() {
  try {
    const tempFile = DATA_FILE + ".tmp";

    fs.writeFileSync(
      tempFile,
      JSON.stringify(db, null, 2)
    );

    fs.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    console.error("Erreur sauvegarde database :", error);
  }
}

// ============================================================
// UTILITAIRES
// ============================================================

function id() {
  return crypto.randomUUID();
}

function randomCode(length = 8) {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

  let result = "";

  for (let i = 0; i < length; i++) {
    result += chars[
      crypto.randomInt(0, chars.length)
    ];
  }

  return result;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .pbkdf2Sync(
      password,
      salt,
      120000,
      64,
      "sha512"
    )
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  try {
    const parts = storedPassword.split(":");

    if (parts.length !== 2) {
      return false;
    }

    const salt = parts[0];
    const originalHash = parts[1];

    const hash = crypto
      .pbkdf2Sync(
        password,
        salt,
        120000,
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

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{3,24}$/.test(username);
}

function validDisplayName(name) {
  return (
    typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 32
  );
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || null,
    createdAt: user.createdAt
  };
}

function findUserById(userId) {
  return db.users.find(
    user => user.id === userId
  );
}

function findUserByUsername(username) {
  const normalized = normalizeUsername(username);

  return db.users.find(
    user => user.username === normalized
  );
}

// ============================================================
// SESSIONS
// ============================================================

const sessions = new Map();

function createSession(userId) {
  const token = crypto
    .randomBytes(48)
    .toString("hex");

  sessions.set(token, {
    userId,
    createdAt: Date.now()
  });

  return token;
}

function getUserFromToken(token) {
  if (!token) return null;

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  return findUserById(session.userId);
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  const token = header.startsWith("Bearer ")
    ? header.substring(7)
    : null;

  const user = getUserFromToken(token);

  if (!user) {
    return res.status(401).json({
      error: "Non connecté"
    });
  }

  req.user = user;
  req.token = token;

  next();
}

// ============================================================
// AUTHENTIFICATION
// ============================================================

app.post("/api/auth/register", (req, res) => {
  const {
    email,
    password,
    username,
    displayName
  } = req.body;

  if (
    typeof email !== "string" ||
    !email.includes("@")
  ) {
    return res.status(400).json({
      error: "Adresse email invalide."
    });
  }

  if (
    typeof password !== "string" ||
    password.length < 6
  ) {
    return res.status(400).json({
      error:
        "Le mot de passe doit contenir au moins 6 caractères."
    });
  }

  const normalizedEmail =
    email.trim().toLowerCase();

  const normalizedUsername =
    normalizeUsername(username);

  if (!validUsername(normalizedUsername)) {
    return res.status(400).json({
      error:
        "Nom d'utilisateur invalide. Utilise 3 à 24 caractères : lettres, chiffres, _, - ou ."
    });
  }

  if (
    db.users.some(
      user => user.email === normalizedEmail
    )
  ) {
    return res.status(409).json({
      error: "Cette adresse email est déjà utilisée."
    });
  }

  if (
    db.users.some(
      user => user.username === normalizedUsername
    )
  ) {
    return res.status(409).json({
      error: "Ce nom d'utilisateur est déjà utilisé."
    });
  }

  const user = {
    id: id(),
    email: normalizedEmail,
    password: hashPassword(password),

    username: normalizedUsername,

    displayName:
      validDisplayName(displayName)
        ? displayName.trim()
        : normalizedUsername,

    avatar: null,

    createdAt: Date.now(),

    lastUsernameChange: Date.now(),

    friends: [],

    incomingFriendRequests: [],
    outgoingFriendRequests: [],

    servers: []
  };

  db.users.push(user);

  saveDatabase();

  const token = createSession(user.id);

  res.json({
    token,
    user: publicUser(user)
  });
});

app.post("/api/auth/login", (req, res) => {
  const {
    email,
    password
  } = req.body;

  const normalizedEmail =
    String(email || "")
      .trim()
      .toLowerCase();

  const user = db.users.find(
    u => u.email === normalizedEmail
  );

  if (
    !user ||
    !verifyPassword(password || "", user.password)
  ) {
    return res.status(401).json({
      error: "Email ou mot de passe incorrect."
    });
  }

  const token = createSession(user.id);

  res.json({
    token,
    user: publicUser(user)
  });
});

app.post(
  "/api/auth/logout",
  auth,
  (req, res) => {
    sessions.delete(req.token);

    res.json({
      success: true
    });
  }
);

app.get(
  "/api/auth/me",
  auth,
  (req, res) => {
    res.json({
      user: publicUser(req.user)
    });
  }
);

// ============================================================
// PROFIL
// ============================================================

// Changer le nom d'affichage quand on veut
app.patch(
  "/api/profile/display-name",
  auth,
  (req, res) => {
    const { displayName } = req.body;

    if (!validDisplayName(displayName)) {
      return res.status(400).json({
        error:
          "Le nom d'affichage doit contenir entre 1 et 32 caractères."
      });
    }

    req.user.displayName =
      displayName.trim();

    saveDatabase();

    io.emit("user:updated", {
      user: publicUser(req.user)
    });

    res.json({
      user: publicUser(req.user)
    });
  }
);

// Changer le nom d'utilisateur une fois tous les 14 jours
app.patch(
  "/api/profile/username",
  auth,
  (req, res) => {
    const {
      username
    } = req.body;

    const newUsername =
      normalizeUsername(username);

    if (!validUsername(newUsername)) {
      return res.status(400).json({
        error:
          "Nom d'utilisateur invalide."
      });
    }

    const fourteenDays =
      14 * 24 * 60 * 60 * 1000;

    const elapsed =
      Date.now() -
      (req.user.lastUsernameChange || 0);

    if (elapsed < fourteenDays) {
      const remaining =
        fourteenDays - elapsed;

      const days = Math.ceil(
        remaining /
          (24 * 60 * 60 * 1000)
      );

      return res.status(429).json({
        error:
          `Tu pourras changer ton nom d'utilisateur dans environ ${days} jour(s).`
      });
    }

    const existing =
      db.users.find(
        user =>
          user.username === newUsername &&
          user.id !== req.user.id
      );

    if (existing) {
      return res.status(409).json({
        error:
          "Ce nom d'utilisateur est déjà pris."
      });
    }

    req.user.username =
      newUsername;

    req.user.lastUsernameChange =
      Date.now();

    saveDatabase();

    io.emit("user:updated", {
      user: publicUser(req.user)
    });

    res.json({
      user: publicUser(req.user)
    });
  }
);

// ============================================================
// RECHERCHE UTILISATEURS
// ============================================================

app.get(
  "/api/users/search",
  auth,
  (req, res) => {
    const query =
      normalizeUsername(req.query.username);

    if (!query) {
      return res.json({
        users: []
      });
    }

    const users = db.users
      .filter(user =>
        user.username.includes(query)
      )
      .filter(user =>
        user.id !== req.user.id
      )
      .slice(0, 20)
      .map(publicUser);

    res.json({
      users
    });
  }
);

// ============================================================
// AMIS
// ============================================================

// Envoyer une demande avec le nom d'utilisateur
app.post(
  "/api/friends/request",
  auth,
  (req, res) => {
    const {
      username
    } = req.body;

    const target =
      findUserByUsername(username);

    if (!target) {
      return res.status(404).json({
        error:
          "Aucun utilisateur trouvé avec ce nom."
      });
    }

    if (target.id === req.user.id) {
      return res.status(400).json({
        error:
          "Tu ne peux pas t'ajouter toi-même."
      });
    }

    if (
      req.user.friends.includes(
        target.id
      )
    ) {
      return res.status(400).json({
        error:
          "Vous êtes déjà amis."
      });
    }

    if (
      target.incomingFriendRequests.includes(
        req.user.id
      )
    ) {
      return res.status(400).json({
        error:
          "Une demande est déjà en attente."
      });
    }

    target.incomingFriendRequests.push(
      req.user.id
    );

    req.user.outgoingFriendRequests.push(
      target.id
    );

    saveDatabase();

    io.to(`user:${target.id}`).emit(
      "friend:request",
      {
        from: publicUser(req.user)
      }
    );

    res.json({
      success: true,
      message:
        "Demande d'ami envoyée."
    });
  }
);

// Accepter une demande
app.post(
  "/api/friends/accept",
  auth,
  (req, res) => {
    const {
      userId
    } = req.body;

    const requester =
      findUserById(userId);

    if (!requester) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !req.user.incomingFriendRequests.includes(
        userId
      )
    ) {
      return res.status(400).json({
        error:
          "Aucune demande en attente."
      });
    }

    req.user.incomingFriendRequests =
      req.user.incomingFriendRequests.filter(
        id => id !== userId
      );

    requester.outgoingFriendRequests =
      requester.outgoingFriendRequests.filter(
        id => id !== req.user.id
      );

    if (
      !req.user.friends.includes(
        requester.id
      )
    ) {
      req.user.friends.push(
        requester.id
      );
    }

    if (
      !requester.friends.includes(
        req.user.id
      )
    ) {
      requester.friends.push(
        req.user.id
      );
    }

    saveDatabase();

    io.to(`user:${requester.id}`).emit(
      "friend:accepted",
      {
        user: publicUser(req.user)
      }
    );

    res.json({
      success: true
    });
  }
);

// Refuser une demande
app.post(
  "/api/friends/decline",
  auth,
  (req, res) => {
    const {
      userId
    } = req.body;

    req.user.incomingFriendRequests =
      req.user.incomingFriendRequests.filter(
        id => id !== userId
      );

    const requester =
      findUserById(userId);

    if (requester) {
      requester.outgoingFriendRequests =
        requester.outgoingFriendRequests.filter(
          id => id !== req.user.id
        );
    }

    saveDatabase();

    res.json({
      success: true
    });
  }
);

// Liste d'amis
app.get(
  "/api/friends",
  auth,
  (req, res) => {
    const friends =
      req.user.friends
        .map(findUserById)
        .filter(Boolean)
        .map(publicUser);

    const incoming =
      req.user.incomingFriendRequests
        .map(findUserById)
        .filter(Boolean)
        .map(publicUser);

    res.json({
      friends,
      incomingRequests: incoming
    });
  }
);

// ============================================================
// SERVEURS
// ============================================================

// Créer un serveur
app.post(
  "/api/servers",
  auth,
  (req, res) => {
    const {
      name
    } = req.body;

    if (
      typeof name !== "string" ||
      name.trim().length < 1 ||
      name.trim().length > 50
    ) {
      return res.status(400).json({
        error:
          "Le nom du serveur doit contenir entre 1 et 50 caractères."
      });
    }

    let inviteCode;

    do {
      inviteCode =
        randomCode(8);
    } while (
      db.servers.some(
        s => s.inviteCode === inviteCode
      )
    );

    const newServer = {
      id: id(),

      name: name.trim(),

      ownerId: req.user.id,

      inviteCode,

      createdAt: Date.now(),

      members: [
        {
          userId: req.user.id,
          role: "owner"
        }
      ],

      roles: [
        {
          id: id(),
          name: "everyone",
          permissions: [
            "VIEW_CHANNEL",
            "SEND_MESSAGES",
            "CONNECT",
            "SPEAK"
          ]
        }
      ],

      channels: [
        {
          id: id(),
          name: "général",
          type: "text"
        },
        {
          id: id(),
          name: "Vocal général",
          type: "voice"
        }
      ]
    };

    db.servers.push(
      newServer
    );

    req.user.servers.push(
      newServer.id
    );

    saveDatabase();

    res.json({
      server: newServer
    });
  }
);

// Rejoindre avec le code
app.post(
  "/api/servers/join",
  auth,
  (req, res) => {
    const {
      inviteCode
    } = req.body;

    const server =
      db.servers.find(
        s =>
          s.inviteCode.toLowerCase() ===
          String(inviteCode || "")
            .trim()
            .toLowerCase()
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Code d'invitation invalide."
      });
    }

    if (
      server.members.some(
        member =>
          member.userId === req.user.id
      )
    ) {
      return res.status(400).json({
        error:
          "Tu es déjà membre de ce serveur."
      });
    }

    server.members.push({
      userId: req.user.id,
      role: "member"
    });

    req.user.servers.push(
      server.id
    );

    saveDatabase();

    io.to(`server:${server.id}`).emit(
      "server:member-joined",
      {
        user: publicUser(req.user)
      }
    );

    res.json({
      server
    });
  }
);

// Liste des serveurs de l'utilisateur
app.get(
  "/api/servers",
  auth,
  (req, res) => {
    const servers =
      req.user.servers
        .map(serverId =>
          db.servers.find(
            server =>
              server.id === serverId
          )
        )
        .filter(Boolean);

    res.json({
      servers
    });
  }
);

// Informations serveur
app.get(
  "/api/servers/:serverId",
  auth,
  (req, res) => {
    const server =
      db.servers.find(
        s =>
          s.id === req.params.serverId
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    const isMember =
      server.members.some(
        member =>
          member.userId ===
          req.user.id
      );

    if (!isMember) {
      return res.status(403).json({
        error:
          "Tu n'es pas membre de ce serveur."
      });
    }

    const members =
      server.members
        .map(member => {
          const user =
            findUserById(
              member.userId
            );

          return user
            ? {
                ...publicUser(user),
                role: member.role
              }
            : null;
        })
        .filter(Boolean);

    res.json({
      server,
      members
    });
  }
);

// Supprimer un serveur
app.delete(
  "/api/servers/:serverId",
  auth,
  (req, res) => {
    const serverIndex =
      db.servers.findIndex(
        s =>
          s.id ===
          req.params.serverId
      );

    if (serverIndex === -1) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    const server =
      db.servers[serverIndex];

    if (
      server.ownerId !==
      req.user.id
    ) {
      return res.status(403).json({
        error:
          "Seul le propriétaire peut supprimer le serveur."
      });
    }

    db.servers.splice(
      serverIndex,
      1
    );

    for (const user of db.users) {
      user.servers =
        user.servers.filter(
          serverId =>
            serverId !==
            server.id
        );
    }

    saveDatabase();

    io.to(`server:${server.id}`).emit(
      "server:deleted",
      {
        serverId: server.id
      }
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// MESSAGES PRIVÉS
// ============================================================

function getConversationId(a, b) {
  return [a, b]
    .sort()
    .join(":");
}

app.get(
  "/api/dms/:userId",
  auth,
  (req, res) => {
    const otherUser =
      findUserById(
        req.params.userId
      );

    if (!otherUser) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    const conversationId =
      getConversationId(
        req.user.id,
        otherUser.id
      );

    const messages =
      db.messages.filter(
        message =>
          message.conversationId ===
          conversationId
      );

    res.json({
      conversationId,
      messages
    });
  }
);

app.post(
  "/api/dms/:userId",
  auth,
  (req, res) => {
    const otherUser =
      findUserById(
        req.params.userId
      );

    if (!otherUser) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    const {
      content
    } = req.body;

    if (
      typeof content !== "string" ||
      !content.trim()
    ) {
      return res.status(400).json({
        error:
          "Message vide."
      });
    }

    const conversationId =
      getConversationId(
        req.user.id,
        otherUser.id
      );

    const message = {
      id: id(),

      conversationId,

      senderId:
        req.user.id,

      receiverId:
        otherUser.id,

      content:
        content.trim(),

      createdAt:
        Date.now()
    };

    db.messages.push(
      message
    );

    // Évite une base qui grossit sans limite
    if (db.messages.length > 100000) {
      db.messages =
        db.messages.slice(
          -100000
        );
    }

    saveDatabase();

    io.to(
      `user:${otherUser.id}`
    ).emit(
      "dm:new",
      message
    );

    io.to(
      `user:${req.user.id}`
    ).emit(
      "dm:new",
      message
    );

    res.json({
      message
    });
  }
);

// ============================================================
// SOCKET.IO
// ============================================================

const socketUsers =
  new Map();

io.on("connection", socket => {
  console.log(
    "Socket connecté :",
    socket.id
  );

  // ----------------------------------------------------------
  // AUTH SOCKET
  // ----------------------------------------------------------

  socket.on(
    "authenticate",
    token => {
      const user =
        getUserFromToken(token);

      if (!user) {
        socket.emit(
          "auth:error",
          {
            error:
              "Session invalide."
          }
        );

        return;
      }

      socketUsers.set(
        socket.id,
        user.id
      );

      socket.userId =
        user.id;

      socket.join(
        `user:${user.id}`
      );

      socket.emit(
        "authenticated",
        {
          user:
            publicUser(user)
        }
      );

      console.log(
        `${user.username} connecté`
      );
    }
  );

  // ----------------------------------------------------------
  // SERVEUR
  // ----------------------------------------------------------

  socket.on(
    "server:join",
    serverId => {
      if (!socket.userId) return;

      const server =
        db.servers.find(
          s =>
            s.id === serverId
        );

      if (!server) return;

      const member =
        server.members.some(
          m =>
            m.userId ===
            socket.userId
        );

      if (!member) return;

      socket.join(
        `server:${serverId}`
      );
    }
  );

  socket.on(
    "server:leave",
    serverId => {
      socket.leave(
        `server:${serverId}`
      );
    }
  );

  // ----------------------------------------------------------
  // VOCAL
  // ----------------------------------------------------------

  socket.on(
    "voice:join",
    data => {
      if (!socket.userId) return;

      const {
        serverId,
        roomId
      } = data || {};

      if (!serverId || !roomId) {
        return;
      }

      const server =
        db.servers.find(
          s =>
            s.id === serverId
        );

      if (!server) return;

      const member =
        server.members.some(
          m =>
            m.userId ===
            socket.userId
        );

      if (!member) return;

      const room =
        `voice:${serverId}:${roomId}`;

      socket.join(room);

      const users =
        [];

      const sockets =
        io.sockets.adapter.rooms.get(
          room
        );

      if (sockets) {
        for (
          const socketId of sockets
        ) {
          const userId =
            socketUsers.get(
              socketId
            );

          const user =
            findUserById(
              userId
            );

          if (user) {
            users.push(
              publicUser(user)
            );
          }
        }
      }

      socket.emit(
        "voice:users",
        {
          users
        }
      );

      socket.to(room).emit(
        "voice:user-joined",
        {
          user:
            publicUser(
              findUserById(
                socket.userId
              )
            )
        }
      );
    }
  );

  socket.on(
    "voice:leave",
    data => {
      if (!socket.userId) return;

      const {
        serverId,
        roomId
      } = data || {};

      if (!serverId || !roomId) {
        return;
      }

      const room =
        `voice:${serverId}:${roomId}`;

      socket.leave(room);

      socket.to(room).emit(
        "voice:user-left",
        {
          userId:
            socket.userId
        }
      );
    }
  );

  // ----------------------------------------------------------
  // WEBRTC SIGNALING
  // ----------------------------------------------------------

  socket.on(
    "webrtc:offer",
    data => {
      if (!socket.userId) return;

      const {
        targetSocketId,
        offer
      } = data || {};

      if (!targetSocketId || !offer) {
        return;
      }

      io.to(
        targetSocketId
      ).emit(
        "webrtc:offer",
        {
          fromSocketId:
            socket.id,
          fromUserId:
            socket.userId,
          offer
        }
      );
    }
  );

  socket.on(
    "webrtc:answer",
    data => {
      if (!socket.userId) return;

      const {
        targetSocketId,
        answer
      } = data || {};

      if (
        !targetSocketId ||
        !answer
      ) {
        return;
      }

      io.to(
        targetSocketId
      ).emit(
        "webrtc:answer",
        {
          fromSocketId:
            socket.id,
          fromUserId:
            socket.userId,
          answer
        }
      );
    }
  );

  socket.on(
    "webrtc:ice-candidate",
    data => {
      if (!socket.userId) return;

      const {
        targetSocketId,
        candidate
      } = data || {};

      if (
        !targetSocketId ||
        !candidate
      ) {
        return;
      }

      io.to(
        targetSocketId
      ).emit(
        "webrtc:ice-candidate",
        {
          fromSocketId:
            socket.id,
          fromUserId:
            socket.userId,
          candidate
        }
      );
    }
  );

  // ----------------------------------------------------------
  // APPEL DIRECT ENTRE AMIS
  // ----------------------------------------------------------

  socket.on(
    "call:invite",
    data => {
      if (!socket.userId) return;

      const {
        targetUserId,
        callType
      } = data || {};

      if (!targetUserId) return;

      const target =
        findUserById(
          targetUserId
        );

      if (!target) return;

      io.to(
        `user:${targetUserId}`
      ).emit(
        "call:incoming",
        {
          from:
            publicUser(
              findUserById(
                socket.userId
              )
            ),
          callType:
            callType === "video"
              ? "video"
              : "audio"
        }
      );
    }
  );

  socket.on(
    "call:accept",
    data => {
      if (!socket.userId) return;

      const {
        targetUserId
      } = data || {};

      if (!targetUserId) return;

      io.to(
        `user:${targetUserId}`
      ).emit(
        "call:accepted",
        {
          user:
            publicUser(
              findUserById(
                socket.userId
              )
            )
        }
      );
    }
  );

  socket.on(
    "call:decline",
    data => {
      if (!socket.userId) return;

      const {
        targetUserId
      } = data || {};

      if (!targetUserId) return;

      io.to(
        `user:${targetUserId}`
      ).emit(
        "call:declined",
        {
          userId:
            socket.userId
        }
      );
    }
  );

  socket.on(
    "call:end",
    data => {
      if (!socket.userId) return;

      const {
        targetUserId
      } = data || {};

      if (!targetUserId) return;

      io.to(
        `user:${targetUserId}`
      ).emit(
        "call:ended",
        {
          userId:
            socket.userId
        }
      );
    }
  );

  // ----------------------------------------------------------
  // PARTAGE D'ÉCRAN
  // ----------------------------------------------------------

  socket.on(
    "screen:started",
    data => {
      if (!socket.userId) return;

      const {
        room
      } = data || {};

      if (!room) return;

      socket.to(room).emit(
        "screen:started",
        {
          user:
            publicUser(
              findUserById(
                socket.userId
              )
            )
        }
      );
    }
  );

  socket.on(
    "screen:stopped",
    data => {
      if (!socket.userId) return;

      const {
        room
      } = data || {};

      if (!room) return;

      socket.to(room).emit(
        "screen:stopped",
        {
          userId:
            socket.userId
        }
      );
    }
  );

  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------

  socket.on(
    "disconnect",
    () => {
      const userId =
        socketUsers.get(
          socket.id
        );

      socketUsers.delete(
        socket.id
      );

      if (userId) {
        console.log(
          "Utilisateur déconnecté :",
          userId
        );
      }
    }
  );
});

// ============================================================
// ROUTE PRINCIPALE
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      service: "NovaChat",
      time: new Date().toISOString()
    });
  }
);

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `NovaChat lancé sur le port ${PORT}`
    );

    console.log(
      `http://localhost:${PORT}`
    );
  }
);
```
