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

let db = {
    users: {},
    servers: {},
    sessions: {},
    messages: {},
    friendships: {}
};

function saveDatabase() {
    try {
        fs.writeFileSync(
            DB_FILE,
            JSON.stringify(db, null, 2),
            "utf8"
        );
    } catch (error) {
        console.error("Erreur sauvegarde database:", error);
    }
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            saveDatabase();
            return;
        }

        const content = fs.readFileSync(DB_FILE, "utf8");

        if (!content.trim()) {
            saveDatabase();
            return;
        }

        const parsed = JSON.parse(content);

        db = {
            users: parsed.users || {},
            servers: parsed.servers || {},
            sessions: parsed.sessions || {},
            messages: parsed.messages || {},
            friendships: parsed.friendships || {}
        };
    } catch (error) {
        console.error("Erreur chargement database:", error);
    }
}

loadDatabase();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.static(path.join(__dirname, "public")));

function id() {
    return crypto.randomUUID();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto
        .createHash("sha256")
        .update(salt + password)
        .digest("hex");

    return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
    if (!stored || !stored.includes(":")) {
        return false;
    }

    const [salt, originalHash] = stored.split(":");

    const hash = crypto
        .createHash("sha256")
        .update(salt + password)
        .digest("hex");

    return hash === originalHash;
}

function cleanUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatar: user.avatar || null,
        createdAt: user.createdAt
    };
}

function getUserByUsername(username) {
    const lower = username.toLowerCase();

    return Object.values(db.users).find(
        user => user.username.toLowerCase() === lower
    );
}

function getUserFromToken(token) {
    if (!token) return null;

    const session = db.sessions[token];

    if (!session) return null;

    return db.users[session.userId] || null;
}

function requireUser(req, res) {
    const user = getUserFromToken(req.headers.authorization);

    if (!user) {
        res.status(401).json({
            error: "Non connecté"
        });

        return null;
    }

    return user;
}

function createDefaultServer(ownerId, name) {
    const serverId = id();

    db.servers[serverId] = {
        id: serverId,
        name: name || "Mon serveur",
        icon: null,
        ownerId,
        members: [ownerId],
        channels: [
            {
                id: id(),
                name: "general",
                type: "text"
            },
            {
                id: id(),
                name: "general",
                type: "voice"
            }
        ],
        createdAt: Date.now()
    };

    return db.servers[serverId];
}

function publicServer(serverData) {
    return {
        id: serverData.id,
        name: serverData.name,
        icon: serverData.icon || null,
        ownerId: serverData.ownerId,
        members: serverData.members,
        channels: serverData.channels
    };
}

/* =========================
   API AUTH
========================= */

app.post("/api/register", (req, res) => {
    try {
        const {
            email,
            password,
            username,
            displayName
        } = req.body;

        if (!email || !password || !username) {
            return res.status(400).json({
                error: "Email, mot de passe et nom d'utilisateur sont obligatoires."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Le mot de passe doit contenir au moins 6 caractères."
            });
        }

        if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
            return res.status(400).json({
                error: "Nom d'utilisateur invalide."
            });
        }

        if (getUserByUsername(username)) {
            return res.status(400).json({
                error: "Ce nom d'utilisateur existe déjà."
            });
        }

        const emailExists = Object.values(db.users).some(
            user => user.email.toLowerCase() === email.toLowerCase()
        );

        if (emailExists) {
            return res.status(400).json({
                error: "Cette adresse email est déjà utilisée."
            });
        }

        const userId = id();

        const user = {
            id: userId,
            email: email.toLowerCase(),
            username,
            displayName: displayName || username,
            password: hashPassword(password),
            avatar: null,
            createdAt: Date.now()
        };

        db.users[userId] = user;
        db.friendships[userId] = [];

        createDefaultServer(userId, "Mon serveur");

        const token = id();

        db.sessions[token] = {
            userId,
            createdAt: Date.now()
        };

        saveDatabase();

        res.json({
            success: true,
            token,
            user: cleanUser(user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Erreur lors de la création du compte."
        });
    }
});

