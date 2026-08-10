const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* =========================================================
   DATABASE
========================================================= */

function ensureDataFolder() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function createAccountsDatabase() {
    return {
        accounts: []
    };
}

function createChatDatabase() {
    return {
        channels: {
            general: []
        },
        privateMessages: {},
        servers: {}
    };
}

let accountsDB = createAccountsDatabase();
let chatDB = createChatDatabase();

/* =========================================================
   LOAD DATABASE
========================================================= */

function loadAccounts() {
    try {
        ensureDataFolder();

        if (!fs.existsSync(ACCOUNTS_FILE)) {
            accountsDB = createAccountsDatabase();
            saveAccounts();
            return;
        }

        const content = fs.readFileSync(
            ACCOUNTS_FILE,
            "utf8"
        );

        if (!content.trim()) {
            accountsDB = createAccountsDatabase();
            saveAccounts();
            return;
        }

        const parsed = JSON.parse(content);

        if (
            parsed &&
            Array.isArray(parsed.accounts)
        ) {
            accountsDB = parsed;
        } else {
            accountsDB = createAccountsDatabase();
        }

    } catch (error) {
        console.error(
            "Erreur chargement comptes :",
            error
        );

        accountsDB = createAccountsDatabase();
    }
}

function loadChat() {
    try {
        ensureDataFolder();

        if (!fs.existsSync(CHAT_FILE)) {
            chatDB = createChatDatabase();
            saveChat();
            return;
        }

        const content = fs.readFileSync(
            CHAT_FILE,
            "utf8"
        );

        if (!content.trim()) {
            chatDB = createChatDatabase();
            saveChat();
            return;
        }

        const parsed = JSON.parse(content);

        chatDB = {
            ...createChatDatabase(),
            ...parsed
        };

        if (!chatDB.channels) {
            chatDB.channels = {
                general: []
            };
        }

        if (!chatDB.channels.general) {
            chatDB.channels.general = [];
        }

        if (!chatDB.privateMessages) {
            chatDB.privateMessages = {};
        }

        if (!chatDB.servers) {
            chatDB.servers = {};
        }

    } catch (error) {
        console.error(
            "Erreur chargement chat :",
            error
        );

        chatDB = createChatDatabase();
    }
}

function saveAccounts() {
    try {
        ensureDataFolder();

        fs.writeFileSync(
            ACCOUNTS_FILE,
            JSON.stringify(
                accountsDB,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "Erreur sauvegarde comptes :",
            error
        );
    }
}

function saveChat() {
    try {
        ensureDataFolder();

        fs.writeFileSync(
            CHAT_FILE,
            JSON.stringify(
                chatDB,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "Erreur sauvegarde chat :",
            error
        );
    }
}

/*
IMPORTANT :
Les variables sont créées AVANT le chargement.
*/

loadAccounts();
loadChat();

/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
    const salt =
        crypto.randomBytes(16).toString("hex");

    const hash =
        crypto.scryptSync(
            String(password),
            salt,
            64
        ).toString("hex");

    return salt + ":" + hash;
}

function verifyPassword(
    password,
    storedPassword
) {
    try {
        const parts =
            String(storedPassword).split(":");

        if (parts.length !== 2) {
            return false;
        }

        const salt = parts[0];
        const originalHash = parts[1];

        const hash =
            crypto.scryptSync(
                String(password),
                salt,
                64
            ).toString("hex");

        const a = Buffer.from(
            hash,
            "hex"
        );

        const b = Buffer.from(
            originalHash,
            "hex"
        );

        if (a.length !== b.length) {
            return false;
        }

        return crypto.timingSafeEqual(
            a,
            b
        );

    } catch (error) {
        return false;
    }
}

/* =========================================================
   HELPERS
========================================================= */

function makeId(prefix) {
    return (
        prefix +
        "_" +
        crypto.randomBytes(12).toString("hex")
    );
}

function cleanText(value, max = 100) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .substring(0, max);
}

function normalizeEmail(email) {
    return String(email || "")
        .trim()
        .toLowerCase();
}

function normalizeUsername(username) {
    return cleanText(username, 32)
        .toLowerCase();
}

function displayNameFromUsername(username) {
    return cleanText(username, 32);
}

function getAvatar(username) {
    const name = cleanText(username);

    if (!name) {
        return "?";
    }

    return name.charAt(0).toUpperCase();
}

/* =========================================================
   ACCOUNT HELPERS
========================================================= */

function findAccountByEmail(email) {
    const normalized =
        normalizeEmail(email);

    return accountsDB.accounts.find(
        account =>
            account.email === normalized
    );
}

