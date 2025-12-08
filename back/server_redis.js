const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');
const cassandra = require('./db/cassandra');

// / note: no chess.js on backend — compute undo by reading previous persisted FENs from the stream

const app = express();
const PORT = 8080;

const playerRoutes = require('./routes/playerRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');


app.use(express.json());

// mount REST routes
app.use('/api/players', playerRoutes);
app.use('/api/tournaments', tournamentRoutes);

// Redis setup
const redis = createClient({ url: 'redis://192.168.122.230:6379' });
redis.connect();

const server = app.listen(PORT, () => {
    console.log(`[INFO] Server started on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
    const [, gameId, color] = req.url.split('/');
    const streamKey = `game:${gameId}`;
    ws.gameId = gameId; // Store gameId in the WebSocket object for later reference
    ws.color = color; // store player color so we can attribute requests/accepts

    console.log(`[INFO] New WebSocket connection: gameId=${gameId}, color=${color}`);

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            console.log(`[INFO] Received message: ${JSON.stringify(data)} from gameId=${gameId}`);


            if (data.type === 'move') {
                const fen = data.fen || '';
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'move',
                    move: JSON.stringify(data.move),
                    fen
                });
                // update snapshot so reconnects are fast
                if (fen) await redis.set(`${streamKey}:fen`, fen);
                // maintain small recent-FEN list for fast undo/resync without chess logic
                if (fen) {
                    await redis.rPush(`${streamKey}:fens`, fen);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }
                console.log(`[INFO] Added move to stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'move',
                            move: data.move,
                            streamId: id,
                            fen: fen || undefined
                        }));
                    }
                });
            }


            if (data.type === 'undo') {
                // prefer client-provided fen (client updated its state), otherwise use snapshot
                const fen = (data.fen && data.fen.length) ? data.fen : (await redis.get(`${streamKey}:fen`)) || '';
                const id = await redis.xAdd(streamKey, '*', { type: 'undo', fen });
                if (fen) {
                    await redis.set(`${streamKey}:fen`, fen);
                    await redis.rPush(`${streamKey}:fens`, fen);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }
                console.log(`[INFO] Executed undo on stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'undo',
                            streamId: id,
                            fen: fen || undefined
                        }));
                    }
                });
            }

            // Player requests an undo — record request and notify opponent(s)
            if (data.type === 'undo_request') {
                console.log(`[DEBUG] Received undo_request from ${ws.color} raw=${JSON.stringify(data)}`);
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo_request',
                    from: ws.color || data.from || 'unknown',
                    state: 'pending' // helpful metadata (immutable snapshot)
                });
                console.log(`[INFO] Persisted undo_request id=${id} from=${ws.color} stream=${streamKey}`);

                // notify other clients (opponent) about the undo request
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        +                        console.log(`[DEBUG] notifying client remote=${client._socket?.remoteAddress || 'unknown'} about undo_request id=${id}`);
                        client.send(JSON.stringify({
                            type: 'undo_request',
                            streamId: id,
                            from: ws.color,
                            state: 'pending'
                        }));
                    }
                });

                // acknowledge requester so UI can show "request sent"
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'undo_request_sent', streamId: id, state: 'pending' }));
                }
            }

            // Opponent accepted the undo request -> create a real 'undo' event and notify all clients
            if (data.type === 'undo_accept') {
                -                console.log(`[DEBUG] Received undo_accept from ${ws.color} requestId=${data.requestId} fenCandidatePresent=${!!data.fen}`);
                +                console.log(`[DEBUG] Received undo_accept from ${ws.color} requestId=${data.requestId} fenCandidatePresent=${!!data.fen}`);

                let fenCandidate = '';
                if (data.fen && data.fen.length) {
                    fenCandidate = data.fen;
                } else {
                    fenCandidate = await getFenFromRecentList(streamKey, 1);
                }
                +                console.log(`[DEBUG] undo_accept chosen fenCandidate=${fenCandidate || '<empty>'} for requestId=${data.requestId}`);

                // persist + xAdd + broadcast (your existing code)
                // store requestId so resync can correlate the response to the original undo_request
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo',
                    requestId: data.requestId || '',
                    acceptedBy: ws.color || data.by || 'unknown',
                    fen: fenCandidate,
                    state: 'accepted'
                });
                +                console.log(`[INFO] Persisted undo (response) id=${id} requestId=${data.requestId} acceptedBy=${ws.color}`);
                if (fenCandidate) {
                    await redis.set(`${streamKey}:fen`, fenCandidate);
                    await redis.rPush(`${streamKey}:fens`, fenCandidate);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }
                const persistedFen = (await redis.get(`${streamKey}:fen`)) || fenCandidate;

                wss.clients.forEach((client) => {
                    if (client.readyState === 1 && client.gameId === gameId) {
                        +                        console.log(`[DEBUG] broadcasting undo accepted -> client remote=${client._socket?.remoteAddress || 'unknown'} streamId=${id} requestId=${data.requestId}`);
                        client.send(JSON.stringify({
                            type: 'undo',
                            streamId: id,
                            requestId: data.requestId || '',
                            acceptedBy: ws.color,
                            fen: persistedFen,
                            state: 'accepted'
                        }));
                    }
                });
            }

            // Optional: opponent rejected the undo request
            if (data.type === 'undo_reject') {
                // include requestId so we can correlate to undo_request
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo_reject',
                    requestId: data.requestId || '',
                    rejectedBy: ws.color || data.by || 'unknown',
                    state: 'rejected'
                });
                +                console.log(`[INFO] Persisted undo_reject id=${id} requestId=${data.requestId} rejectedBy=${ws.color}`);
                console.log(`[INFO] Undo rejected on ${streamKey} with ID ${id} rejectedBy=${ws.color}`);

                // notify the requester (and others) about rejection
                wss.clients.forEach((client) => {
                    +                    console.log(`[DEBUG] broadcasting undo_reject -> client remote=${client._socket?.remoteAddress || 'unknown'} streamId=${id}`);
                    if (client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'undo_reject',
                            streamId: id,
                            requestId: data.requestId || '',
                            rejectedBy: ws.color,
                            state: 'rejected'
                        }));
                    }
                });
            }

            if (data.type === 'reset') {
                const fen = data.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
                const id = await redis.xAdd(streamKey, '*', { type: 'reset', fen });
                // snapshot must reflect reset position
                await redis.set(`${streamKey}:fen`, fen);
                await redis.rPush(`${streamKey}:fens`, fen);
                await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                console.log(`[INFO] Executed reset on stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        console.log(`[INFO] Resetting game for client gameId=${client.gameId}`);
                        client.send(JSON.stringify({
                            type: 'reset',
                            streamId: id,
                            fen
                        }));
                    }
                });
            }

            if (data.type === 'resync') {
                console.log(`[INFO] Resync requested for gameId=${gameId}, lastId=${data.lastId}`);
                const lastSeenId = data.lastId || '0-0';

                // fast snapshot path for fresh clients ONLY
                // if (!lastSeenId || lastSeenId === '0-0') {
                const snapshotFen = await redis.get(`${streamKey}:fen`);
                if (snapshotFen) {
                    ws.send(JSON.stringify({ type: 'snapshot', fen: snapshotFen }));
                }
                // }

                const entries = await redis.xRead(
                    [{ key: streamKey, id: lastSeenId }],
                    { COUNT: 20 }
                );

                if (!entries || !entries.length || !entries[0] || !entries[0].messages) {
                    console.log(`[WARN] No stream entries returned for ${streamKey} since ${lastSeenId}`);
                } else {
                    +                    console.log(`[DEBUG] resync: returned ${entries[0].messages.length} messages for ${streamKey} since ${lastSeenId}`);
                    // build a set of resolved undo_request ids by scanning for undo / undo_reject responses
                    const messages = entries[0].messages;
                    const resolvedRequestIds = new Set();
                    for (const { name, message } of messages) {
                        const obj = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, v && v.toString ? v.toString() : v]));
                        if ((obj.type === 'undo' || obj.type === 'undo_reject') && obj.requestId) {
                            +                            console.log(`[DEBUG] resync found resolver type=${obj.type} requestId=${obj.requestId}`);
                            resolvedRequestIds.add(obj.requestId);
                        }
                    }
                    +                    console.log(`[DEBUG] resync resolvedRequestIds=`, Array.from(resolvedRequestIds));

                    entries[0].messages.forEach(({ name, message }) => {
                        // normalize message values to strings
                        const obj = Object.fromEntries(
                            Object.entries(message).map(([k, v]) => [k, v && v.toString ? v.toString() : v])
                        );
                        const type = obj.type;

                        // ✅ NEW: skip undo_request that already has a corresponding undo/undo_reject
                        if (type === 'undo_request' && resolvedRequestIds.has(name)) {
                            console.log(`[DEBUG] resync skipping resolved undo_request id=${name}`);
                            return;
                        }

                        if (type === 'move') {
                            ws.send(JSON.stringify({
                                streamId: name,
                                type: 'move',
                                move: JSON.parse(obj.move),
                                fen: obj.fen || undefined
                            }));
                        } else if (type === 'undo' || type === 'reset') {
                            ws.send(JSON.stringify({
                                streamId: name,
                                type,
                                fen: obj.fen || undefined,
                                acceptedBy: obj.acceptedBy || undefined,
                                rejectedBy: obj.rejectedBy || undefined
                            }));
                        } else {
                            // generic events (undo_request, undo_reject, ...)
                            const out = { streamId: name, type };
                            for (const k in obj) if (k !== 'type' && k !== 'move') out[k] = obj[k];
                            ws.send(JSON.stringify(out));
                        }
                    });
                }
            }

            if (data.type === 'game_over') {
                const result = data.result || null;
                const reason = data.reason || null;
                const endFen = data.fen || null;
                const endTime = new Date();
                const gameIdFromWs = ws.gameId; // from URL

                console.log(
                    `[INFO] game_over received for game ${gameIdFromWs}: result=${result}, reason=${reason}`
                );

                try {
                    // 1) Look up tournament/round/board from matches_by_game
                    const matchRes = await cassandra.execute(
                        'SELECT tournament_id, round, board_number FROM matches_by_game WHERE game_id = ?',
                        [gameIdFromWs],
                        { prepare: true }
                    );

                    if (!matchRes.rowLength) {
                        console.warn(
                            `[WARN] game_over: no match found in matches_by_game for game_id=${gameIdFromWs}`
                        );
                        return;
                    }

                    const row = matchRes.rows[0];
                    const tournamentId = row.tournament_id;
                    const round = row.round;
                    const boardNumber = row.board_number;

                    // 2) Update matches row with result + end_time (+ final_fen if you added it)
                    await cassandra.execute(
                        `
            UPDATE matches
            SET result = ?, end_time = ?, final_fen = ?
            WHERE tournament_id = ? AND round = ? AND board_number = ?
            `,
                        [result, endTime, endFen, tournamentId, round, boardNumber],
                        { prepare: true }
                    );

                    // 3) Optionally mirror the result into matches_by_game too
                    await cassandra.execute(
                        `
            UPDATE matches_by_game
            SET result = ?, end_time = ?
            WHERE game_id = ?
            `,
                        [result, endTime, gameIdFromWs],
                        { prepare: true }
                    );

                    console.log(
                        `[INFO] Stored game result for tournament=${tournamentId} round=${round} board=${boardNumber} result=${result}`
                    );
                } catch (e) {
                    console.error('[ERROR] game_over DB update failed:', e);
                }

                return; // we've handled this message
            }


        } catch (err) {
            console.error(`[ERROR] ${err.message}`);
        }


    });

    // on disconnect, we might want to clean up or notify other players
    ws.on('close', () => {
        console.log(`[INFO] WebSocket disconnected: gameId=${gameId}, color=${color}`);
        // TODO: handle cleanup or notifications
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Debug endpoint to get Redis stream entries directly
app.get('/debug/stream/:gameId', async (req, res) => {
    const { gameId } = req.params;
    const streamKey = `game:${gameId}`;

    try {
        const entries = await redis.xRevRange(streamKey, '+', '-', { COUNT: 10 });
        const result = entries.map(([id, fields]) => {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) {
                obj[fields[i]] = fields[i + 1];
            }
            return { id, ...obj };
        });

        res.json(result);
    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add helper to read previous FENs from recent list (fast O(1) access)
async function getFenFromRecentList(streamKey, plies = 1) {
    const listKey = `${streamKey}:fens`;
    // -1 = latest, -2 = previous, so index = -1 - plies
    const idx = -1 - plies;
    try {
        const fen = await redis.lIndex(listKey, idx);
        if (fen) return fen;
    } catch (e) {
        // some redis clients may not support lIndex in older APIs; fall through to snapshot fallback
    }
    // fallback to snapshot key
    const snapshot = await redis.get(`${streamKey}:fen`);
    if (snapshot) return snapshot;
    // final fallback to scanning stream history (existing function)
    return await computeFenFromStreamHistory(streamKey, plies);
}

// Compute an undo FEN without chess logic: find persisted FENs in the stream history.
// We assume move/reset/undo entries include a `fen` field when they were written (client or server persisted).
// plies = 1 => return the fen one step before the latest persisted fen.
async function computeFenFromStreamHistory(streamKey, plies = 1) {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // read recent entries in reverse (newest first). COUNT limits work to keep it fast.
    const COUNT = 1000;
    const entries = await redis.xRevRange(streamKey, '+', '-', { COUNT });

    const fens = [];
    let lastAdded = null;

    for (const [id, fields] of entries) {
        // build fresh obj per entry (do NOT reuse)
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) {
            obj[fields[i]] = fields[i + 1];
        }

        const type = (obj.type || '').toString();
        // only accept FENs produced by relevant event types
        if (!['move', 'reset', 'undo'].includes(type)) continue;

        const fen = obj.fen && obj.fen.toString ? obj.fen.toString() : obj.fen;
        if (!fen) continue;

        // avoid pushing duplicate consecutive FENs (can happen after optimistic writes)
        if (fen === lastAdded) continue;

        fens.push(fen);
        lastAdded = fen;
    }

    // fens[0] is current latest persisted fen; we want the fen plies steps before it
    if (fens.length === 0) return START_FEN;

    if (plies >= fens.length) {
        // not enough preserved history — return the oldest one we have in window
        return fens[fens.length - 1] || START_FEN;
    }

    return fens[plies];
}
