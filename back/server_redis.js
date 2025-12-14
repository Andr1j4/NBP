// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');
const cassandra = require('./db/cassandra');
const gameRoutes = require("./routes/gameRoutes");
const cors = require('cors');

const app = express();
const PORT = 8080;

app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://192.168.0.2:3000'
    ]
}));

app.use(express.json());

// mount REST routes
app.use("/api/games", gameRoutes);
const playerRoutes = require('./routes/playerRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
app.use('/api/players', playerRoutes);
app.use('/api/tournaments', tournamentRoutes);

// Redis setup
const redis = createClient({ url: 'redis://192.168.122.230:6379' });
redis.connect();
app.locals.redis = redis;

const server = app.listen(PORT, () => {
    console.log(`[INFO] Server started on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

/**
 * ===================== CLOCK TICKERS (PER GAME) =====================
 * Without this, timeout is only detected when a message arrives (move/resync/etc).
 * With this, timeout is detected even when nobody is moving.
 */
const gameTickers = new Map(); // gameId -> intervalId

function startGameTicker(gameId) {
    if (!gameId) return;
    if (gameTickers.has(gameId)) return; // already running

    const intervalId = setInterval(async () => {
        const streamKey = `game:${gameId}`;

        try {
            // If finished -> stop ticker
            const meta = await redis.hGetAll(`${streamKey}:meta`);
            if (meta && meta.finished === "1") {
                stopGameTicker(gameId);
                return;
            }

            const clock = await getOrInitClock(redis, cassandra, gameId);
            if (!clock.running) return; // nothing to tick

            const nowMs = Date.now();
            const settle = settleClock(clock, nowMs);

            // persist/broadcast the updated clock (smooth countdown)
            await saveClock(redis, gameId, clock);
            broadcastClock(wss, gameId, clock);

            if (settle.flag) {
                const loser = settle.loser;               // "w" | "b"
                const winner = loser === "w" ? "b" : "w";
                const result = loser === "w" ? "0-1" : "1-0";
                const reason = "timeout";
                const finalFen = (await redis.get(`${streamKey}:fen`)) || "";

                try {
                    await handleGameOver({
                        gameId,
                        result,
                        reason,
                        finalFen,
                        endTime: new Date(),
                        loser,
                        winner,
                        wss,
                        redis,
                        cassandra
                    });
                } catch (e) {
                    console.error("[ERROR] handleGameOver(timeout ticker) failed:", e);
                } finally {
                    stopGameTicker(gameId);
                }
            }
        } catch (e) {
            console.warn(`[clock] ticker error game=${gameId}`, e);
        }
    }, 100); // 100ms feels real-time without being too heavy

    gameTickers.set(gameId, intervalId);
}

function stopGameTicker(gameId) {
    const id = gameTickers.get(gameId);
    if (id) clearInterval(id);
    gameTickers.delete(gameId);
}

wss.on('connection', async (ws, req) => {
    const [, gameId, color] = req.url.split('/');
    const streamKey = `game:${gameId}`;

    ws.gameId = gameId;
    ws.color = color;

    console.log(`[INFO] New WebSocket connection: gameId=${gameId}, color=${color}`);

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            console.log(`[INFO] Received message: ${JSON.stringify(data)} from gameId=${gameId}`);

            const meta = await redis.hGetAll(`${streamKey}:meta`);
            const isFinished = meta && meta.finished === '1';
            const isResync = data.type === 'resync';
            const isGameOverMessage = data.type === 'game_over';

            // ✅ Spectator = read-only: allow only resync
            if (ws.color === 'spectator' && data.type !== 'resync') {
                ws.send(JSON.stringify({ type: 'error', reason: 'spectator_read_only' }));
                return;
            }

            // Block most messages if finished (still allow resync and game_over)
            if (isFinished && !isResync && !isGameOverMessage) {
                ws.send(JSON.stringify({
                    type: 'game_finished',
                    gameId,
                    reason: 'already_finished',
                    result: meta.result || '',
                    finalFen: meta.finalFen || null
                }));
                return;
            }

            // ===================== MOVE =====================
            if (data.type === 'move') {
                // --- CLOCK: settle time, apply increment, switch active ---
                const nowMs = Date.now();
                const clock = await getOrInitClock(redis, cassandra, gameId);

                // First move starts the clock (based on who actually moved)
                if (!clock.running) {
                    clock.running = true;
                    const mover0 = ws.color === "b" ? "b" : "w";
                    clock.active = mover0;
                    clock.last_tick = nowMs;

                    // ✅ start per-game timeout ticker now
                    startGameTicker(gameId);
                }

                // settle active time
                const settle = settleClock(clock, nowMs);

                // TIMEOUT -> finish via handleGameOver (DB + archive + broadcast)
                if (settle.flag) {
                    const loser = settle.loser;                 // "w" | "b"
                    const winner = loser === "w" ? "b" : "w";
                    const result = loser === "w" ? "0-1" : "1-0";
                    const reason = "timeout";

                    const finalFen = (await redis.get(`${streamKey}:fen`)) || "";

                    // persist/broadcast final clock snapshot
                    await saveClock(redis, gameId, clock);
                    broadcastClock(wss, gameId, clock);

                    try {
                        await handleGameOver({
                            gameId,
                            result,
                            reason,
                            finalFen,
                            endTime: new Date(),
                            loser,
                            winner,
                            wss,
                            redis,
                            cassandra
                        });
                    } catch (e) {
                        console.error("[ERROR] handleGameOver(timeout) failed:", e);
                    } finally {
                        stopGameTicker(gameId);
                    }
                    return;
                }

                // apply increment to mover
                const mover = ws.color === "b" ? "b" : "w";
                if (mover === "w") clock.w_ms += (clock.inc_ms || 0);
                else clock.b_ms += (clock.inc_ms || 0);

                // switch active
                clock.active = mover === "w" ? "b" : "w";
                clock.last_tick = nowMs;

                await saveClock(redis, gameId, clock);
                broadcastClock(wss, gameId, clock);

                // --- your stream persistence/broadcast ---
                const fen = data.fen || '';
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'move',
                    move: JSON.stringify(data.move),
                    fen
                });

                if (fen) await redis.set(`${streamKey}:fen`, fen);
                if (fen) {
                    await redis.rPush(`${streamKey}:fens`, fen);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }

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

                return;
            }

            // ===================== UNDO (direct) =====================
            if (data.type === 'undo') {
                const fen = (data.fen && data.fen.length) ? data.fen : (await redis.get(`${streamKey}:fen`)) || '';
                const id = await redis.xAdd(streamKey, '*', { type: 'undo', fen });

                if (fen) {
                    await redis.set(`${streamKey}:fen`, fen);
                    await redis.rPush(`${streamKey}:fens`, fen);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'undo',
                            streamId: id,
                            fen: fen || undefined
                        }));
                    }
                });

                return;
            }

            // ===================== UNDO REQUEST =====================
            if (data.type === 'undo_request') {
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo_request',
                    from: ws.color || data.from || 'unknown',
                    state: 'pending'
                });

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'undo_request',
                            streamId: id,
                            from: ws.color,
                            state: 'pending'
                        }));
                    }
                });

                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'undo_request_sent', streamId: id, state: 'pending' }));
                }
                return;
            }

            // ===================== UNDO ACCEPT =====================
            if (data.type === 'undo_accept') {
                let fenCandidate = '';
                if (data.fen && data.fen.length) fenCandidate = data.fen;
                else fenCandidate = await getFenFromRecentList(streamKey, 1);

                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo',
                    requestId: data.requestId || '',
                    acceptedBy: ws.color || data.by || 'unknown',
                    fen: fenCandidate,
                    state: 'accepted'
                });

                if (fenCandidate) {
                    await redis.set(`${streamKey}:fen`, fenCandidate);
                    await redis.rPush(`${streamKey}:fens`, fenCandidate);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }

                const persistedFen = (await redis.get(`${streamKey}:fen`)) || fenCandidate;

                wss.clients.forEach((client) => {
                    if (client.readyState === 1 && client.gameId === gameId) {
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

                return;
            }

            // ===================== UNDO REJECT =====================
            if (data.type === 'undo_reject') {
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'undo_reject',
                    requestId: data.requestId || '',
                    rejectedBy: ws.color || data.by || 'unknown',
                    state: 'rejected'
                });

                wss.clients.forEach((client) => {
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

                return;
            }

            // ===================== RESET =====================
            if (data.type === 'reset') {
                const fen = data.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
                const id = await redis.xAdd(streamKey, '*', { type: 'reset', fen });

                await redis.set(`${streamKey}:fen`, fen);
                await redis.rPush(`${streamKey}:fens`, fen);
                await redis.lTrim(`${streamKey}:fens`, -1000, -1);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'reset',
                            streamId: id,
                            fen
                        }));
                    }
                });

                return;
            }

            // ===================== RESYNC =====================
            if (data.type === 'resync') {
                const snapshotFen = await redis.get(`${streamKey}:fen`);
                if (snapshotFen) {
                    ws.send(JSON.stringify({ type: 'snapshot', fen: snapshotFen }));
                }

                const meta = await redis.hGetAll(`${streamKey}:meta`);
                const finished = meta && meta.finished === '1';

                if (finished) {
                    ws.send(JSON.stringify({
                        type: 'game_result',
                        gameId,
                        result: meta.result || '',
                        reason: meta.reason || 'finished',
                        loser: meta.loser || null,
                        winner: meta.winner || null,
                        finalFen: meta.finalFen || snapshotFen || null
                    }));
                }

                // Send clock snapshot
                try {
                    const clock = await getOrInitClock(redis, cassandra, gameId);
                    settleClock(clock, Date.now());
                    await saveClock(redis, gameId, clock);

                    ws.send(JSON.stringify({
                        type: "clock_state",
                        gameId,
                        whiteMs: clock.w_ms,
                        blackMs: clock.b_ms,
                        active: clock.active,
                        running: clock.running,
                        incMs: clock.inc_ms,
                        timeControl: clock.tc || null,
                        serverNow: Date.now()
                    }));
                } catch (e) {
                    console.warn("[clock] resync clock failed:", e);
                }

                return;
            }

            // ===================== GAME OVER (from client) =====================
            if (data.type === 'game_over') {
                const result = data.result || null;
                const reason = data.reason || null;
                const endFen = data.fen || (await redis.get(`${streamKey}:fen`)) || null;

                try {
                    await handleGameOver({
                        gameId,
                        result,
                        reason,
                        finalFen: endFen,
                        endTime: new Date(),
                        wss,
                        redis,
                        cassandra
                    });
                } catch (e) {
                    console.error('[ERROR] handleGameOver failed:', e);
                } finally {
                    stopGameTicker(gameId);
                }
                return;
            }

        } catch (err) {
            console.error(`[ERROR] ${err.message}`);
        }
    });

    ws.on('close', () => {
        console.log(`[INFO] WebSocket disconnected: gameId=${gameId}, color=${color}`);
    });
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Debug stream
app.get('/debug/stream/:gameId', async (req, res) => {
    const { gameId } = req.params;
    const streamKey = `game:${gameId}`;
    try {
        const entries = await redis.xRevRange(streamKey, '+', '-', { COUNT: 10 });
        const result = entries.map(([id, fields]) => {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            return { id, ...obj };
        });
        res.json(result);
    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===================== HELPERS =====================

async function getFenFromRecentList(streamKey, plies = 1) {
    const listKey = `${streamKey}:fens`;
    const idx = -1 - plies;

    try {
        const fen = await redis.lIndex(listKey, idx);
        if (fen) return fen;
    } catch (_) { }

    const snapshot = await redis.get(`${streamKey}:fen`);
    if (snapshot) return snapshot;

    return await computeFenFromStreamHistory(streamKey, plies);
}

async function getSanMovesFromRedisStream(redis, gameId, max = 5000) {
    const streamKey = `game:${gameId}`;
    const entries = (await redis.xRange(streamKey, "-", "+", { COUNT: max })) || [];
    const sanMoves = [];

    for (const entry of entries) {
        if (!entry || !entry.message) continue;
        const msg = entry.message;
        const type = msg.type?.toString?.() || msg.type;
        if (type !== "move") continue;

        const moveRaw = msg.move?.toString?.() || msg.move;
        if (!moveRaw) continue;

        try {
            const mv = JSON.parse(moveRaw);
            if (mv?.san) sanMoves.push(mv.san);
        } catch (_) { }
    }

    return sanMoves;
}

async function computeFenFromStreamHistory(streamKey, plies = 1) {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const COUNT = 1000;
    const entries = await redis.xRevRange(streamKey, '+', '-', { COUNT });

    const fens = [];
    let lastAdded = null;

    for (const [id, fields] of entries) {
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

        const type = (obj.type || '').toString();
        if (!['move', 'reset', 'undo'].includes(type)) continue;

        const fen = obj.fen && obj.fen.toString ? obj.fen.toString() : obj.fen;
        if (!fen) continue;
        if (fen === lastAdded) continue;

        fens.push(fen);
        lastAdded = fen;
    }

    if (fens.length === 0) return START_FEN;
    if (plies >= fens.length) return fens[fens.length - 1] || START_FEN;
    return fens[plies];
}

// ===================== CLOCK =====================

function parseTimeControl(tc) {
    const s = (tc || "5+0").toString().trim();
    const m = s.match(/^(\d+)\s*\+\s*(\d+)$/);
    const baseMin = m ? parseInt(m[1], 10) : 5;
    const incSec = m ? parseInt(m[2], 10) : 0;
    return { baseMs: baseMin * 60_000, incMs: incSec * 1000, tc: `${baseMin}+${incSec}` };
}

async function getOrInitClock(redis, cassandra, gameId) {
    const clockKey = `game:${gameId}:clock`;
    const existing = await redis.hGetAll(clockKey);

    if (existing && Object.keys(existing).length > 0) {
        return {
            w_ms: parseInt(existing.w_ms || "0", 10),
            b_ms: parseInt(existing.b_ms || "0", 10),
            active: existing.active || "w",
            running: existing.running === "1",
            last_tick: parseInt(existing.last_tick || "0", 10),
            inc_ms: parseInt(existing.inc_ms || "0", 10),
            tc: existing.tc || null
        };
    }

    let timeControl = "5+0";
    try {
        const mRes = await cassandra.execute(
            `SELECT tournament_id FROM matches_by_game WHERE game_id = ?`,
            [gameId],
            { prepare: true }
        );
        if (mRes.rowLength) {
            const tid = mRes.rows[0].tournament_id;
            if (tid) {
                const tRes = await cassandra.execute(
                    `SELECT time_control FROM tournaments WHERE tournament_id = ?`,
                    [tid],
                    { prepare: true }
                );
                if (tRes.rowLength && tRes.rows[0].time_control) {
                    timeControl = tRes.rows[0].time_control;
                }
            }
        }
    } catch (_) { }

    const { baseMs, incMs, tc } = parseTimeControl(timeControl);

    const init = {
        w_ms: baseMs,
        b_ms: baseMs,
        active: "w",
        running: false,
        last_tick: 0,
        inc_ms: incMs,
        tc
    };

    await redis.hSet(clockKey, {
        w_ms: String(init.w_ms),
        b_ms: String(init.b_ms),
        active: init.active,
        running: "0",
        last_tick: "0",
        inc_ms: String(init.inc_ms),
        tc: init.tc
    });

    return init;
}

async function saveClock(redis, gameId, clock) {
    const clockKey = `game:${gameId}:clock`;
    await redis.hSet(clockKey, {
        w_ms: String(clock.w_ms),
        b_ms: String(clock.b_ms),
        active: clock.active,
        running: clock.running ? "1" : "0",
        last_tick: String(clock.last_tick || 0),
        inc_ms: String(clock.inc_ms || 0),
        tc: clock.tc || ""
    });
}

function broadcastClock(wss, gameId, clock) {
    const payload = JSON.stringify({
        type: "clock_state",
        gameId,
        whiteMs: clock.w_ms,
        blackMs: clock.b_ms,
        active: clock.active,
        running: clock.running,
        incMs: clock.inc_ms,
        timeControl: clock.tc || null,
        serverNow: Date.now()
    });

    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.gameId === gameId) {
            client.send(payload);
        }
    });
}

function settleClock(clock, nowMs) {
    if (!clock.running || !clock.last_tick) return { flag: false };

    const elapsed = Math.max(0, nowMs - clock.last_tick);

    if (clock.active === "w") {
        clock.w_ms -= elapsed;
        if (clock.w_ms <= 0) { clock.w_ms = 0; return { flag: true, loser: "w" }; }
    } else {
        clock.b_ms -= elapsed;
        if (clock.b_ms <= 0) { clock.b_ms = 0; return { flag: true, loser: "b" }; }
    }

    clock.last_tick = nowMs;
    return { flag: false };
}

// ===================== GAME OVER PIPELINE =====================

async function handleGameOver({
    gameId,
    result,
    reason,
    finalFen,
    endTime = new Date(),
    loser = null,
    winner = null,
    wss,
    redis,
    cassandra
}) {
    const streamKey = `game:${gameId}`;

    // ✅ idempotency guard: if already finished, do nothing (prevents double DB writes)
    const prev = await redis.hGetAll(`${streamKey}:meta`);
    if (prev && prev.finished === "1" && prev.result) {
        return;
    }

    console.log(`[INFO] handleGameOver game=${gameId}: result=${result}, reason=${reason}`);

    // mark finished in Redis first (idempotent)
    await redis.hSet(`${streamKey}:meta`, {
        finished: '1',
        result: result || '',
        reason: reason || '',
        finalFen: finalFen || '',
        loser: loser || '',
        winner: winner || ''
    });

    // stop ticking now that game ended
    stopGameTicker(gameId);

    // broadcast result
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.gameId === gameId) {
            client.send(JSON.stringify({
                type: 'game_result',
                gameId,
                result,
                reason,
                loser: loser || null,
                winner: winner || null,
                finalFen: finalFen || null
            }));
        }
    });

    // If result missing, don’t write DB
    if (!result) {
        console.warn(`[WARN] handleGameOver: missing result for game=${gameId}, skipping DB writes`);
        return;
    }

    // 1) Look up match
    const matchRes = await cassandra.execute(
        `
      SELECT tournament_id, round, board_number, white_player, black_player
      FROM matches_by_game
      WHERE game_id = ?
    `,
        [gameId],
        { prepare: true }
    );

    if (!matchRes.rowLength) {
        console.warn(`[WARN] handleGameOver: no match found in matches_by_game for game_id=${gameId}`);
        return;
    }

    const row = matchRes.rows[0];
    const tournamentId = row.tournament_id;
    const round = row.round;
    const boardNumber = row.board_number;
    const whiteId = row.white_player;
    const blackId = row.black_player;

    // scoring
    let whiteDelta = 0;
    let blackDelta = 0;

    if (result === '1-0') { whiteDelta = 1.0; blackDelta = 0.0; }
    else if (result === '0-1') { whiteDelta = 0.0; blackDelta = 1.0; }
    else if (result === '1/2-1/2') { whiteDelta = 0.5; blackDelta = 0.5; }
    else console.warn(`[WARN] handleGameOver: unknown result="${result}" – skipping leaderboard update`);

    // Update leaderboard (draw also allowed)
    if (result === '1/2-1/2' || whiteDelta > 0 || blackDelta > 0) {
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

        console.log(`[INFO] Updated leaderboard: white=${whiteId} -> ${whiteNew}, black=${blackId} -> ${blackNew}`);
    }

    // 2) Update matches
    await cassandra.execute(
        `
      UPDATE matches
      SET result = ?, end_time = ?, final_fen = ?
      WHERE tournament_id = ? AND round = ? AND board_number = ?
    `,
        [result, endTime, finalFen, tournamentId, round, boardNumber],
        { prepare: true }
    );

    // 3) Update matches_by_game
    await cassandra.execute(
        `
      UPDATE matches_by_game
      SET result = ?, end_time = ?
      WHERE game_id = ?
    `,
        [result, endTime, gameId],
        { prepare: true }
    );

    // 3.5) Archive (idempotent)
    try {
        const checkRes = await cassandra.execute(
            'SELECT game_id FROM game_archive_by_id WHERE game_id = ?',
            [gameId],
            { prepare: true }
        );

        if (!checkRes.rowLength) {
            const sanMoves = await getSanMovesFromRedisStream(redis, gameId);

            let startedAt = null;
            try {
                const startedRes = await cassandra.execute(
                    `
            SELECT start_time
            FROM matches
            WHERE tournament_id = ? AND round = ? AND board_number = ?
          `,
                    [tournamentId, round, boardNumber],
                    { prepare: true }
                );
                if (startedRes.rowLength) startedAt = startedRes.rows[0].start_time;
            } catch (e) {
                console.warn('[archive] could not fetch start_time, using null', e);
            }

            const createdAt = new Date();

            let timeControl = null;
            try {
                const tInfo = await cassandra.execute(
                    "SELECT time_control FROM tournaments WHERE tournament_id = ?",
                    [tournamentId],
                    { prepare: true }
                );
                if (tInfo.rowLength) timeControl = tInfo.rows[0].time_control || null;
            } catch (_) { }

            await cassandra.execute(
                `
          INSERT INTO game_archive_by_id (
            game_id, tournament_id, round, board_number,
            white_player, black_player,
            result, reason,
            start_time, end_time,
            final_fen, time_control,
            san_moves, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                [
                    gameId,
                    tournamentId,
                    round,
                    boardNumber,
                    whiteId,
                    blackId,
                    result || "",
                    reason || "",
                    startedAt,
                    endTime,
                    finalFen || "",
                    timeControl,
                    sanMoves,
                    createdAt
                ],
                { prepare: true }
            );

            console.log(`[INFO] Archived game ${gameId} with ${sanMoves.length} moves`);
        }
    } catch (archiveErr) {
        console.error('[ERROR] archiving game failed:', archiveErr);
    }

    // 4) Auto-mark round finished if all games have result
    try {
        const rRes = await cassandra.execute(
            `
        SELECT board_number, result
        FROM matches
        WHERE tournament_id = ? AND round = ?
      `,
            [tournamentId, round],
            { prepare: true }
        );

        const unfinished = rRes.rows.filter(r => !r.result);
        if (unfinished.length === 0) {
            const nowRound = new Date();
            await cassandra.execute(
                `
          UPDATE rounds_by_tournament
          SET finished_at = ?
          WHERE tournament_id = ? AND round = ?
        `,
                [nowRound, tournamentId, round],
                { prepare: true }
            );

            console.log(`[INFO] Auto-marked round ${round} finished for tournament ${tournamentId}`);

            // Optional auto-finish non-single-elim tournaments
            const tRes = await cassandra.execute(
                'SELECT type FROM tournaments WHERE tournament_id = ?',
                [tournamentId],
                { prepare: true }
            );

            if (tRes.rowLength) {
                const type = tRes.rows[0].type;
                if (type && type !== 'single_elim') {
                    const lbRes = await cassandra.execute(
                        `
              SELECT player_id, points
              FROM leaderboard_by_player
              WHERE tournament_id = ?
            `,
                        [tournamentId],
                        { prepare: true }
                    );

                    if (lbRes.rowLength) {
                        let bestPts = -Infinity;
                        let leaderIds = [];

                        for (const r of lbRes.rows) {
                            const pts = r.points;
                            if (pts > bestPts) { bestPts = pts; leaderIds = [r.player_id]; }
                            else if (pts === bestPts) leaderIds.push(r.player_id);
                        }

                        if (leaderIds.length === 1) {
                            const championId = leaderIds[0];
                            await cassandra.execute(
                                `
                  UPDATE tournaments
                  SET status = ?, winner_id = ?
                  WHERE tournament_id = ?
                `,
                                ['finished', championId, tournamentId],
                                { prepare: true }
                            );
                            console.log(`[INFO] Tournament ${tournamentId} auto-finished. Winner=${championId}`);
                        }
                    }
                }
            }
        }
    } catch (autoErr) {
        console.error('[ERROR] auto-finalization failed:', autoErr);
    }
}