function findAccountByUsername(username) {
    const normalized =
        normalizeUsername(username);

    return accountsDB.accounts.find(
        account =>
            account.username === normalized
    );
}

function publicAccount(account) {
    return {
        id: account.id,
        email: account.email,
        username: account.username,
        displayName:
            account.displayName,
        avatar:
            account.avatar,
        createdAt:
            account.createdAt
    };
}

/* =========================================================
   HTTP ACCOUNT API
========================================================= */

/*
CREATE ACCOUNT
*/

app.post("/api/register", (req, res) => {
    try {
        const email =
            normalizeEmail(req.body.email);

        const password =
            String(req.body.password || "");

        const username =
            cleanText(
                req.body.username,
                32
            );

        if (!email) {
            return res.status(400).json({
                success: false,
                error:
                    "L'email est obligatoire."
            });
        }

        if (!password) {
            return res.status(400).json({
                success: false,
                error:
                    "Le mot de passe est obligatoire."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error:
                    "Le mot de passe doit contenir au moins 6 caractères."
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                error:
                    "Le nom d'utilisateur est obligatoire."
            });
        }

        if (
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                email
            )
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "Adresse email invalide."
            });
        }

        if (findAccountByEmail(email)) {
            return res.status(409).json({
                success: false,
                error:
                    "Cette adresse email est déjà utilisée."
            });
        }

        if (
            findAccountByUsername(username)
        ) {
            return res.status(409).json({
                success: false,
                error:
                    "Ce nom d'utilisateur est déjà utilisé."
            });
        }

        const account = {
            id: makeId("account"),
            email,
            passwordHash:
                hashPassword(password),
            username:
                normalizeUsername(username),
            displayName:
                displayNameFromUsername(
                    username
                ),
            avatar:
                getAvatar(username),
            createdAt: Date.now()
        };

        accountsDB.accounts.push(account);

        saveAccounts();

        return res.status(201).json({
            success: true,
            message:
                "Compte créé avec succès.",
            user:
                publicAccount(account)
        });

    } catch (error) {
        console.error(
            "Erreur création compte :",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Une erreur est survenue lors de la création du compte."
        });
    }
});

/*
LOGIN
*/

app.post("/api/login", (req, res) => {
    try {
        const email =
            normalizeEmail(req.body.email);

        const password =
            String(req.body.password || "");

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error:
                    "Email et mot de passe obligatoires."
            });
        }

        const account =
            findAccountByEmail(email);

        if (!account) {
            return res.status(401).json({
                success: false,
                error:
                    "Email ou mot de passe incorrect."
            });
        }

        if (
            !verifyPassword(
                password,
                account.passwordHash
            )
        ) {
            return res.status(401).json({
                success: false,
                error:
                    "Email ou mot de passe incorrect."
            });
        }

        return res.json({
            success: true,
            message:
                "Connexion réussie.",
            user:
                publicAccount(account)
        });

    } catch (error) {
        console.error(
            "Erreur connexion :",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                "Une erreur est survenue lors de la connexion."
        });
    }
});

/*
CHECK ACCOUNT
*/

app.post("/api/check-account", (req, res) => {
    const email =
        normalizeEmail(req.body.email);

    const username =
        normalizeUsername(
            req.body.username
        );

    return res.json({
        emailAvailable:
            email
                ? !findAccountByEmail(email)
                : false,

        usernameAvailable:
            username
                ? !findAccountByUsername(username)
                : false
    });
});

/* =========================================================
   WEBSOCKET
========================================================= */

const wss = new WebSocket.Server({
    server
});

const clients = new Map();

/* =========================================================
   WEBSOCKET HELPERS
========================================================= */

function wsSend(ws, data) {
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
        try {
            ws.send(
                JSON.stringify(data)
            );
        } catch (error) {
            console.error(
                "Erreur envoi WebSocket :",
                error
            );
        }
    }
}

function wsBroadcast(
    data,
    except = null
) {
    for (
        const client of clients.values()
    ) {
        if (client.ws !== except) {
            wsSend(client.ws, data);
        }
    }
}

function onlineUsers() {
    return Array.from(
        clients.values()
    ).map(client => ({
        id: client.id,
        accountId: client.accountId,
        username: client.username,
        displayName:
            client.displayName,
        avatar: client.avatar,
        voiceRoom:
            client.voiceRoom
    }));
}

function broadcastPresence() {
    wsBroadcast({
        type: "presence",
        users: onlineUsers()
    });
}

/* =========================================================
   WEBSOCKET CONNECTION
========================================================= */

