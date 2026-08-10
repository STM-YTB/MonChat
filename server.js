```javascript
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/*
=========================================================
DONNÉES
=========================================================
*/

const users = new Map();
const sessions = new Map();
const friendRequests = new Map();
const friendships = new Map();
const conversations = new Map();
const servers = new Map();
const serverMembers = new Map();

const sockets = new Map();

/*
=========================================================
OUTILS
=========================================================
*/

function id() {
  return crypto.randomUUID();
}

function createInviteCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");
}

function cleanDisplayName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

function getUserByUsername(username) {
  const wanted = cleanUsername(username);

  for (const user of users.values()) {
    if (user.username === wanted) {
      return user;
    }
  }

  return null;
}

function getAuthUser(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.substring(7);

  const userId = sessions.get(token);

  if (!userId) {
    return null;
  }

  return users.get(userId) || null;
}

function requireAuth(req, res) {
  const user = getAuthUser(req);

  if (!user) {
    res.status(401).json({
      error: "Non connecté."
    });

    return null;
  }

  return user;
}

function friendshipKey(a, b) {
  return [a, b].sort().join(":");
}

function areFriends(a, b) {
  return friendships.has(
    friendshipKey(a, b)
  );
}

function conversationKey(a, b) {
  return [a, b].sort().join(":");
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

function sendToUser(userId, event, data) {
  const socketId = sockets.get(userId);

  if (!socketId) {
    return;
  }

  const socket = io.sockets.sockets.get(socketId);

  if (socket) {
    socket.emit(event, data);
  }
}

/*
=========================================================
AUTH
=========================================================
*/

app.post("/api/auth/register", (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  const username = cleanUsername(
    req.body.username
  );

  const displayName =
    cleanDisplayName(
      req.body.displayName
    ) || username;

  const password =
    String(req.body.password || "");

  if (!email || !email.includes("@")) {
    return res.status(400).json({
      error: "Adresse email invalide."
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      error:
        "Le nom d'utilisateur doit contenir au moins 3 caractères."
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error:
        "Le mot de passe doit contenir au moins 6 caractères."
    });
  }

  for (const user of users.values()) {
    if (user.email === email) {
      return res.status(400).json({
        error: "Cette adresse email est déjà utilisée."
      });
    }

    if (user.username === username) {
      return res.status(400).json({
        error:
          "Ce nom d'utilisateur est déjà utilisé."
      });
    }
  }

  const user = {
    id: id(),
    email,
    username,
    displayName,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    usernameChangedAt: Date.now()
  };

  users.set(user.id, user);
  friendships.set(user.id, new Set());

  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, user.id);

  res.json({
    token,
    user: publicUser(user)
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  const password =
    String(req.body.password || "");

  let user = null;

  for (const item of users.values()) {
    if (item.email === email) {
      user = item;
      break;
    }
  }

  if (!user) {
    return res.status(401).json({
      error: "Email ou mot de passe incorrect."
    });
  }

  if (
    user.passwordHash !==
    hashPassword(password)
  ) {
    return res.status(401).json({
      error: "Email ou mot de passe incorrect."
    });
  }

  const token =
    crypto.randomBytes(32).toString("hex");

  sessions.set(token, user.id);

  res.json({
    token,
    user: publicUser(user)
  });
});

app.post("/api/auth/logout", (req, res) => {
  const header =
    req.headers.authorization || "";

  if (header.startsWith("Bearer ")) {
    sessions.delete(
      header.substring(7)
    );
  }

  res.json({
    success: true
  });
});

app.get("/api/auth/me", (req, res) => {
  const user = requireAuth(req, res);

  if (!user) return;

  res.json({
    user: publicUser(user)
  });
});

/*
=========================================================
UTILISATEURS
=========================================================
*/

app.get("/api/users/search", (req, res) => {
  const user = requireAuth(req, res);

  if (!user) return;

  const username =
    cleanUsername(
      req.query.username
    );

  const result = [];

  for (const item of users.values()) {
    if (
      item.id !== user.id &&
      item.username.includes(username)
    ) {
      result.push(
        publicUser(item)
      );
    }
  }

  res.json({
    users: result.slice(0, 20)
  });
});

/*
=========================================================
PROFIL
=========================================================
*/

app.patch(
  "/api/profile/display-name",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const displayName =
      cleanDisplayName(
        req.body.displayName
      );

    if (!displayName) {
      return res.status(400).json({
        error:
          "Le nom d'affichage est vide."
      });
    }

    user.displayName =
      displayName;

    const result =
      publicUser(user);

    sendToUser(
      user.id,
      "user:updated",
      {
        user: result
      }
    );

    res.json({
      user: result
    });
  }
);

app.patch(
  "/api/profile/username",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const username =
      cleanUsername(
        req.body.username
      );

    if (username.length < 3) {
      return res.status(400).json({
        error:
          "Le nom d'utilisateur doit contenir au moins 3 caractères."
      });
    }

    const twoWeeks =
      14 * 24 * 60 * 60 * 1000;

    if (
      user.usernameChangedAt &&
      Date.now() -
        user.usernameChangedAt <
        twoWeeks
    ) {
      const remaining =
        twoWeeks -
        (Date.now() -
          user.usernameChangedAt);

      const days =
        Math.ceil(
          remaining /
          (24 * 60 * 60 * 1000)
        );

      return res.status(400).json({
        error:
          "Tu dois attendre encore " +
          days +
          " jour(s) avant de changer ton nom d'utilisateur."
      });
    }

    const existing =
      getUserByUsername(
        username
      );

    if (
      existing &&
      existing.id !== user.id
    ) {
      return res.status(400).json({
        error:
          "Ce nom d'utilisateur est déjà utilisé."
      });
    }

    user.username =
      username;

    user.usernameChangedAt =
      Date.now();

    const result =
      publicUser(user);

    sendToUser(
      user.id,
      "user:updated",
      {
        user: result
      }
    );

    res.json({
      user: result
    });
  }
);

/*
=========================================================
AMIS
=========================================================
*/

app.get("/api/friends", (req, res) => {
  const user = requireAuth(req, res);

  if (!user) return;

  const list = [];

  for (const key of friendships.keys()) {
    const parts = key.split(":");

    if (!parts.includes(user.id)) {
      continue;
    }

    const otherId =
      parts[0] === user.id
        ? parts[1]
        : parts[0];

    const other =
      users.get(otherId);

    if (other) {
      list.push(
        publicUser(other)
      );
    }
  }

  const incomingRequests = [];

  for (const request of friendRequests.values()) {
    if (
      request.to === user.id &&
      request.status === "pending"
    ) {
      const from =
        users.get(request.from);

      if (from) {
        incomingRequests.push(
          publicUser(from)
        );
      }
    }
  }

  res.json({
    friends: list,
    incomingRequests
  });
});

app.post(
  "/api/friends/request",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const username =
      cleanUsername(
        req.body.username
      );

    const target =
      getUserByUsername(
        username
      );

    if (!target) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (target.id === user.id) {
      return res.status(400).json({
        error:
          "Tu ne peux pas t'ajouter toi-même."
      });
    }

    if (
      areFriends(
        user.id,
        target.id
      )
    ) {
      return res.status(400).json({
        error:
          "Vous êtes déjà amis."
      });
    }

    for (const request of friendRequests.values()) {
      if (
        request.from === user.id &&
        request.to === target.id &&
        request.status === "pending"
      ) {
        return res.status(400).json({
          error:
            "Une demande est déjà envoyée."
        });
      }
    }

    const request = {
      id: id(),
      from: user.id,
      to: target.id,
      status: "pending",
      createdAt:
        new Date().toISOString()
    };

    friendRequests.set(
      request.id,
      request
    );

    sendToUser(
      target.id,
      "friend:request",
      {
        from:
          publicUser(user)
      }
    );

    res.json({
      success: true
    });
  }
);

app.post(
  "/api/friends/accept",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const fromId =
      String(
        req.body.userId || ""
      );

    let requestFound = null;

    for (
      const request
      of friendRequests.values()
    ) {
      if (
        request.from === fromId &&
        request.to === user.id &&
        request.status === "pending"
      ) {
        requestFound =
          request;

        break;
      }
    }

    if (!requestFound) {
      return res.status(404).json({
        error:
          "Demande d'ami introuvable."
      });
    }

    requestFound.status =
      "accepted";

    friendships.set(
      friendshipKey(
        user.id,
        fromId
      ),
      true
    );

    sendToUser(
      fromId,
      "friend:accepted",
      {
        user:
          publicUser(user)
      }
    );

    res.json({
      success: true
    });
  }
);

/*
=========================================================
MESSAGES PRIVÉS
=========================================================
*/

app.get(
  "/api/dms/:userId",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const otherId =
      req.params.userId;

    const other =
      users.get(otherId);

    if (!other) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !areFriends(
        user.id,
        other.id
      )
    ) {
      return res.status(403).json({
        error:
          "Vous devez être amis pour discuter."
      });
    }

    const key =
      conversationKey(
        user.id,
        other.id
      );

    const messages =
      conversations.get(key) || [];

    res.json({
      messages
    });
  }
);

app.post(
  "/api/dms/:userId",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const otherId =
      req.params.userId;

    const other =
      users.get(otherId);

    if (!other) {
      return res.status(404).json({
        error:
          "Utilisateur introuvable."
      });
    }

    if (
      !areFriends(
        user.id,
        other.id
      )
    ) {
      return res.status(403).json({
        error:
          "Vous devez être amis pour envoyer un message."
      });
    }

    const content =
      String(
        req.body.content || ""
      )
      .trim()
      .slice(0, 4000);

    if (!content) {
      return res.status(400).json({
        error:
          "Le message est vide."
      });
    }

    const message = {
      id: id(),
      senderId: user.id,
      receiverId: other.id,
      content,
      createdAt:
        new Date().toISOString()
    };

    const key =
      conversationKey(
        user.id,
        other.id
      );

    if (
      !conversations.has(key)
    ) {
      conversations.set(
        key,
        []
      );
    }

    conversations
      .get(key)
      .push(message);

    sendToUser(
      other.id,
      "dm:new",
      message
    );

    sendToUser(
      user.id,
      "dm:new",
      message
    );

    res.json({
      message
    });
  }
);

/*
=========================================================
SERVEURS
=========================================================
*/

app.get(
  "/api/servers",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const result = [];

    for (
      const serverData
      of servers.values()
    ) {
      const members =
        serverMembers.get(
          serverData.id
        ) || new Set();

      if (
        members.has(user.id)
      ) {
        result.push({
          id: serverData.id,
          name: serverData.name,
          ownerId:
            serverData.ownerId,
          inviteCode:
            serverData.inviteCode,
          createdAt:
            serverData.createdAt
        });
      }
    }

    res.json({
      servers: result
    });
  }
);

app.post(
  "/api/servers",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const name =
      String(
        req.body.name || ""
      )
      .trim()
      .slice(0, 50);

    if (!name) {
      return res.status(400).json({
        error:
          "Le nom du serveur est vide."
      });
    }

    const serverData = {
      id: id(),
      name,
      ownerId: user.id,
      inviteCode:
        createInviteCode(),
      createdAt:
        new Date().toISOString()
    };

    servers.set(
      serverData.id,
      serverData
    );

    serverMembers.set(
      serverData.id,
      new Set([user.id])
    );

    res.json({
      server: serverData
    });
  }
);

app.post(
  "/api/servers/join",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const inviteCode =
      String(
        req.body.inviteCode || ""
      )
      .trim()
      .toUpperCase();

    let found = null;

    for (
      const serverData
      of servers.values()
    ) {
      if (
        serverData.inviteCode ===
        inviteCode
      ) {
        found = serverData;
        break;
      }
    }

    if (!found) {
      return res.status(404).json({
        error:
          "Code d'invitation invalide."
      });
    }

    if (
      !serverMembers.has(
        found.id
      )
    ) {
      serverMembers.set(
        found.id,
        new Set()
      );
    }

    serverMembers
      .get(found.id)
      .add(user.id);

    res.json({
      server: found
    });
  }
);

app.get(
  "/api/servers/:serverId/members",
  (req, res) => {
    const user = requireAuth(req, res);

    if (!user) return;

    const serverData =
      servers.get(
        req.params.serverId
      );

    if (!serverData) {
      return res.status(404).json({
        error:
          "Serveur introuvable."
      });
    }

    const members =
      serverMembers.get(
        serverData.id
      ) || new Set();

    if (
      !members.has(user.id)
    ) {
      return res.status(403).json({
        error:
          "Tu n'es pas membre de ce serveur."
      });
    }

    const result = [];

    for (
      const memberId
      of members
    ) {
      const member =
        users.get(memberId);

      if (member) {
        result.push(
          publicUser(member)
        );
      }
    }

    res.json({
      members: result
    });
  }
);

/*
=========================================================
SOCKET.IO
=========================================================
*/

io.on("connection", socket => {

  socket.on(
    "authenticate",
    token => {

      if (!token) {
        return;
      }

      const userId =
        sessions.get(token);

      if (!userId) {
        return;
      }

      const user =
        users.get(userId);

      if (!user) {
        return;
      }

      socket.userId =
        user.id;

      sockets.set(
        user.id,
        socket.id
      );

      socket.emit(
        "authenticated",
        {
          user:
            publicUser(user)
        }
      );
    }
  );

  socket.on(
    "server:join",
    serverId => {

      if (!socket.userId) {
        return;
      }

      const members =
        serverMembers.get(
          serverId
        );

      if (!members) {
        return;
      }

      if (
        !members.has(
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

  socket.on(
    "disconnect",
    () => {

      if (
        socket.userId &&
        sockets.get(
          socket.userId
        ) === socket.id
      ) {
        sockets.delete(
          socket.userId
        );
      }
    }
  );

});

/*
=========================================================
PAGE FALLBACK
=========================================================
*/

app.use(
  (req, res, next) => {

    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/")
    ) {
      return res.sendFile(
        path.join(
          __dirname,
          "public",
          "index.html"
        )
      );
    }

    next();
  }
);

/*
=========================================================
ERREURS
=========================================================
*/

app.use(
  (err, req, res, next) => {

    console.error(err);

    res.status(500).json({
      error:
        "Erreur interne du serveur."
    });
  }
);

/*
=========================================================
START
=========================================================
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "NovaChat lancé sur le port " +
      PORT
    );

  }
);
```
