const WebSocket = require("ws");
const http = require("http");
const url = require("url");

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const games = {}; // Map of game_id -> { w: ws, b: ws }

wss.on("connection", (ws, request, clientInfo) => {
    const { gameId, color } = clientInfo;

    if (!games[gameId]) games[gameId] = {};
    games[gameId][color] = ws;

    ws.send(JSON.stringify({ type: "assign", color }));

    ws.on("message", (message) => {
        const data = JSON.parse(message);
        const opponentColor = color === "w" ? "b" : "w";
        const opponentWs = games[gameId][opponentColor];

        if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
            opponentWs.send(JSON.stringify(data));
        }
    });

    ws.on("close", () => {
        if (games[gameId]) {
            games[gameId][color] = null;
        }
    });
});

// Handle upgrade to WebSocket
server.on("upgrade", (req, socket, head) => {
    const parsedUrl = url.parse(req.url, true);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const [gameId, color] = pathParts;

    if (!gameId || !["w", "b"].includes(color)) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, { gameId, color });
    });
});

server.listen(8080, () => {
    console.log("WebSocket server running on ws://localhost:8080");
});