app.post("/api/login", (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: "Email et mot de passe obligatoires."
            });
        }

        const user = Object.values(db.users).find(
            item => item.email.toLowerCase() === email.toLowerCase()
        );

        if (!user || !checkPassword(password, user.password)) {
            return res.status(401).json({
                error: "Email ou mot de passe incorrect."
            });
        }

        const token = id();

        db.sessions[token] = {
            userId: user.id,
            createdAt: Date.now()
        };

        saveDatabase();

        res.json({
            success: true,
            token,
            user: cleanUser(user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Erreur lors de la connexion."
        });
    }
});

app.get("/api/me", (req, res) => {
    const user = getUserFromToken(req.headers.authorization);

    if (!user) {
        return res.status(401).json({
            error: "Non connecté"
        });
    }

    res.json({
        user: cleanUser(user)
    });
});

app.post("/api/logout", (req, res) => {
    const token = req.headers.authorization;

    if (token) {
        delete db.sessions[token];
        saveDatabase();
    }

    res.json({
        success: true
    });
});

/* =========================
   PROFIL
========================= */

app.post("/api/profile", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const {
        displayName,
        avatar
    } = req.body;

    if (displayName !== undefined) {
        const value = String(displayName).trim();

        if (!value || value.length > 32) {
            return res.status(400).json({
                error: "Nom d'affichage invalide."
            });
        }

        user.displayName = value;
    }

    if (avatar !== undefined) {
        if (avatar !== null && typeof avatar !== "string") {
            return res.status(400).json({
                error: "Avatar invalide."
            });
        }

        user.avatar = avatar;
    }

    saveDatabase();

    io.emit("user:updated", cleanUser(user));

    res.json({
        success: true,
        user: cleanUser(user)
    });
});

/* =========================
   AMIS
========================= */

app.get("/api/friends", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const ids = db.friendships[user.id] || [];

    const friends = ids
        .map(friendId => db.users[friendId])
        .filter(Boolean)
        .map(cleanUser);

    res.json({
        friends
    });
});

app.post("/api/friends/add", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const username = String(req.body.username || "").trim();

    if (!username) {
        return res.status(400).json({
            error: "Entre un nom d'utilisateur."
        });
    }

    const target = getUserByUsername(username);

    if (!target) {
        return res.status(404).json({
            error: "Utilisateur introuvable."
        });
    }

    if (target.id === user.id) {
        return res.status(400).json({
            error: "Tu ne peux pas t'ajouter toi-même."
        });
    }

    if (!db.friendships[user.id]) {
        db.friendships[user.id] = [];
    }

    if (!db.friendships[target.id]) {
        db.friendships[target.id] = [];
    }

    if (!db.friendships[user.id].includes(target.id)) {
        db.friendships[user.id].push(target.id);
    }

    if (!db.friendships[target.id].includes(user.id)) {
        db.friendships[target.id].push(user.id);
    }

    saveDatabase();

    res.json({
        success: true,
        friend: cleanUser(target)
    });
});

/* =========================
   SERVEURS
========================= */

app.get("/api/servers", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const servers = Object.values(db.servers)
        .filter(serverData =>
            serverData.members.includes(user.id)
        )
        .map(publicServer);

    res.json({
        servers
    });
});

app.post("/api/servers", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const name = String(req.body.name || "").trim();

    if (!name) {
        return res.status(400).json({
            error: "Nom du serveur obligatoire."
        });
    }

    if (name.length > 50) {
        return res.status(400).json({
            error: "Nom du serveur trop long."
        });
    }

    const serverData = createDefaultServer(user.id, name);

    saveDatabase();

    res.json({
        success: true,
        server: publicServer(serverData)
    });
});

