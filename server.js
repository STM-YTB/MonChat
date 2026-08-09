const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| DONNÉES DE L'APPLICATION
|--------------------------------------------------------------------------
| Pour cette V2, les données sont conservées en mémoire.
| Cela permet de tester facilement l'application.
|
| Attention : sur Render, un redémarrage du serveur effacera ces données.
| Une prochaine V3 pourra utiliser une vraie base de données.
|--------------------------------------------------------------------------
*/

const users = new Map();
const sockets = new Map();

const servers = new Map([
    [
        "welcome",
        {
            id: "welcome",
            name: "Nova Community",
            icon: "N",
            owner: "system",
            members: new Set(),
            channels: [
                {
                    id: "general",
                    name: "général",
                    type: "text"
                },
                {
                    id: "entraide",
                    name: "entraide",
                    type: "text"
                },
                {
                    id: "gaming",
                    name: "gaming",
                    type: "text"
                },
                {
                    id: "vocal",
                    name: "Salon vocal",
                    type: "voice"
                }
            ],
            messages: {}
        }
    ]
]);

const friendships = new Map();
const friendRequests = new Map();
const privateMessages = new Map();

/* ----------------------------------------------------------------------- */

function id(prefix = "") {
    return prefix + crypto.randomBytes(8).toString("hex");
}

function cleanName(name) {
    return String(name || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 24);
}

function cleanText(text) {
    return String(text || "").slice(0, 3000);
}

function publicUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        status: user.status || "En ligne",
        avatar: user.avatar,
        bio: user.bio || "",
        role: user.role || "Membre",
        online: user.online !== false
    };
}

function getOnlineUsers() {
    return [...users.values()]
        .filter(user => user.online)
        .map(publicUser);
}

function getServer(serverId) {
    return servers.get(serverId);
}

function emitPresence() {
    io.emit("presence:update", getOnlineUsers());
}

function sendServerList(socket) {
    const result = [...servers.values()].map(s => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        owner: s.owner,
        channels: s.channels.map(c => ({
            id: c.id,
            name: c.name,
            type: c.type
        })),
        memberCount: s.members.size
    }));

    socket.emit("servers:list", result);
}

function sendMembers(serverId) {
    const s = getServer(serverId);
    if (!s) return;

    const members = [...s.members]
        .map(uid => users.get(uid))
        .filter(Boolean)
        .map(publicUser);

    io.to(`server:${serverId}`).emit("server:members", {
        serverId,
        members
    });
}

/* -----------------------------------------------------------------------
   API
------------------------------------------------------------------------ */

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        users: [...users.values()].filter(u => u.online).length,
        servers: servers.size
    });
});

/* -----------------------------------------------------------------------
   SOCKET.IO
------------------------------------------------------------------------ */

