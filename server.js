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
const DATA_FILE = path.join(DATA_DIR, "data.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_DATA = {
  users: [],
  servers: [],
  friendships: [],
  messages: []
};

let db = loadDatabase();

const onlineUsers = new Map();
const voiceUsers = new Map();
const sessions = new Map();

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(DEFAULT_DATA, null, 2)
      );
      return structuredClone(DEFAULT_DATA);
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");

    if (!raw.trim()) {
      return structuredClone(DEFAULT_DATA);
    }

    const parsed = JSON.parse(raw);

    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      friendships: Array.isArray(parsed.friendships)
        ? parsed.friendships
        : [],
      messages: Array.isArray(parsed.messages)
        ? parsed.messages
        : []
    };
  } catch (error) {
    console.error("Erreur lecture data.json:", error);

    return structuredClone(DEFAULT_DATA);
  }
}

function saveDatabase() {
  try {
    const temporaryFile = DATA_FILE + ".tmp";

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(db, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryFile, DATA_FILE);
  } catch (error) {
    console.error("Erreur sauvegarde:", error);
  }
}

function id(prefix = "") {
  return (
    prefix +
    crypto.randomBytes(12).toString("hex")
  );
}

function now() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 24);
}

function cleanDisplayName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function cleanServerName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50);
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

function publicUserWithOnline(user) {
  if (!user) return null;

  return {
    ...publicUser(user),
    online: onlineUsers.has(user.id)
  };
}

function findUserById(userId) {
  return db.users.find(
    user => user.id === userId
  );
}

function findUserByUsername(username) {
  const normalized =
    normalizeUsername(username);

  return db.users.find(
    user =>
      normalizeUsername(user.username) ===
      normalized
  );
}

function getServerById(serverId) {
  return db.servers.find(
    server => server.id === serverId
  );
}

function isServerMember(server, userId) {
  return Boolean(
    server &&
    server.members.includes(userId)
  );
}

function getUserServers(userId) {
  return db.servers.filter(
    server =>
      server.members.includes(userId)
  );
}

function getFriendIds(userId) {
  const result = [];

  for (const friendship of db.friendships) {
    if (
      friendship.userA === userId
    ) {
      result.push(friendship.userB);
    }

    if (
      friendship.userB === userId
    ) {
      result.push(friendship.userA);
    }
  }

  return [...new Set(result)];
}

function areFriends(a, b) {
  return db.friendships.some(
    friendship =>
      (
        friendship.userA === a &&
        friendship.userB === b
      ) ||
      (
        friendship.userA === b &&
        friendship.userB === a
      )
  );
}

function generateInviteCode() {
  let code;

  do {
    code = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();
  } while (
    db.servers.some(
      server => server.inviteCode === code
    )
  );

  return code;
}

/*
|--------------------------------------------------------------------------
| PASSWORDS
|--------------------------------------------------------------------------
*/

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt =
      crypto.randomBytes(16).toString("hex");

    crypto.scrypt(
      password,
      salt,
      64,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(
          `${salt}:${derivedKey.toString("hex")}`
        );
      }
    );
  });
}