app.post("/api/servers/join", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const serverId = String(req.body.serverId || "");

    const serverData = db.servers[serverId];

    if (!serverData) {
        return res.status(404).json({
            error: "Serveur introuvable."
        });
    }

    if (!serverData.members.includes(user.id)) {
        serverData.members.push(user.id);
        saveDatabase();
    }

    res.json({
        success: true,
        server: publicServer(serverData)
    });
});

app.post("/api/servers/:serverId/channels", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const serverData = db.servers[req.params.serverId];

    if (!serverData) {
        return res.status(404).json({
            error: "Serveur introuvable."
        });
    }

    if (!serverData.members.includes(user.id)) {
        return res.status(403).json({
            error: "Tu n'es pas membre de ce serveur."
        });
    }

    if (serverData.ownerId !== user.id) {
        return res.status(403).json({
            error: "Seul le propriétaire peut créer un salon."
        });
    }

    const name = String(req.body.name || "").trim();
    const type = req.body.type === "voice" ? "voice" : "text";

    if (!name) {
        return res.status(400).json({
            error: "Nom du salon obligatoire."
        });
    }

    const channel = {
        id: id(),
        name,
        type
    };

    serverData.channels.push(channel);

    saveDatabase();

    res.json({
        success: true,
        channel
    });
});

/* =========================
   MESSAGES
========================= */

app.get("/api/dm/:userId", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const targetId = req.params.userId;

    if (!db.users[targetId]) {
        return res.status(404).json({
            error: "Utilisateur introuvable."
        });
    }

    const key = [user.id, targetId].sort().join("_");

    res.json({
        messages: db.messages[key] || []
    });
});

app.post("/api/dm/:userId", (req, res) => {
    const user = requireUser(req, res);

    if (!user) return;

    const targetId = req.params.userId;
    const content = String(req.body.content || "").trim();

    if (!db.users[targetId]) {
        return res.status(404).json({
            error: "Utilisateur introuvable."
        });
    }

    if (!content) {
        return res.status(400).json({
            error: "Message vide."
        });
    }

    if (content.length > 2000) {
        return res.status(400).json({
            error: "Message trop long."
        });
    }

    const key = [user.id, targetId].sort().join("_");

    if (!db.messages[key]) {
        db.messages[key] = [];
    }

    const message = {
        id: id(),
        from: user.id,
        to: targetId,
        content,
        createdAt: Date.now()
    };

    db.messages[key].push(message);

    saveDatabase();

    io.to(`user:${targetId}`).emit("dm:new", message);
    io.to(`user:${user.id}`).emit("dm:new", message);

    res.json({
        success: true,
        message
    });
});

/* =========================
   SOCKET.IO
========================= */

const onlineUsers = new Map();