io.on("connection", socket => {

    console.log("Connexion :", socket.id);

    /*
    |--------------------------------------------------------------------------
    | CONNEXION UTILISATEUR
    |--------------------------------------------------------------------------
    */

    socket.on("user:login", data => {
        const username = cleanName(data?.username);

        if (!username) {
            socket.emit("user:error", "Choisis un nom d'utilisateur.");
            return;
        }

        let user = [...users.values()].find(
            u => u.username.toLowerCase() === username.toLowerCase()
        );

        if (!user) {
            user = {
                id: id("u_"),
                username,
                avatar: username.charAt(0).toUpperCase(),
                status: "En ligne",
                bio: "Bienvenue sur Nova.",
                role: "Membre",
                online: true,
                socketId: socket.id
            };

            users.set(user.id, user);
        } else {
            user.online = true;
            user.socketId = socket.id;
        }

        sockets.set(socket.id, user.id);

        socket.data.userId = user.id;

        socket.emit("user:ready", publicUser(user));

        sendServerList(socket);

        const joinedServers = [];

        for (const s of servers.values()) {
            if (s.members.has(user.id)) {
                joinedServers.push(s.id);
            }
        }

        /*
        Si nouvel utilisateur, on l'ajoute au serveur d'accueil.
        */
        if (joinedServers.length === 0) {
            const welcome = getServer("welcome");

            if (welcome) {
                welcome.members.add(user.id);
                joinedServers.push(welcome.id);
            }
        }

        for (const serverId of joinedServers) {
            socket.join(`server:${serverId}`);
        }

        socket.emit("user:servers", joinedServers);

        emitPresence();

        for (const serverId of joinedServers) {
            sendMembers(serverId);
        }

        console.log(`${username} est connecté`);
    });

    /*
    |--------------------------------------------------------------------------
    | PROFIL
    |--------------------------------------------------------------------------
    */

    socket.on("profile:update", data => {
        const user = users.get(socket.data.userId);
        if (!user) return;

        if (data.username) {
            const username = cleanName(data.username);

            const exists = [...users.values()].some(
                u =>
                    u.id !== user.id &&
                    u.username.toLowerCase() === username.toLowerCase()
            );

            if (exists) {
                socket.emit("profile:error", "Ce pseudo est déjà utilisé.");
                return;
            }

            if (username) {
                user.username = username;
                user.avatar = username.charAt(0).toUpperCase();
            }
        }

        if (typeof data.bio === "string") {
            user.bio = data.bio.slice(0, 160);
        }

        if (typeof data.status === "string") {
            user.status = data.status.slice(0, 60);
        }

        socket.emit("profile:updated", publicUser(user));
        emitPresence();
    });

    /*
    |--------------------------------------------------------------------------
    | SERVEURS
    |--------------------------------------------------------------------------
    */

    socket.on("server:create", data => {
        const user = users.get(socket.data.userId);
        if (!user) return;

        const name = cleanName(data?.name);

        if (!name) {
            socket.emit("app:error", "Donne un nom à ton serveur.");
            return;
        }

        const serverId = id("server_");

        const newServer = {
            id: serverId,
            name,
            icon: name.charAt(0).toUpperCase(),
            owner: user.id,
            members: new Set([user.id]),
            channels: [
                {
                    id: id("channel_"),
                    name: "général",
                    type: "text"
                },
                {
                    id: id("channel_"),
                    name: "Vocal",
                    type: "voice"
                }
            ],
            messages: {}
        };

        servers.set(serverId, newServer);

        socket.join(`server:${serverId}`);

        socket.emit("server:created", {
            id: serverId,
            name: newServer.name,
            icon: newServer.icon
        });

        sendServerList(socket);
        sendMembers(serverId);
    });

    socket.on("server:join", data => {
        const user = users.get(socket.data.userId);
        if (!user) return;

        const serverId = data?.serverId;
        const s = getServer(serverId);

        if (!s) {
            socket.emit("app:error", "Serveur introuvable.");
            return;
        }

        s.members.add(user.id);
        socket.join(`server:${serverId}`);

        socket.emit("server:joined", {
            serverId
        });

        sendServerList(socket);
        sendMembers(serverId);
    });

    socket.on("server:invite", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s) return;

        const invite = {
            code: crypto
                .randomBytes(4)
                .toString("hex")
                .toUpperCase(),
            serverId: s.id,
            serverName: s.name,
            from: user.username
        };

        socket.emit("server:inviteCreated", invite);
    });

    socket.on("server:joinInvite", data => {
        const user = users.get(socket.data.userId);
        if (!user) return;

        const code = String(data?.code || "").trim().toUpperCase();

        /*
        Dans cette version, le code est généré côté client/serveur
        et envoyé à l'utilisateur.
        Pour une V3, les invitations seront stockées.
        */

        socket.emit(
            "app:info",
            "Les codes d'invitation temporaires seront améliorés avec une base de données dans la prochaine version."
        );
    });

    /*
    |--------------------------------------------------------------------------
    | SALONS
    |--------------------------------------------------------------------------
    */

    socket.on("channel:create", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s) return;

        if (s.owner !== user.id) {
            socket.emit("app:error", "Seul le propriétaire peut créer un salon.");
            return;
        }

        const name = cleanName(data?.name);

        if (!name) return;

        const channel = {
            id: id("channel_"),
            name,
            type: data?.type === "voice" ? "voice" : "text"
        };

        s.channels.push(channel);

        io.to(`server:${s.id}`).emit("channel:created", {
            serverId: s.id,
            channel
        });

        sendServerList(socket);
    });

    /*
    |--------------------------------------------------------------------------
    | MESSAGES
    |--------------------------------------------------------------------------
    */

    socket.on("channel:join", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s || !s.members.has(user.id)) return;

        const channel = s.channels.find(c => c.id === data.channelId);

        if (!channel) return;

        if (!s.messages[channel.id]) {
            s.messages[channel.id] = [];
        }

        socket.emit("messages:list", {
            serverId: s.id,
            channelId: channel.id,
            messages: s.messages[channel.id]
        });
    });

    socket.on("message:send", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s || !s.members.has(user.id)) return;

        const channel = s.channels.find(c => c.id === data.channelId);

        if (!channel || channel.type !== "text") return;

        const content = cleanText(data.content);

        if (!content.trim()) return;

        if (!s.messages[channel.id]) {
            s.messages[channel.id] = [];
        }

        const message = {
            id: id("msg_"),
            userId: user.id,
            username: user.username,
            avatar: user.avatar,
            content,
            timestamp: Date.now(),
            reactions: {}
        };

        s.messages[channel.id].push(message);

        if (s.messages[channel.id].length > 300) {
            s.messages[channel.id].shift();
        }

        io.to(`server:${s.id}`).emit("message:new", {
            serverId: s.id,
            channelId: channel.id,
            message
        });
    });

    socket.on("message:edit", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s) return;

        const list = s.messages[data.channelId];

        if (!list) return;

        const message = list.find(m => m.id === data.messageId);

        if (!message || message.userId !== user.id) return;

        const content = cleanText(data.content);

        if (!content.trim()) return;

        message.content = content;
        message.edited = true;

        io.to(`server:${s.id}`).emit("message:updated", {
            serverId: s.id,
            channelId: data.channelId,
            message
        });
    });

    socket.on("message:delete", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s) return;

        const list = s.messages[data.channelId];

        if (!list) return;

        const index = list.findIndex(m => m.id === data.messageId);

        if (index === -1) return;

        if (list[index].userId !== user.id) return;

        list.splice(index, 1);

        io.to(`server:${s.id}`).emit("message:deleted", {
            serverId: s.id,
            channelId: data.channelId,
            messageId: data.messageId
        });
    });

    socket.on("message:reaction", data => {
        const user = users.get(socket.data.userId);
        const s = getServer(data?.serverId);

        if (!user || !s) return;

        const list = s.messages[data.channelId];
        if (!list) return;

        const message = list.find(m => m.id === data.messageId);
        if (!message) return;

        const emoji = String(data.emoji || "❤️");

        if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
        }

        const usersReacted = message.reactions[emoji];

        const index = usersReacted.indexOf(user.id);

        if (index === -1) {
            usersReacted.push(user.id);
        } else {
            usersReacted.splice(index, 1);
        }

        if (usersReacted.length === 0) {
            delete message.reactions[emoji];
        }

        io.to(`server:${s.id}`).emit("message:reactionUpdated", {
            serverId: s.id,
            channelId: data.channelId,
            messageId: data.messageId,
            reactions: message.reactions
        });
    });

    /*
    |--------------------------------------------------------------------------
    | AMIS
    |--------------------------------------------------------------------------
    */

    socket.on("friends:search", data => {
        const query = String(data?.query || "")
            .trim()
            .toLowerCase();

        const currentUser = users.get(socket.data.userId);

        if (!currentUser || !query) {
            socket.emit("friends:searchResults", []);
            return;
        }

        const results = [...users.values()]
            .filter(
                u =>
                    u.id !== currentUser.id &&
                    u.username.toLowerCase().includes(query)
            )
            .slice(0, 20)
            .map(publicUser);

        socket.emit("friends:searchResults", results);
    });

    socket.on("friends:request", data => {
        const from = users.get(socket.data.userId);
        const to = users.get(data?.userId);

        if (!from || !to || from.id === to.id) return;

        if (!friendRequests.has(to.id)) {
            friendRequests.set(to.id, []);
        }

        const requests = friendRequests.get(to.id);

        if (
            requests.some(r => r.from === from.id) ||
            isFriend(from.id, to.id)
        ) {
            return;
        }

        requests.push({
            id: id("request_"),
            from: from.id,
            fromUsername: from.username,
            timestamp: Date.now()
        });

        const targetSocket = to.socketId;

        if (targetSocket) {
            io.to(targetSocket).emit("friends:requestReceived", {
                from: publicUser(from)
            });
        }

        socket.emit("friends:requestSent", {
            userId: to.id
        });
    });

    socket.on("friends:requests", () => {
        const user = users.get(socket.data.userId);
        if (!user) return;

        const requests = friendRequests.get(user.id) || [];

        socket.emit(
            "friends:requests",
            requests.map(r => ({
                ...r,
                user: publicUser(users.get(r.from))
            }))
        );
    });

    socket.on("friends:accept", data => {
        const user = users.get(socket.data.userId);
        const request = friendRequests.get(user?.id)?.find(
            r => r.id === data?.requestId
        );

        if (!user || !request) return;

        const other = users.get(request.from);

        if (!other) return;

        addFriend(user.id, other.id);

        const list = friendRequests.get(user.id) || [];

        friendRequests.set(
            user.id,
            list.filter(r => r.id !== request.id)
        );

        socket.emit("friends:accepted", {
            user: publicUser(other)
        });

        if (other.socketId) {
            io.to(other.socketId).emit("friends:accepted", {
                user: publicUser(user)
            });
        }

        emitFriendLists(user.id, other.id);
    });

    socket.on("friends:remove", data => {
        const user = users.get(socket.data.userId);

        if (!user) return;

        removeFriend(user.id, data?.userId);

        emitFriendLists(user.id, data?.userId);
    });

    /*
    |--------------------------------------------------------------------------
    | MESSAGES PRIVÉS
    |--------------------------------------------------------------------------
    */

    socket.on("dm:send", data => {
        const from = users.get(socket.data.userId);
        const to = users.get(data?.userId);

        if (!from || !to) return;

        const content = cleanText(data.content);

        if (!content.trim()) return;

        const key = dmKey(from.id, to.id);

        if (!privateMessages.has(key)) {
            privateMessages.set(key, []);
        }

        const message = {
            id: id("dm_"),
            from: from.id,
            to: to.id,
            username: from.username,
            content,
            timestamp: Date.now()
        };

        privateMessages.get(key).push(message);

        socket.emit("dm:new", message);

        if (to.socketId) {
            io.to(to.socketId).emit("dm:new", message);
        }
    });

    socket.on("dm:history", data => {
        const user = users.get(socket.data.userId);
        const other = users.get(data?.userId);

        if (!user || !other) return;

        const key = dmKey(user.id, other.id);

        socket.emit("dm:history", {
            userId: other.id,
            messages: privateMessages.get(key) || []
        });
    });

    /*
    |--------------------------------------------------------------------------
    | WEBRTC
    |--------------------------------------------------------------------------
    |
    | Le serveur ne transporte PAS la vidéo.
    | Il sert uniquement de signalisation.
    |--------------------------------------------------------------------------
    */

    socket.on("call:join", data => {
        const user = users.get(socket.data.userId);

        if (!user) return;

        const room = String(data?.room || "");

        if (!room) return;

        socket.join(`call:${room}`);

        socket.to(`call:${room}`).emit("call:userJoined", {
            user: publicUser(user),
            socketId: socket.id
        });

        const roomSockets = io.sockets.adapter.rooms.get(`call:${room}`);

        const existing = [];

        if (roomSockets) {
            for (const socketId of roomSockets) {
                if (socketId === socket.id) continue;

                const uid = sockets.get(socketId);

                if (uid) {
                    existing.push({
                        socketId,
                        user: publicUser(users.get(uid))
                    });
                }
            }
        }

        socket.emit("call:existingUsers", existing);
    });

    socket.on("call:offer", data => {
        if (!data?.target) return;

        io.to(data.target).emit("call:offer", {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on("call:answer", data => {
        if (!data?.target) return;

        io.to(data.target).emit("call:answer", {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on("call:ice", data => {
        if (!data?.target) return;

        io.to(data.target).emit("call:ice", {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on("call:leave", data => {
        const room = String(data?.room || "");

        if (room) {
            socket.leave(`call:${room}`);

            socket.to(`call:${room}`).emit("call:userLeft", {
                socketId: socket.id
            });
        }
    });

    /*
    |--------------------------------------------------------------------------
    | DÉCONNEXION
    |--------------------------------------------------------------------------
    */

    socket.on("disconnect", () => {
        const userId = sockets.get(socket.id);

        if (userId) {
            const user = users.get(userId);

            if (user) {
                user.online = false;
                user.socketId = null;
            }

            sockets.delete(socket.id);

            emitPresence();

            for (const s of servers.values()) {
                if (s.members.has(userId)) {
                    sendMembers(s.id);
                }
            }

            console.log(
                `${user?.username || "Utilisateur"} est déconnecté`
            );
        }
    });
});

/* -----------------------------------------------------------------------
   HELPERS AMIS
------------------------------------------------------------------------ */

function friendshipKey(a, b) {
    return [a, b].sort().join(":");
}

function isFriend(a, b) {
    return friendships.has(friendshipKey(a, b));
}

function addFriend(a, b) {
    friendships.set(friendshipKey(a, b), true);
}

function removeFriend(a, b) {
    friendships.delete(friendshipKey(a, b));
}

function getFriends(userId) {
    const result = [];

    for (const key of friendships.keys()) {
        const [a, b] = key.split(":");

        if (a === userId) {
            const user = users.get(b);
            if (user) result.push(publicUser(user));
        }

        if (b === userId) {
            const user = users.get(a);
            if (user) result.push(publicUser(user));
        }
    }

    return result;
}

function emitFriendLists(a, b) {
    const userA = users.get(a);
    const userB = users.get(b);

    if (userA?.socketId) {
        io.to(userA.socketId).emit(
            "friends:list",
            getFriends(a)
        );
    }

    if (userB?.socketId) {
        io.to(userB.socketId).emit(
            "friends:list",
            getFriends(b)
        );
    }
}

function dmKey(a, b) {
    return [a, b].sort().join(":");
}

/* ----------------------------------------------------------------------- */

server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("====================================");
    console.log("       NOVACHAT SERVER ONLINE");
    console.log("====================================");
    console.log(`Port : ${PORT}`);
    console.log("");
});