function verifyPassword(password, stored) {
  return new Promise(resolve => {
    try {
      const parts = String(stored).split(":");

      if (parts.length !== 2) {
        resolve(false);
        return;
      }

      const salt = parts[0];
      const originalHash = Buffer.from(
        parts[1],
        "hex"
      );

      crypto.scrypt(
        password,
        salt,
        64,
        (error, derivedKey) => {
          if (error) {
            resolve(false);
            return;
          }

          if (
            originalHash.length !==
            derivedKey.length
          ) {
            resolve(false);
            return;
          }

          resolve(
            crypto.timingSafeEqual(
              originalHash,
              derivedKey
            )
          );
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/*
|--------------------------------------------------------------------------
| AUTH
|--------------------------------------------------------------------------
*/

function createSession(userId) {
  const token =
    crypto.randomBytes(32).toString("hex");

  sessions.set(token, userId);

  return token;
}

function getUserFromRequest(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token =
    header.slice(7).trim();

  const userId =
    sessions.get(token);

  if (!userId) {
    return null;
  }

  return findUserById(userId) || null;
}

function requireAuth(req, res, next) {
  const user =
    getUserFromRequest(req);

  if (!user) {
    return res.status(401).json({
      error: "Non authentifié."
    });
  }

  req.user = user;
  next();
}

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "8mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "8mb"
  })
);

app.use(
  express.static(PUBLIC_DIR)
);

/*
|--------------------------------------------------------------------------
| REGISTER
|--------------------------------------------------------------------------
*/

app.post("/api/register", async (req, res) => {
  try {
    const username =
      cleanUsername(req.body.username);

    const email =
      String(req.body.email || "")
        .trim()
        .toLowerCase();

    const password =
      String(req.body.password || "");

    if (!username) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur est obligatoire."
      });
    }

    if (
      username.length < 2 ||
      username.length > 24
    ) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur doit contenir entre 2 et 24 caractères."
      });
    }

    if (
      !/^[a-zA-Z0-9_.-]+$/.test(username)
    ) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur contient des caractères interdits."
      });
    }

    if (!email) {
      return res.status(400).json({
        error: "L'email est obligatoire."
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: "Adresse email invalide."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error:
          "Le mot de passe doit contenir au moins 6 caractères."
      });
    }

    if (findUserByUsername(username)) {
      return res.status(409).json({
        error:
          "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    if (
      db.users.some(
        user => user.email === email
      )
    ) {
      return res.status(409).json({
        error:
          "Cette adresse email est déjà utilisée."
      });
    }

    const passwordHash =
      await hashPassword(password);

    const user = {
      id: id("usr_"),
      username,
      displayName: username,
      email,
      passwordHash,
      avatar: null,
      createdAt: now(),
      usernameChangedAt: now()
    };

    db.users.push(user);

    saveDatabase();

    const token =
      createSession(user.id);

    res.json({
      token,
      user: publicUser(user)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "Impossible de créer le compte."
    });
  }
});

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

app.post("/api/login", async (req, res) => {
  try {
    const email =
      String(req.body.email || "")
        .trim()
        .toLowerCase();

    const password =
      String(req.body.password || "");

    const user =
      db.users.find(
        item => item.email === email
      );

    if (!user) {
      return res.status(401).json({
        error:
          "Email ou mot de passe incorrect."
      });
    }

    const valid =
      await verifyPassword(
        password,
        user.passwordHash
      );

    if (!valid) {
      return res.status(401).json({
        error:
          "Email ou mot de passe incorrect."
      });
    }

    const token =
      createSession(user.id);

    res.json({
      token,
      user: publicUser(user)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "Impossible de se connecter."
    });
  }
});

/*
|--------------------------------------------------------------------------
| ME
|--------------------------------------------------------------------------
*/