io.on("connection", socket => {
    console.log("Connexion Socket.IO:", socket.id);

    socket.on("auth", token => {
        const user = getUserFromToken(token);

        if (!user) {
            socket.emit("auth:error");
            return;
        }

        socket.userId = user.id;
        socket.join(`user:${user.id}`);

        onlineUsers.set(user.id, socket.id);

        io.emit("presence:update", {
            userId: user.id,
            online: true
        });
    });

    /* DM */

    socket.on("dm:send", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const content = String(data?.content || "").trim();

        if (!targetId || !content) return;

        const user = db.users[socket.userId];
        const target = db.users[targetId];

        if (!user || !target) return;

        const key = [user.id, target.id].sort().join("_");

        if (!db.messages[key]) {
            db.messages[key] = [];
        }

        const message = {
            id: id(),
            from: user.id,
            to: target.id,
            content,
            createdAt: Date.now()
        };

        db.messages[key].push(message);
        saveDatabase();

        io.to(`user:${user.id}`).emit("dm:new", message);

        io.to(`user:${target.id}`).emit("dm:new", message);
    });

    /* =====================
       WEBRTC CALL SIGNALING
    ===================== */

    socket.on("call:request", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");

        if (!targetId) return;

        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) {
            socket.emit("call:unavailable", {
                targetId
            });

            return;
        }

        io.to(targetSocket).emit("call:incoming", {
            fromUser: cleanUser(db.users[socket.userId]),
            callId: data.callId || id()
        });
    });

    socket.on("call:accept", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("call:accepted", {
            fromUser: cleanUser(db.users[socket.userId])
        });
    });

    socket.on("call:reject", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("call:rejected", {
            fromUser: cleanUser(db.users[socket.userId])
        });
    });

    socket.on("call:end", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("call:ended", {
            fromUser: cleanUser(db.users[socket.userId])
        });
    });

    /* WebRTC offer */

    socket.on("webrtc:offer", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("webrtc:offer", {
            fromUserId: socket.userId,
            offer: data.offer
        });
    });

    /* WebRTC answer */

    socket.on("webrtc:answer", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("webrtc:answer", {
            fromUserId: socket.userId,
            answer: data.answer
        });
    });

    /* ICE */

    socket.on("webrtc:ice", data => {
        if (!socket.userId) return;

        const targetId = String(data?.targetId || "");
        const targetSocket = onlineUsers.get(targetId);

        if (!targetSocket) return;

        io.to(targetSocket).emit("webrtc:ice", {
            fromUserId: socket.userId,
            candidate: data.candidate
        });
    });

    /* =====================
       VOICE CHANNEL
    ===================== */

    socket.on("voice:join", data => {
        if (!socket.userId) return;

        const serverId = String(data?.serverId || "");
        const channelId = String(data?.channelId || "");

        const serverData = db.servers[serverId];

        if (!serverData) return;

        if (!serverData.members.includes(socket.userId)) {
            return;
        }

        const channel = serverData.channels.find(
            item => item.id === channelId && item.type === "voice"
        );

        if (!channel) return;

        socket.join(`voice:${channelId}`);

        socket.voiceChannel = channelId;
        socket.voiceServer = serverId;

        const user = cleanUser(db.users[socket.userId]);

        socket.to(`voice:${channelId}`).emit(
            "voice:user-joined",
            user
        );

        const room = io.sockets.adapter.rooms.get(
            `voice:${channelId}`
        );

        const users = [];

        if (room) {
            for (const socketId of room) {
                const otherSocket = io.sockets.sockets.get(socketId);

                if (
                    otherSocket &&
                    otherSocket.userId &&
                    otherSocket.userId !== socket.userId
                ) {
                    const otherUser = db.users[otherSocket.userId];

                    if (otherUser) {
                        users.push(cleanUser(otherUser));
                    }
                }
            }
        }

        socket.emit("voice:users", users);
    });

    socket.on("voice:leave", () => {
        leaveVoice(socket);
    });

    socket.on("voice:signal", data => {
        if (!socket.userId) return;

        const targetSocketId = String(data?.targetSocketId || "");

        if (!targetSocketId) return;

        const targetSocket = io.sockets.sockets.get(
            targetSocketId
        );

        if (!targetSocket) return;

        targetSocket.emit("voice:signal", {
            fromSocketId: socket.id,
            data: data.data
        });
    });

    socket.on("disconnect", () => {
        if (socket.userId) {
            if (socket.voiceChannel) {
                leaveVoice(socket);
            }

            onlineUsers.delete(socket.userId);

            io.emit("presence:update", {
                userId: socket.userId,
                online: false
            });
        }

        console.log("Déconnexion Socket.IO:", socket.id);
    });
});

function leaveVoice(socket) {
    const channelId = socket.voiceChannel;

    if (!channelId) return;

    const user = db.users[socket.userId];

    socket.leave(`voice:${channelId}`);

    socket.to(`voice:${channelId}`).emit(
        "voice:user-left",
        user ? cleanUser(user) : {
            id: socket.userId
        }
    );

    socket.voiceChannel = null;
    socket.voiceServer = null;
}

/*
 * Express 5 :
 * NE PAS utiliser app.get("*").
 *
 * Cette route fonctionne avec Express 5.
 */
app.use((req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`NovaChat démarré sur le port ${PORT}`);
});