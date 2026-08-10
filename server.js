const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ===============================
// FICHIERS DU SITE
// ===============================

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===============================
// DONNÉES EN MÉMOIRE
// ===============================

const clients = new Map();
const messages = new Map();

messages.set("general", [
    {
        id: "m1",
        channel: "general",
        username: "NovaChat",
        content: "Bienvenue sur NovaChat ! 🚀",
        time: Date.now() - 3600000
    },
    {
        id: "m2",
        channel: "general",
        username: "NovaChat",
        content: "Rejoins un salon vocal pour tester le micro 🎙️",
        time: Date.now() - 1800000
    }
]);

// ===============================
// OUTILS
// ===============================

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

function getUsers() {
    return [...clients.values()].map(client => ({
        id: client.id,
        username: client.username,
        avatar: client.username.charAt(0).toUpperCase(),
        status: "En ligne",
        voiceRoom: client.voiceRoom
    }));
}

function leaveVoice(client) {
    if (!client || !client.voiceRoom) {
        return;
    }

    const room = client.voiceRoom;

    client.voiceRoom = null;

    broadcast({
        type: "voice-user-left",
        room: room,
        userId: client.id
    });
}

// ===============================
// WEBSOCKET
// ===============================

wss.on("connection", ws => {

    let client = null;

    console.log("Nouvelle connexion WebSocket");

    ws.on("message", raw => {

        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch (error) {
            console.log("Message invalide reçu.");
            return;
        }

        // ===============================
        // CONNEXION
        // ===============================

        if (data.type === "login") {

            const username =
                String(data.username || "Utilisateur")
                    .trim()
                    .slice(0, 24) || "Utilisateur";

            const id =
                "u-" +
                Math.random()
                    .toString(36)
                    .substring(2, 10);

            client = {
                ws,
                id,
                username,
                voiceRoom: null
            };

            clients.set(id, client);

            send(ws, {
                type: "login-success",
                user: {
                    id,
                    username,
                    avatar: username.charAt(0).toUpperCase(),
                    status: "En ligne"
                }
            });

            send(ws, {
                type: "history",
                channel: "general",
                messages: messages.get("general") || []
            });

            broadcast({
                type: "presence",
                users: getUsers()
            });

            console.log(username + " vient de se connecter.");

            return;
        }

        if (!client) {
            return;
        }

        // ===============================
        // HISTORIQUE DES MESSAGES
        // ===============================

        if (data.type === "history") {

            const channel =
                String(data.channel || "general");

            send(ws, {
                type: "history",
                channel,
                messages: messages.get(channel) || []
            });

            return;
        }

        // ===============================
        // ENVOYER UN MESSAGE
        // ===============================

        if (data.type === "send-message") {

            const channel =
                String(data.channel || "general");

            const content =
                String(data.content || "")
                    .trim()
                    .slice(0, 4000);

            if (!content) {
                return;
            }

            if (!messages.has(channel)) {
                messages.set(channel, []);
            }

            const message = {
                id:
                    "m-" +
                    Date.now() +
                    "-" +
                    Math.random()
                        .toString(36)
                        .substring(2, 7),

                channel,

                userId: client.id,

                username: client.username,

                content,

                time: Date.now()
            };

            messages.get(channel).push(message);

            broadcast({
                type: "new-message",
                message
            });

            return;
        }

        // ===============================
        // ENTRER DANS UN VOCAL
        // ===============================

        if (data.type === "voice-join") {

            const room =
                String(data.room || "general");

            if (client.voiceRoom) {
                leaveVoice(client);
            }

            client.voiceRoom = room;

            const peers = [...clients.values()]
                .filter(other =>
                    other.id !== client.id &&
                    other.voiceRoom === room
                )
                .map(other => ({
                    id: other.id,
                    username: other.username
                }));

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

            console.log(
                client.username +
                " rejoint le vocal " +
                room
            );

            return;
        }

        // ===============================
        // QUITTER LE VOCAL
        // ===============================

        if (data.type === "voice-leave") {

            leaveVoice(client);

            return;
        }

        // ===============================
        // WEBRTC
        // ===============================

        if (
            data.type === "webrtc-offer" ||
            data.type === "webrtc-answer" ||
            data.type === "webrtc-ice"
        ) {

            const targetId =
                String(data.targetId || "");

            const target =
                clients.get(targetId);

            if (!target) {
                return;
            }

            send(target.ws, {
                ...data,
                senderId: client.id,
                senderName: client.username
            });

            return;
        }

    });

    // ===============================
    // DÉCONNEXION
    // ===============================

    ws.on("close", () => {

        if (!client) {
            return;
        }

        console.log(
            client.username +
            " vient de se déconnecter."
        );

        leaveVoice(client);

        clients.delete(client.id);

        broadcast({
            type: "presence",
            users: getUsers()
        });
    });

    ws.on("error", error => {
        console.log(
            "Erreur WebSocket :",
            error.message
        );
    });

});

// ===============================
// LANCEMENT DU SERVEUR
// ===============================

server.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log("=================================");
    console.log("       NOVACHAT EST EN LIGNE");
    console.log("=================================");
    console.log("");
    console.log(
        "Serveur lancé sur le port " + PORT
    );
    console.log("");

});