app.get(
  "/api/me",
  requireAuth,
  (req, res) => {
    res.json({
      user: publicUser(req.user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| LOGOUT
|--------------------------------------------------------------------------
*/

app.post(
  "/api/logout",
  requireAuth,
  (req, res) => {
    const header =
      req.headers.authorization || "";

    const token =
      header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : null;

    if (token) {
      sessions.delete(token);
    }

    res.json({
      ok: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| PROFILE DISPLAY NAME
|--------------------------------------------------------------------------
*/

app.post(
  "/api/profile/display-name",
  requireAuth,
  (req, res) => {
    const displayName =
      cleanDisplayName(
        req.body.displayName
      );

    if (
      displayName.length < 1 ||
      displayName.length > 32
    ) {
      return res.status(400).json({
        error:
          "Le nom d'affichage doit contenir entre 1 et 32 caractères."
      });
    }

    req.user.displayName =
      displayName;

    saveDatabase();

    broadcastUsersUpdate();

    res.json({
      user: publicUser(req.user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| USERNAME
|--------------------------------------------------------------------------
*/

app.post(
  "/api/profile/username",
  requireAuth,
  (req, res) => {
    const username =
      cleanUsername(
        req.body.username
      );

    if (
      username.length < 2 ||
      username.length > 24
    ) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur doit contenir entre 2 et 24 caractères."
      });
    }

    if (
      !/^[a-zA-Z0-9_.-]+$/.test(username)
    ) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur contient des caractères interdits."
      });
    }

    if (
      normalizeUsername(
        req.user.username
      ) === normalizeUsername(username)
    ) {
      return res.status(400).json({
        error:
          "C'est déjà ton nom d'utilisateur."
      });
    }

    if (findUserByUsername(username)) {
      return res.status(409).json({
        error:
          "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    const lastChange =
      req.user.usernameChangedAt
        ? new Date(
            req.user.usernameChangedAt
          ).getTime()
        : 0;

    const twoWeeks =
      14 * 24 * 60 * 60 * 1000;

    if (
      lastChange &&
      Date.now() - lastChange <
        twoWeeks
    ) {
      const remaining =
        twoWeeks -
        (Date.now() - lastChange);

      const days = Math.ceil(
        remaining /
          (24 * 60 * 60 * 1000)
      );

      return res.status(429).json({
        error:
          `Tu dois attendre encore environ ${days} jour(s) avant de changer ton nom d'utilisateur.`
      });
    }

    req.user.username =
      username;

    req.user.usernameChangedAt =
      now();

    saveDatabase();

    broadcastUsersUpdate();

    res.json({
      user: publicUser(req.user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| AVATAR
|--------------------------------------------------------------------------
|
| L'image est envoyée en base64 depuis le navigateur.
| Elle est enregistrée dans data.json.
|--------------------------------------------------------------------------
*/

app.post(
  "/api/profile/avatar",
  requireAuth,
  (req, res) => {
    const avatar =
      String(req.body.avatar || "");

    if (!avatar) {
      return res.status(400).json({
        error:
          "Aucune image reçue."
      });
    }

    if (
      !avatar.startsWith("data:image/")
    ) {
      return res.status(400).json({
        error:
          "Format d'image invalide."
      });
    }

    if (avatar.length > 5 * 1024 * 1024) {
      return res.status(400).json({
        error:
          "Image trop grande. Maximum 5 Mo."
      });
    }

    req.user.avatar =
      avatar;

    saveDatabase();

    broadcastUsersUpdate();

    res.json({
      user: publicUser(req.user)
    });
  }
);

/*
|--------------------------------------------------------------------------
| FRIENDS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/friends",
  requireAuth,
  (req, res) => {
    const ids =
      getFriendIds(req.user.id);

    const friends =
      ids
        .map(findUserById)
        .filter(Boolean)
        .map(publicUserWithOnline);

    res.json({
      friends
    });
  }
);

app.post(
  "/api/friends/add",
  requireAuth,
  (req, res) => {
    const username =
      cleanUsername(
        req.body.username
      );

    const target =
      findUserByUsername(username);

    if (!target) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      target.id === req.user.id
    ) {
      return res.status(400).json({
        error:
          "Tu ne peux pas t'ajouter toi-même."
      });
    }

    if (
      areFriends(
        req.user.id,
        target.id
      )
    ) {
      return res.status(400).json({
        error:
          "Vous êtes déjà amis."
      });
    }

    db.friendships.push({
      id: id("fr_"),
      userA: req.user.id,
      userB: target.id,
      createdAt: now()
    });

    saveDatabase();

    broadcastUsersUpdate();

    res.json({
      ok: true,
      friend: publicUser(target)
    });
  }
);

/*
|--------------------------------------------------------------------------
| DMS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/dm/:userId",
  requireAuth,
  (req, res) => {
    const otherId =
      req.params.userId;

    const other =
      findUserById(otherId);

    if (!other) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !areFriends(
        req.user.id,
        otherId
      )
    ) {
      return res.status(403).json({
        error:
          "Vous devez être amis pour discuter."
      });
    }

    const messages =
      db.messages.filter(
        message =>
          (
            message.senderId ===
              req.user.id &&
            message.receiverId ===
              otherId
          ) ||
          (
            message.senderId ===
              otherId &&
            message.receiverId ===
              req.user.id
          )
      );

    res.json({
      messages
    });
  }
);

app.post(
  "/api/dm/:userId",
  requireAuth,
  (req, res) => {
    const receiverId =
      req.params.userId;

    const receiver =
      findUserById(receiverId);

    if (!receiver) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !areFriends(
        req.user.id,
        receiverId
      )
    ) {
      return res.status(403).json({
        error:
          "Vous devez être amis pour discuter."
      });
    }

    const content =
      String(req.body.content || "")
        .trim()
        .slice(0, 4000);

    if (!content) {
      return res.status(400).json({
        error:
          "Le message est vide."
      });
    }

    const message = {
      id: id("msg_"),
      senderId: req.user.id,
      receiverId,
      content,
      createdAt: now()
    };

    db.messages.push(message);

    saveDatabase();

    emitToUser(
      req.user.id,
      "dm:new",
      { message }
    );

    emitToUser(
      receiverId,
      "dm:new",
      { message }
    );

    res.json({
      message
    });
  }
);

/*
|--------------------------------------------------------------------------
| SERVERS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/servers",
  requireAuth,
  (req, res) => {
    const servers =
      getUserServers(req.user.id)
        .map(server => ({
          id: server.id,
          name: server.name,
          icon: server.icon || null,
          inviteCode:
            server.ownerId === req.user.id
              ? server.inviteCode
              : null,
          ownerId: server.ownerId,
          channels: server.channels
        }));

    res.json({
      servers
    });
  }
);

app.get(
  "/api/servers/:serverId",
  requireAuth,
  (req, res) => {
    const server =
      getServerById(
        req.params.serverId
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    if (
      !isServerMember(
        server,
        req.user.id
      )
    ) {
      return res.status(403).json({
        error:
          "Tu ne fais pas partie de ce serveur."
      });
    }

    res.json({
      server: publicServer(server)
    });
  }
);

function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    icon: server.icon || null,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    members: server.members
      .map(findUserById)
      .filter(Boolean)
      .map(publicUserWithOnline),
    channels: server.channels
  };
}

app.post(
  "/api/servers",
  requireAuth,
  (req, res) => {
    const name =
      cleanServerName(
        req.body.name
      );

    if (
      name.length < 2 ||
      name.length > 50
    ) {
      return res.status(400).json({
        error:
          "Le nom du serveur doit contenir entre 2 et 50 caractères."
      });
    }

    const serverId =
      id("srv_");

    const server = {
      id: serverId,
      name,
      icon: null,
      ownerId: req.user.id,
      inviteCode:
        generateInviteCode(),
      members: [
        req.user.id
      ],
      channels: [
        {
          id: id("chn_"),
          type: "text",
          name: "général"
        },
        {
          id: id("chn_"),
          type: "voice",
          name: "Général"
        }
      ],
      createdAt: now()
    };

    db.servers.push(server);

    saveDatabase();

    res.json({
      server: publicServer(server)
    });
  }
);

app.post(
  "/api/servers/join",
  requireAuth,
  (req, res) => {
    const inviteCode =
      String(
        req.body.inviteCode || ""
      )
        .trim()
        .toUpperCase();

    const server =
      db.servers.find(
        item =>
          item.inviteCode ===
          inviteCode
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Code d'invitation invalide."
      });
    }

    if (
      !server.members.includes(
        req.user.id
      )
    ) {
      server.members.push(
        req.user.id
      );

      saveDatabase();
    }

    res.json({
      server: publicServer(server)
    });

    broadcastUsersUpdate();
  }
);

/*
|--------------------------------------------------------------------------
| SERVER ICON
|--------------------------------------------------------------------------
*/

app.post(
  "/api/servers/:serverId/icon",
  requireAuth,
  (req, res) => {
    const server =
      getServerById(
        req.params.serverId
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    if (
      server.ownerId !==
      req.user.id
    ) {
      return res.status(403).json({
        error:
          "Seul le propriétaire peut modifier l'icône."
      });
    }

    const icon =
      String(req.body.icon || "");

    if (
      icon &&
      !icon.startsWith("data:image/")
    ) {
      return res.status(400).json({
        error:
          "Image invalide."
      });
    }

    if (icon.length > 5 * 1024 * 1024) {
      return res.status(400).json({
        error:
          "Image trop grande."
      });
    }

    server.icon =
      icon || null;

    saveDatabase();

    res.json({
      server: publicServer(server)
    });
  }
);

/*
|--------------------------------------------------------------------------
| SERVER TEXT MESSAGES
|--------------------------------------------------------------------------
*/

function getServerMessages(serverId) {
  if (!Array.isArray(db.serverMessages)) {
    db.serverMessages = [];
  }

  return db.serverMessages.filter(
    message =>
      message.serverId ===
      serverId
  );
}

app.get(
  "/api/servers/:serverId/messages/:channelId",
  requireAuth,
  (req, res) => {
    const server =
      getServerById(
        req.params.serverId
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    if (
      !isServerMember(
        server,
        req.user.id
      )
    ) {
      return res.status(403).json({
        error:
          "Accès refusé."
      });
    }

    const channel =
      server.channels.find(
        item =>
          item.id ===
          req.params.channelId
      );

    if (
      !channel ||
      channel.type !== "text"
    ) {
      return res.status(404).json({
        error:
          "Salon textuel introuvable."
      });
    }

    const messages =
      getServerMessages(
        server.id
      ).filter(
        message =>
          message.channelId ===
          channel.id
      );

    res.json({
      messages
    });
  }
);

app.post(
  "/api/servers/:serverId/messages/:channelId",
  requireAuth,
  (req, res) => {
    const server =
      getServerById(
        req.params.serverId
      );

    if (!server) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    if (
      !isServerMember(
        server,
        req.user.id
      )
    ) {
      return res.status(403).json({
        error:
          "Accès refusé."
      });
    }

    const channel =
      server.channels.find(
        item =>
          item.id ===
          req.params.channelId
      );

    if (
      !channel ||
      channel.type !== "text"
    ) {
      return res.status(404).json({
        error:
          "Salon textuel introuvable."
      });
    }

    const content =
      String(req.body.content || "")
        .trim()
        .slice(0, 4000);

    if (!content) {
      return res.status(400).json({
        error:
          "Le message est vide."
      });
    }

    if (!Array.isArray(db.serverMessages)) {
      db.serverMessages = [];
    }

    const message = {
      id: id("sm_"),
      serverId: server.id,
      channelId: channel.id,
      senderId: req.user.id,
      content,
      createdAt: now()
    };

    db.serverMessages.push(
      message
    );

    saveDatabase();

    io.to(
      "server:" + server.id
    ).emit(
      "server:message",
      {
        message
      }
    );

    res.json({
      message
    });
  }
);

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

function emitToUser(
  userId,
  event,
  data
) {
  const socketId =
    onlineUsers.get(userId);

  if (!socketId) return;

  io.to(socketId).emit(
    event,
    data
  );
}

function broadcastUsersUpdate() {
  io.emit("users:update");
}

io.on("connection", socket => {

  socket.on(
    "authenticate",
    token => {

      const userId =
        sessions.get(token);

      if (!userId) {
        socket.emit(
          "auth:error"
        );
        return;
      }

      socket.userId =
        userId;

      onlineUsers.set(
        userId,
        socket.id
      );

      const user =
        findUserById(userId);

      socket.emit(
        "authenticated",
        {
          user:
            publicUser(user)
        }
      );

      broadcastUsersUpdate();
    }
  );

  /*
  |--------------------------------------------------------------------------
  | SERVER ROOM
  |--------------------------------------------------------------------------
  */

  socket.on(
    "server:join",
    serverId => {

      if (!socket.userId) return;

      const server =
        getServerById(serverId);

      if (
        !server ||
        !isServerMember(
          server,
          socket.userId
        )
      ) {
        return;
      }

      socket.join(
        "server:" + serverId
      );
    }
  );

  /*
  |--------------------------------------------------------------------------
  | VOICE
  |--------------------------------------------------------------------------
  */

  socket.on(
    "voice:join",
    data => {

      if (!socket.userId) return;

      const serverId =
        String(
          data?.serverId || ""
        );

      const channelId =
        String(
          data?.channelId || ""
        );

      const server =
        getServerById(serverId);

      if (!server) return;

      if (
        !isServerMember(
          server,
          socket.userId
        )
      ) {
        return;
      }

      const channel =
        server.channels.find(
          item =>
            item.id === channelId &&
            item.type === "voice"
        );

      if (!channel) return;

      leaveCurrentVoice(
        socket
      );

      const key =
        serverId +
        ":" +
        channelId;

      if (!voiceUsers.has(key)) {
        voiceUsers.set(
          key,
          new Set()
        );
      }

      voiceUsers
        .get(key)
        .add(
          socket.userId
        );

      socket.voiceKey =
        key;

      socket.voiceServerId =
        serverId;

      socket.voiceChannelId =
        channelId;

      socket.join(
        "voice:" + key
      );

      emitVoiceUpdate(
        serverId,
        channelId
      );
    }
  );

  socket.on(
    "voice:leave",
    () => {
      leaveCurrentVoice(socket);
    }
  );

  /*
  |--------------------------------------------------------------------------
  | WEBRTC SIGNALING
  |--------------------------------------------------------------------------
  */

  socket.on(
    "webrtc:offer",
    data => {
      relayVoiceSignal(
        socket,
        "webrtc:offer",
        data
      );
    }
  );

  socket.on(
    "webrtc:answer",
    data => {
      relayVoiceSignal(
        socket,
        "webrtc:answer",
        data
      );
    }
  );

  socket.on(
    "webrtc:ice",
    data => {
      relayVoiceSignal(
        socket,
        "webrtc:ice",
        data
      );
    }
  );

  socket.on(
    "disconnect",
    () => {

      leaveCurrentVoice(
        socket
      );

      if (
        socket.userId &&
        onlineUsers.get(
          socket.userId
        ) === socket.id
      ) {
        onlineUsers.delete(
          socket.userId
        );
      }

      broadcastUsersUpdate();
    }
  );
});

function relayVoiceSignal(
  socket,
  event,
  data
) {
  if (!socket.userId) return;

  const serverId =
    socket.voiceServerId;

  const channelId =
    socket.voiceChannelId;

  if (!serverId || !channelId) {
    return;
  }

  const server =
    getServerById(serverId);

  if (!server) return;

  const key =
    serverId + ":" + channelId;

  const room =
    voiceUsers.get(key);

  if (!room) return;

  for (const userId of room) {

    if (
      userId ===
      socket.userId
    ) {
      continue;
    }

    emitToUser(
      userId,
      event,
      {
        ...data,
        from: socket.userId
      }
    );
  }
}

function leaveCurrentVoice(socket) {

  if (!socket.voiceKey) {
    return;
  }

  const key =
    socket.voiceKey;

  const users =
    voiceUsers.get(key);

  if (users) {

    users.delete(
      socket.userId
    );

    if (users.size === 0) {
      voiceUsers.delete(
        key
      );
    }
  }

  socket.leave(
    "voice:" + key
  );

  const parts =
    key.split(":");

  const serverId =
    parts.shift();

  const channelId =
    parts.join(":");

  emitVoiceUpdate(
    serverId,
    channelId
  );

  socket.voiceKey = null;
  socket.voiceServerId = null;
  socket.voiceChannelId = null;
}

function emitVoiceUpdate(
  serverId,
  channelId
) {
  const key =
    serverId +
    ":" +
    channelId;

  const ids =
    voiceUsers.get(key)
      ? [
          ...voiceUsers.get(key)
        ]
      : [];

  const users =
    ids
      .map(findUserById)
      .filter(Boolean)
      .map(publicUser);

  io.emit(
    "voice:update",
    {
      serverId,
      channelId,
      users
    }
  );
}

/*
|--------------------------------------------------------------------------
| FALLBACK
|--------------------------------------------------------------------------
|
| Pas de app.get("*") avec Express 5.
| Cela évite l'erreur path-to-regexp que tu avais eue.
|--------------------------------------------------------------------------
*/

app.use(
  (req, res, next) => {

    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/")
    ) {
      return res.sendFile(
        path.join(
          PUBLIC_DIR,
          "index.html"
        )
      );
    }

    next();
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `NovaChat lancé sur le port ${PORT}`
    );
  }
);