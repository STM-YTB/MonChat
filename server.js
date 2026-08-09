const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

/*
 * Données en mémoire.
 * Pour l'instant elles sont conservées tant que le serveur tourne.
 * On ajoutera une vraie base de données ensuite.
 */

const users = new Map();
const servers = new Map();

/* Crée un identifiant court */
function id() {
    return crypto.randomBytes(8).toString("hex");
}

/* Serveur créé par défaut uniquement lorsqu'un utilisateur
   décide réellement d'en créer un. */
function createServer(name, ownerId) {
    const serverId = id();

    const newServer = {
        id: serverId,
        name: name.trim(),
        ownerId,
        members: [ownerId],

        categories: [
            {
                id: id(),
                name: "SALONS",
                channels: [
                    {
                        id: id(),
                        name: "général",
                        type: "text",
                        messages: []
                    }
                ]
            }
        ]
    };

    servers.set(serverId, newServer);

    return newServer;
}

/* Trouve l'utilisateur connecté */
function getUser(socketId) {
    return users.get(socketId);
}

/* Envoie la liste des membres d'un serveur */
function broadcastMembers(serverId) {
    const currentServer = servers.get(serverId);

    if (!currentServer) return;

    const members = currentServer.members.map(memberId => {
        for (const user of users.values()) {
            if (user.id === memberId) {
                return {
                    id: user.id,
                    username: user.username,
                    online: user.online
                };
            }
        }

        return {
            id: memberId,
            username: "Utilisateur",
            online: false
        };
    });

    io.to(serverId).emit("members:update", members);
}

/* Connexion Socket.IO */
io.on("connection", socket => {

    console.log("Nouvelle connexion :", socket.id);

    /*
     * Création d'un utilisateur local.
     * Plus tard, on remplacera cela par une vraie connexion
     * avec compte + mot de passe.
     */
    socket.on("user:login", data => {

        const username =
            typeof data?.username === "string" && data.username.trim()
                ? data.username.trim().slice(0, 32)
                : "Utilisateur";

        const user = {
            id: id(),
            socketId: socket.id,
            username,
            online: true
        };

        users.set(socket.id, user);

        socket.emit("user:ready", {
            id: user.id,
            username: user.username
        });

        console.log(`${username} est connecté`);
    });

    /*
     * Création d'un serveur
     */
    socket.on("server:create", data => {

        const user = getUser(socket.id);

        if (!user) return;

        const name =
            typeof data?.name === "string"
                ? data.name.trim().slice(0, 40)
                : "";

        if (!name) return;

        const newServer = createServer(name, user.id);

        socket.join(newServer.id);

        socket.emit("server:created", newServer);

        console.log(
            `${user.username} a créé le serveur "${newServer.name}"`
        );
    });

    /*
     * Rejoindre un serveur
     */
    socket.on("server:join", data => {

        const user = getUser(socket.id);

        if (!user) return;

        const serverId = data?.serverId;

        const currentServer = servers.get(serverId);

        if (!currentServer) {
            socket.emit("error:message", "Serveur introuvable.");
            return;
        }

        if (!currentServer.members.includes(user.id)) {
            currentServer.members.push(user.id);
        }

        socket.join(serverId);

        socket.emit("server:joined", currentServer);

        broadcastMembers(serverId);

        console.log(
            `${user.username} a rejoint "${currentServer.name}"`
        );
    });

    /*
     * Entrer dans un salon
     */
    socket.on("channel:join", data => {

        const user = getUser(socket.id);

        if (!user) return;

        const serverId = data?.serverId;
        const channelId = data?.channelId;

        const currentServer = servers.get(serverId);

        if (!currentServer) return;

        let channel = null;

        for (const category of currentServer.categories) {
            const found = category.channels.find(
                channel => channel.id === channelId
            );

            if (found) {
                channel = found;
                break;
            }
        }

        if (!channel) return;

        socket.join(`${serverId}:${channelId}`);

        socket.emit("channel:ready", {
            serverId,
            channel
        });
    });

    /*
     * Envoi d'un message
     */
    socket.on("message:send", data => {

        const user = getUser(socket.id);

        if (!user) return;

        const serverId = data?.serverId;
        const channelId = data?.channelId;

        const text =
            typeof data?.text === "string"
                ? data.text.trim()
                : "";

        if (!text) return;

        const currentServer = servers.get(serverId);

        if (!currentServer) return;

        let channel = null;

        for (const category of currentServer.categories) {

            const found = category.channels.find(
                channel => channel.id === channelId
            );

            if (found) {
                channel = found;
                break;
            }
        }

        if (!channel) return;

        const message = {
            id: id(),
            userId: user.id,
            username: user.username,
            text: text.slice(0, 2000),
            timestamp: new Date().toISOString(),
            reactions: {}
        };

        channel.messages.push(message);

        io.to(`${serverId}:${channelId}`).emit(
            "message:new",
            message
        );
    });

    /*
     * Réaction
     */
    socket.on("message:reaction", data => {

        const user = getUser(socket.id);

        if (!user) return;

        const currentServer = servers.get(data?.serverId);

        if (!currentServer) return;

        let channel = null;

        for (const category of currentServer.categories) {

            const found = category.channels.find(
                channel => channel.id === data.channelId
            );

            if (found) {
                channel = found;
                break;
            }
        }

        if (!channel) return;

        const message = channel.messages.find(
            message => message.id === data.messageId
        );

        if (!message) return;

        const emoji = data.emoji;

        if (typeof emoji !== "string") return;

        if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
        }

        if (!message.reactions[emoji].includes(user.id)) {
            message.reactions[emoji].push(user.id);
        } else {
            message.reactions[emoji] =
                message.reactions[emoji].filter(
                    id => id !== user.id
                );
        }

        io.to(`${data.serverId}:${data.channelId}`).emit(
            "message:updated",
            message
        );
    });

    /*
     * Déconnexion
     */
    socket.on("disconnect", () => {

        const user = users.get(socket.id);

        if (user) {
            console.log(`${user.username} est parti.`);
        }

        users.delete(socket.id);
    });
});

server.listen(3000, () => {

    console.log("");
    console.log("=================================");
    console.log("🚀 SERVEUR CHAT LANCÉ");
    console.log("=================================");
    console.log("");
    console.log("🌐 http://localhost:3000");
    console.log("");
});