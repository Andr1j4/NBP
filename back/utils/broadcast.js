function isViewerClient(ws) {
    return ws && ws.kind === "viewer";
}

function clientWatchesGame(ws, gameId) {
    return isViewerClient(ws) && ws.viewerSubs && ws.viewerSubs.has(gameId);
}

function broadcastToGame(wss, gameId, payloadObj, exceptWs = null) {
    const payload = JSON.stringify(payloadObj);
    let sent = 0;

    wss.clients.forEach((client) => {
        if (client.readyState !== 1) return;
        if (exceptWs && client === exceptWs) return;

        const directMatch = client.gameId === gameId;
        const viewerMatch = client.kind === "viewer" && client.viewerSubs?.has(gameId);

        if (directMatch || viewerMatch) {
            client.send(payload);
            sent++;
        }
    });

    return sent;
}

function broadcastClock(wssInstance, gameId, clock) {
    return broadcastToGame(wssInstance, gameId, {
        type: "clock_state",
        gameId,
        whiteMs: clock.w_ms,
        blackMs: clock.b_ms,
        active: clock.active,
        running: clock.running,
        incMs: clock.inc_ms,
        timeControl: clock.tc || null,
        serverNow: Date.now(),
    });
}

function buildPairedMovesFromSan(sanMoves) {
    const rows = [];
    for (let i = 0; i < sanMoves.length; i += 2) {
        rows.push({
            moveNumber: i / 2 + 1,
            white: sanMoves[i] || "",
            black: sanMoves[i + 1] || "",
        });
    }
    return rows;
}

module.exports = {
    isViewerClient,
    clientWatchesGame,
    broadcastToGame,
    broadcastClock,
    buildPairedMovesFromSan,
};