wss.on("connection", ws => {

    let client = null;

    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", raw => {

        let data;

        try {
            data = JSON.parse(
                raw.toString()
            );
        } catch {
            wsSend(ws, {
                type: "error-message",
                message:
                    "Message invalide."
            });

            return;
        }

        if (
            !data ||
            typeof data !== "object"
        ) {
            return;
        }

        const type =
            String(data.type || "");

        /* =================================================
           AUTH VIA WEBSOCKET
        ================================================= */

        /*
         Certaines versions de ton index.html
         peuvent utiliser WebSocket directement
         pour créer le compte.
        */

        if (
            type === "register" ||
            type === "create-account" ||
            type === "signup"
        ) {

            const email =
                normalizeEmail(
                    data.email
                );

            const password =
                String(
                    data.password || ""
                );

            const username =
                cleanText(
                    data.username ||
                    data.nomUtilisateur ||
                    data.name,
                    32
                );

            if (
                !email ||
                !password ||
                !username
            ) {
                wsSend(ws, {
                    type:
                        "register-error",
                    success: false,
                    error:
                        "Tous les champs sont obligatoires."
                });

                return;
            }

            if (password.length < 6) {
                wsSend(ws, {
                    type:
                        "register-error",
                    success: false,
                    error:
                        "Le mot de passe doit contenir au moins 6 caractères."
                });

                return;
            }

            if (
                findAccountByEmail(email)
            ) {
                wsSend(ws, {
                    type:
                        "register-error",
                    success: false,
                    error:
                        "Cette adresse email est déjà utilisée."
                });

                return;
            }

            if (
                findAccountByUsername(
                    username
                )
            ) {
                wsSend(ws, {
                    type:
                        "register-error",
                    success: false,
                    error:
                        "Ce nom d'utilisateur est déjà utilisé."
                });

                return;
            }

            const account = {
                id: makeId("account"),
                email,
                passwordHash:
                    hashPassword(
                        password
                    ),
                username:
                    normalizeUsername(
                        username
                    ),
                displayName:
                    displayNameFromUsername(
                        username
                    ),
                avatar:
                    getAvatar(username),
                createdAt: Date.now()
            };

            accountsDB.accounts.push(
                account
            );

            saveAccounts();

            wsSend(ws, {
                type:
                    "register-success",
                success: true,
                user:
                    publicAccount(
                        account
                    )
            });

            return;
        }

        /*
        LOGIN WEBSOCKET
        */

        if (
            type === "login-account" ||
            type === "account-login"
        ) {

            const email =
                normalizeEmail(
                    data.email
                );

            const password =
                String(
                    data.password || ""
                );

            const account =
                findAccountByEmail(
                    email
                );

            if (
                !account ||
                !verifyPassword(
                    password,
                    account.passwordHash
                )
            ) {
                wsSend(ws, {
                    type:
                        "login-error",
                    success: false,
                    error:
                        "Email ou mot de passe incorrect."
                });

                return;
            }

            wsSend(ws, {
                type:
                    "login-account-success",
                success: true,
                user:
                    publicAccount(
                        account
                    )
            });

            return;
        }

        /* =================================================
           LOGIN CHAT
        ================================================= */

        if (type === "login") {

            if (client) {
                return;
            }

            const accountId =
                String(
                    data.accountId || ""
                );

            const account =
                accountsDB.accounts.find(
                    item =>
                        item.id === accountId
                );

            if (!account) {

                /*
                 * Compatibilité avec l'ancien
                 * système qui envoyait seulement
                 * un username.
                 */

                const username =
                    cleanText(
                        data.username,
                        32
                    );

                if (!username) {
                    wsSend(ws, {
                        type:
                            "error-message",
                        message:
                            "Compte introuvable."
                    });

                    return;
                }

                client = {
                    id: makeId("session"),
                    accountId: null,
                    username:
                        username
                            .toLowerCase(),
                    displayName:
                        username,
                    avatar:
                        getAvatar(username),
                    ws,
                    voiceRoom: null
                };

            } else {

                client = {
                    id: makeId("session"),
                    accountId:
                        account.id,
                    username:
                        account.username,
                    displayName:
                        account.displayName,
                    avatar:
                        account.avatar,
                    ws,
                    voiceRoom: null
                };
            }

            clients.set(
                client.id,
                client
            );

            wsSend(ws, {
                type:
                    "login-success",
                success: true,
                user: {
                    id: client.id,
                    accountId:
                        client.accountId,
                    username:
                        client.username,
                    displayName:
                        client.displayName,
                    avatar:
                        client.avatar
                }
            });

            wsSend(ws, {
                type: "history",
                channel: "general",
                messages:
                    chatDB.channels.general
            });

            broadcastPresence();

            return;
        }

        /* =================================================
           PROTECTION
        ================================================= */

        if (!client) {
            wsSend(ws, {
                type:
                    "error-message",
                message:
                    "Connecte-toi d'abord."
            });

            return;
        }

        /* =================================================
           MESSAGE
        ================================================= */

        if (type === "message") {

            const channel =
                cleanText(
                    data.channel ||
                    "general",
                    100
                ) || "general";

            if (
                !chatDB.channels[channel]
            ) {
                chatDB.channels[channel] =
                    [];
            }

            const content =
                String(
                    data.content || ""
                )
                    .trim()
                    .substring(
                        0,
                        4000
                    );

            if (!content) {
                return;
            }

            const message = {
                id: makeId("message"),
                channel,
                userId: client.id,
                accountId:
                    client.accountId,
                username:
                    client.username,
                displayName:
                    client.displayName,
                avatar:
                    client.avatar,
                content,
                time: Date.now(),
                reactions: {}
            };

            chatDB.channels[channel]
                .push(message);

            if (
                chatDB.channels[channel]
                    .length > 500
            ) {
                chatDB.channels[channel] =
                    chatDB.channels[
                        channel
                    ].slice(-500);
            }

            saveChat();

            wsBroadcast({
                type:
                    "new-message",
                message
            });

            return;
        }

        /* =================================================
           HISTORY
        ================================================= */

        if (type === "history") {

            const channel =
                cleanText(
                    data.channel ||
                    "general",
                    100
                ) || "general";

            if (
                !chatDB.channels[channel]
            ) {
                chatDB.channels[channel] =
                    [];
            }

            wsSend(ws, {
                type: "history",
                channel,
                messages:
                    chatDB.channels[
                        channel
                    ]
            });

            return;
        }

        /* =================================================
           PRIVATE MESSAGE
        ================================================= */

        if (
            type === "private-message"
        ) {

            const receiverId =
                String(
                    data.receiverId ||
                    data.userId ||
                    ""
                );

            const content =
                String(
                    data.content || ""
                )
                    .trim()
                    .substring(
                        0,
                        4000
                    );

            if (
                !receiverId ||
                !content
            ) {
                return;
            }

            const receiver =
                clients.get(
                    receiverId
                );

            if (!receiver) {
                wsSend(ws, {
                    type:
                        "error-message",
                    message:
                        "Cette personne n'est pas connectée."
                });

                return;
            }

            const key =
                [
                    client.id,
                    receiver.id
                ]
                    .sort()
                    .join("_");

            if (
                !chatDB.privateMessages[
                    key
                ]
            ) {
                chatDB.privateMessages[
                    key
                ] = [];
            }

            const message = {
                id: makeId("dm"),
                senderId:
                    client.id,
                receiverId:
                    receiver.id,
                senderName:
                    client.username,
                senderDisplayName:
                    client.displayName,
                content,
                time: Date.now()
            };

            chatDB.privateMessages[
                key
            ].push(message);

            saveChat();

            wsSend(
                receiver.ws,
                {
                    type:
                        "private-message",
                    message
                }
            );

            wsSend(
                ws,
                {
                    type:
                        "private-message",
                    message
                }
            );

            return;
        }

        /* =================================================
           PRIVATE HISTORY
        ================================================= */

        if (
            type === "private-history"
        ) {

            const receiverId =
                String(
                    data.receiverId ||
                    data.userId ||
                    ""
                );

            if (!receiverId) {
                return;
            }

            const key =
                [
                    client.id,
                    receiverId
                ]
                    .sort()
                    .join("_");

            wsSend(ws, {
                type:
                    "private-history",
                receiverId,
                messages:
                    chatDB.privateMessages[
                        key
                    ] || []
            });

            return;
        }

        /* =================================================
           VOICE JOIN
        ================================================= */

        if (
            type === "voice-join"
        ) {

            const room =
                cleanText(
                    data.room ||
                    "general",
                    100
                );

            if (!room) {
                return;
            }

            if (client.voiceRoom) {
                wsBroadcast({
                    type:
                        "voice-user-left",
                    room:
                        client.voiceRoom,
                    userId:
                        client.id
                });
            }

            client.voiceRoom = room;

            const peers = [];

            for (
                const other of clients.values()
            ) {
                if (
                    other.id !==
                        client.id &&
                    other.voiceRoom ===
                        room
                ) {
                    peers.push({
                        id:
                            other.id,
                        username:
                            other.username,
                        displayName:
                            other.displayName,
                        avatar:
                            other.avatar
                    });
                }
            }

            wsSend(ws, {
                type:
                    "voice-peers",
                room,
                peers
            });

            wsBroadcast(
                {
                    type:
                        "voice-user-joined",
                    room,
                    user: {
                        id:
                            client.id,
                        username:
                            client.username,
                        displayName:
                            client.displayName,
                        avatar:
                            client.avatar
                    }
                },
                ws
            );

            broadcastPresence();

            return;
        }

        /* =================================================
           VOICE LEAVE
        ================================================= */

        if (
            type === "voice-leave"
        ) {

            if (!client.voiceRoom) {
                return;
            }

            const room =
                client.voiceRoom;

            client.voiceRoom = null;

            wsBroadcast({
                type:
                    "voice-user-left",
                room,
                userId:
                    client.id
            });

            broadcastPresence();

            return;
        }

        /* =================================================
           WEBRTC OFFER
        ================================================= */

        if (
            type === "webrtc-offer"
        ) {

            const targetId =
                String(
                    data.targetId ||
                    data.userId ||
                    ""
                );

            const target =
                clients.get(
                    targetId
                );

            if (!target) {
                return;
            }

            if (
                client.voiceRoom &&
                target.voiceRoom &&
                client.voiceRoom ===
                    target.voiceRoom
            ) {
                wsSend(
                    target.ws,
                    {
                        type:
                            "webrtc-offer",
                        senderId:
                            client.id,
                        senderName:
                            client.displayName,
                        offer:
                            data.offer
                    }
                );
            }

            return;
        }

        /* =================================================
           WEBRTC ANSWER
        ================================================= */

        if (
            type === "webrtc-answer"
        ) {

            const targetId =
                String(
                    data.targetId ||
                    data.userId ||
                    ""
                );

            const target =
                clients.get(
                    targetId
                );

            if (!target) {
                return;
            }

            wsSend(
                target.ws,
                {
                    type:
                        "webrtc-answer",
                    senderId:
                        client.id,
                    senderName:
                        client.displayName,
                    answer:
                        data.answer
                }
            );

            return;
        }

        /* =================================================
           WEBRTC ICE
        ================================================= */

        if (
            type === "webrtc-ice"
        ) {

            const targetId =
                String(
                    data.targetId ||
                    data.userId ||
                    ""
                );

            const target =
                clients.get(
                    targetId
                );

            if (!target) {
                return;
            }

            wsSend(
                target.ws,
                {
                    type:
                        "webrtc-ice",
                    senderId:
                        client.id,
                    senderName:
                        client.displayName,
                    candidate:
                        data.candidate
                }
            );

            return;
        }

        /* =================================================
           PING
        ================================================= */

        if (type === "ping") {
            wsSend(ws, {
                type: "pong"
            });
        }
    });

    /* =====================================================
       DISCONNECT
    ===================================================== */

    ws.on("close", () => {

        if (!client) {
            return;
        }

        if (client.voiceRoom) {
            wsBroadcast({
                type:
                    "voice-user-left",
                room:
                    client.voiceRoom,
                userId:
                    client.id
            });
        }

        clients.delete(
            client.id
        );

        broadcastPresence();
    });

    ws.on("error", error => {
        console.error(
            "Erreur WebSocket :",
            error.message
        );
    });
});

/* =========================================================
   HEARTBEAT
========================================================= */

const heartbeat =
    setInterval(() => {

        for (
            const ws of wss.clients
        ) {

            if (
                ws.isAlive === false
            ) {
                ws.terminate();
                continue;
            }

            ws.isAlive = false;

            try {
                ws.ping();
            } catch {
                // connexion déjà fermée
            }
        }

    }, 30000);

wss.on("close", () => {
    clearInterval(heartbeat);
});

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown() {

    console.log(
        "Arrêt de NovaChat..."
    );

    saveAccounts();
    saveChat();

    for (
        const client of clients.values()
    ) {
        try {
            client.ws.close();
        } catch {
            // rien
        }
    }

    server.close(() => {
        process.exit(0);
    });
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);

/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");
        console.log(
            "======================================"
        );
        console.log(
            "          NOVACHAT SERVEUR"
        );
        console.log(
            "======================================"
        );
        console.log(
            "Port : " + PORT
        );
        console.log(
            "WebSocket : OK"
        );
        console.log(
            "Comptes : OK"
        );
        console.log(
            "Database : OK"
        );
        console.log(
            "======================================"
        );
        console.log("");
    }
);