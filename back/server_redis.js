const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');
const cassandra = require('./db/cassandra');

// / note: no chess.js on backend — compute undo by reading previous persisted FENs from the stream

const app = express();
const PORT = 8080;

const cors = require('cors');

app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://192.168.0.2:3000'
    ]
}));

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

            const meta = await redis.hGetAll(`${streamKey}:meta`);
            const isFinished = meta && meta.finished === '1';
            const isResync = data.type === 'resync';
            const isGameOverMessage = data.type === 'game_over';

            // Block *most* messages if the game is finished, but still allow resync so reconnects can see final board/result
            if (isFinished && !isResync && !isGameOverMessage) {
                console.log(`[INFO] Ignoring ${data.type} for finished game ${gameId}`);
                ws.send(JSON.stringify({
                    type: 'game_finished',
                    gameId,
                    reason: 'already_finished',
                    result: meta.result || '',
                    finalFen: meta.finalFen || null
                }));
                return;
            }




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
                        console.log(`[DEBUG] notifying client remote=${client._socket?.remoteAddress || 'unknown'} about undo_request id=${id}`);
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
                console.log(`[DEBUG] Received undo_accept from ${ws.color} requestId=${data.requestId} fenCandidatePresent=${!!data.fen}`);
                console.log(`[DEBUG] Received undo_accept from ${ws.color} requestId=${data.requestId} fenCandidatePresent=${!!data.fen}`);

                let fenCandidate = '';
                if (data.fen && data.fen.length) {
                    fenCandidate = data.fen;
                } else {
                    fenCandidate = await getFenFromRecentList(streamKey, 1);
                }
                console.log(`[DEBUG] undo_accept chosen fenCandidate=${fenCandidate || '<empty>'} for requestId=${data.requestId}`);

                // persist + xAdd + broadcast (your existing code)
                // store requestId so resync can correlate the response to the original undo_request
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo',
                    requestId: data.requestId || '',
                    acceptedBy: ws.color || data.by || 'unknown',
                    fen: fenCandidate,
                    state: 'accepted'
                });
                console.log(`[INFO] Persisted undo (response) id=${id} requestId=${data.requestId} acceptedBy=${ws.color}`);
                if (fenCandidate) {
                    await redis.set(`${streamKey}:fen`, fenCandidate);
                    await redis.rPush(`${streamKey}:fens`, fenCandidate);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }
                const persistedFen = (await redis.get(`${streamKey}:fen`)) || fenCandidate;

                wss.clients.forEach((client) => {
                    if (client.readyState === 1 && client.gameId === gameId) {
                        console.log(`[DEBUG] broadcasting undo accepted -> client remote=${client._socket?.remoteAddress || 'unknown'} streamId=${id} requestId=${data.requestId}`);
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
                console.log(`[INFO] Persisted undo_reject id=${id} requestId=${data.requestId} rejectedBy=${ws.color}`);
                console.log(`[INFO] Undo rejected on ${streamKey} with ID ${id} rejectedBy=${ws.color}`);

                // notify the requester (and others) about rejection
                wss.clients.forEach((client) => {
                    console.log(`[DEBUG] broadcasting undo_reject -> client remote=${client._socket?.remoteAddress || 'unknown'} streamId=${id}`);
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

                const streamKey = `game:${gameId}`;

                // 1) Always send latest snapshot
                const snapshotFen = await redis.get(`${streamKey}:fen`);
                if (snapshotFen) {
                    ws.send(JSON.stringify({ type: 'snapshot', fen: snapshotFen }));
                }

                // 2) Check if game is finished -> send result too
                const meta = await redis.hGetAll(`${streamKey}:meta`);
                const finished = meta && meta.finished === '1';

                if (finished) {
                    ws.send(JSON.stringify({
                        type: 'game_result',
                        gameId,
                        result: meta.result || '',
                        reason: meta.reason || 'finished',
                        finalFen: meta.finalFen || snapshotFen || null
                    }));
                }

                // 3) Do NOT xRead anything here – snapshot is the single source of truth
                console.log('[DEBUG] Resync: snapshot only, no history replay');
                return;
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
                        `
                        SELECT tournament_id, round, board_number, white_player, black_player
                        FROM matches_by_game
                        WHERE game_id = ?
                        `,
                        [gameIdFromWs],
                        { prepare: true }
                    );



                    // prepare update statements



                    if (!matchRes.rowLength) {
                        console.warn(
                            `[WARN] game_over: no match found in matches_by_game for game_id=${gameIdFromWs}`
                        );
                        return;
                    }

                    const row = matchRes.rows[0];


                    console.log(`[DEBUG] game_over: found match row=${JSON.stringify(row)} for game_id=${gameIdFromWs}`);
                    const tournamentId = row.tournament_id;
                    const round = row.round;
                    const boardNumber = row.board_number;
                    const whiteId = row.white_player;
                    const blackId = row.black_player;

                    // scoring: win = 1, draw = 0.5, loss = 0
                    let whiteDelta = 0;
                    let blackDelta = 0;

                    if (result === '1-0') {
                        whiteDelta = 1.0;
                        blackDelta = 0.0;
                    } else if (result === '0-1') {
                        whiteDelta = 0.0;
                        blackDelta = 1.0;
                    } else if (result === '1/2-1/2') {
                        whiteDelta = 0.5;
                        blackDelta = 0.5;
                    } else {
                        console.warn(`[WARN] game_over: unknown result="${result}" – skipping leaderboard update`);
                    }


                    if (whiteDelta > 0 || blackDelta > 0) {
                        // White
                        const whiteLB = await cassandra.execute(
                            'SELECT points FROM leaderboard_by_player WHERE tournament_id = ? AND player_id = ?',
                            [tournamentId, whiteId],
                            { prepare: true }
                        );
                        const whiteCurrent = whiteLB.rowLength ? whiteLB.rows[0].points : 0.0;
                        const whiteNew = whiteCurrent + whiteDelta;

                        await cassandra.execute(
                            'INSERT INTO leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)',
                            [tournamentId, whiteId, whiteNew],
                            { prepare: true }
                        );

                        // Black
                        const blackLB = await cassandra.execute(
                            'SELECT points FROM leaderboard_by_player WHERE tournament_id = ? AND player_id = ?',
                            [tournamentId, blackId],
                            { prepare: true }
                        );
                        const blackCurrent = blackLB.rowLength ? blackLB.rows[0].points : 0.0;
                        const blackNew = blackCurrent + blackDelta;

                        await cassandra.execute(
                            'INSERT INTO leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)',
                            [tournamentId, blackId, blackNew],
                            { prepare: true }
                        );

                        // mark game as finished in Redis and store result info
                        await redis.hSet(`${streamKey}:meta`, {
                            finished: '1',
                            result: result || '',
                            reason: reason || '',
                            finalFen: endFen || ''
                        });


                        console.log(
                            `[INFO] Updated leaderboard_by_player: white=${whiteId} -> ${whiteNew}, black=${blackId} -> ${blackNew}`
                        );
                    }


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


                    // 🔔 broadcast official result to both clients
                    wss.clients.forEach((client) => {
                        if (client.readyState === 1 && client.gameId === gameIdFromWs) {
                            client.send(JSON.stringify({
                                type: 'game_result',
                                gameId: gameIdFromWs,
                                result,        // "1-0" | "0-1" | "1/2-1/2"
                                reason,        // "checkmate" | "draw"
                                finalFen: endFen || null
                            }));
                        }
                    });
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
