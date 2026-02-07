const { normalizeUuid, asUuid } = require("../utils/uuid");
const {
    settleClock,
    getOrInitClock,
    saveClock,
    scheduleTimeoutKey,
} = require("../utils/game");
const { broadcastToGame, broadcastClock } = require("../utils/broadcast");
const { handleGameOver } = require("../utils/gameOver");

async function handleGameConnection(ws, req, gameId, cassandra, redis, wss) {
    const jwtToken = require("../utils/wsAuth").getJwtFromWsReq(req);
    const jwtUser = jwtToken ? require("../utils/token").verifyJwt(jwtToken) : null;

    const playToken = require("../utils/wsAuth").getPlayFromWsReq(req);
    const play = playToken ? require("../utils/token").verifyPlayToken(playToken) : null;

    // Decide identity
    let identity = null;
    if (jwtUser?.player_id) {
        identity = { auth: "jwt", ...jwtUser };
    } else if (play && normalizeUuid(play.gameId) === normalizeUuid(gameId) && play.player_id) {
        identity = { auth: "playlink", player_id: play.player_id, color: play.color };
    }

    ws.user = identity;

    // Assign color
    let assignedColor = "spectator";
    let player_id = identity?.player_id || null;

    if (identity?.auth === "playlink") {
        assignedColor = identity.color === "w" ? "w" : identity.color === "b" ? "b" : "spectator";
    } else if (identity?.auth === "jwt") {
        try {
            const matchRes = await cassandra.execute(
                "SELECT white_player, black_player FROM matches_by_game WHERE game_id = ?",
                [gameId],
                { prepare: true }
            );
            if (matchRes.rowLength) {
                const { white_player, black_player } = matchRes.rows[0];

                const me = normalizeUuid(identity.player_id);
                const w = normalizeUuid(white_player);
                const b = normalizeUuid(black_player);

                if (me && w && me === w) assignedColor = "w";
                else if (me && b && me === b) assignedColor = "b";
            }
        } catch (e) {
            console.warn("[WS] side lookup failed:", e);
        }
    }

    ws.color = assignedColor;
    ws.player_id = player_id;

    // welcome
    ws.send(
        JSON.stringify({
            type: "welcome",
            gameId,
            color: ws.color,
            user: identity
                ? {
                    auth: identity.auth,
                    email: identity.email || null,
                    role: identity.role || "user",
                    player_id: identity.player_id || null,
                }
                : null,
        })
    );

    const streamKey = `game:${gameId}`;

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            const meta = await redis.hGetAll(`${streamKey}:meta`);
            const isFinished = meta?.finished === "1";

            // spectators are read-only except resync
            if (ws.color === "spectator" && data.type !== "resync") {
                ws.send(JSON.stringify({ type: "error", reason: "spectator_read_only" }));
                return;
            }

            if (isFinished && data.type !== "resync" && data.type !== "game_over") {
                ws.send(
                    JSON.stringify({
                        type: "game_finished",
                        gameId,
                        reason: "already_finished",
                        result: meta.result || "",
                        finalFen: meta.finalFen || null,
                    })
                );
                return;
            }

            // ---- MOVE ----
            if (data.type === "move") {
                if (ws.color !== "w" && ws.color !== "b") {
                    ws.send(JSON.stringify({ type: "error", reason: "not_a_player" }));
                    return;
                }

                // enforce side
                if (ws.player_id) {
                    try {
                        const matchRes = await cassandra.execute(
                            "SELECT white_player, black_player FROM matches_by_game WHERE game_id = ?",
                            [gameId],
                            { prepare: true }
                        );
                        if (matchRes.rowLength) {
                            const { white_player, black_player } = matchRes.rows[0];
                            const expected = ws.color === "w" ? white_player : black_player;
                            if (normalizeUuid(expected) !== normalizeUuid(ws.player_id)) {
                                ws.send(JSON.stringify({ type: "error", reason: "not_authorized_for_side" }));
                                return;
                            }
                        }
                    } catch { }
                }

                // ...existing game logic...
                const nowMs = Date.now();
                const clock = await getOrInitClock(redis, cassandra, gameId);

                if (!clock.running) {
                    clock.running = true;
                    clock.active = ws.color;
                    clock.last_tick = nowMs;
                }

                const settle = settleClock(clock, nowMs);

                if (settle.flag) {
                    const loser = settle.loser;
                    const winner = loser === "w" ? "b" : "w";
                    const result = loser === "w" ? "0-1" : "1-0";
                    const reason = "timeout";
                    const finalFen = (await redis.get(`${streamKey}:fen`)) || "";

                    await saveClock(redis, gameId, clock);
                    broadcastClock(wss, gameId, clock);

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
                        cassandra,
                    });

                    await redis.del(`game:${gameId}:timeout`);
                    return;
                }

                if (ws.color === "w") clock.w_ms += clock.inc_ms || 0;
                else clock.b_ms += clock.inc_ms || 0;

                clock.active = ws.color === "w" ? "b" : "w";
                clock.last_tick = nowMs;

                await saveClock(redis, gameId, clock);
                broadcastClock(wss, gameId, clock);
                await scheduleTimeoutKey(redis, gameId, clock);

                const fen = data.fen || "";
                const id = await redis.xAdd(streamKey, "*", {
                    type: "move",
                    move: JSON.stringify(data.move),
                    fen,
                });

                if (fen) await redis.set(`${streamKey}:fen`, fen);
                if (fen) {
                    await redis.rPush(`${streamKey}:fens`, fen);
                    await redis.lTrim(`${streamKey}:fens`, -1000, -1);
                }

                broadcastToGame(
                    wss,
                    gameId,
                    { type: "move", gameId, move: data.move, streamId: id, fen: fen || undefined },
                    ws
                );
                return;
            }

            // ---- RESET ----
            if (data.type === "reset") {
                const fen = data.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

                const id = await redis.xAdd(streamKey, "*", { type: "reset", fen });

                await redis.set(`${streamKey}:fen`, fen);
                await redis.rPush(`${streamKey}:fens`, fen);
                await redis.lTrim(`${streamKey}:fens`, -1000, -1);

                const clock = await getOrInitClock(redis, cassandra, gameId);
                clock.w_ms = clock.w_ms;
                clock.b_ms = clock.b_ms;
                clock.active = "w";
                clock.running = false;
                clock.last_tick = 0;

                await saveClock(redis, gameId, clock);
                broadcastClock(wss, gameId, clock);
                await scheduleTimeoutKey(redis, gameId, clock);

                broadcastToGame(wss, gameId, { type: "reset", gameId, streamId: id, fen, moves: [] });
                return;
            }

            // ---- RESYNC ----
            if (data.type === "resync") {
                const snapshotFen = await redis.get(`${streamKey}:fen`);
                if (snapshotFen) ws.send(JSON.stringify({ type: "snapshot", fen: snapshotFen }));

                const meta2 = await redis.hGetAll(`${streamKey}:meta`);
                if (meta2?.finished === "1") {
                    ws.send(
                        JSON.stringify({
                            type: "game_result",
                            gameId,
                            result: meta2.result || "",
                            reason: meta2.reason || "finished",
                            loser: meta2.loser || null,
                            winner: meta2.winner || null,
                            finalFen: meta2.finalFen || snapshotFen || null,
                        })
                    );
                }

                const clock = await getOrInitClock(redis, cassandra, gameId);
                settleClock(clock, Date.now());
                await saveClock(redis, gameId, clock);

                ws.send(
                    JSON.stringify({
                        type: "clock_state",
                        gameId,
                        whiteMs: clock.w_ms,
                        blackMs: clock.b_ms,
                        active: clock.active,
                        running: clock.running,
                        incMs: clock.inc_ms,
                        timeControl: clock.tc || null,
                        serverNow: Date.now(),
                    })
                );

                await scheduleTimeoutKey(redis, gameId, clock);
                return;
            }

            // ---- GAME OVER ----
            if (data.type === "game_over") {
                const result = data.result || null;
                const reason = data.reason || null;
                const endFen = data.fen || (await redis.get(`${streamKey}:fen`)) || null;

                await handleGameOver({
                    gameId,
                    result,
                    reason,
                    finalFen: endFen,
                    endTime: new Date(),
                    wss,
                    redis,
                    cassandra,
                });

                await redis.del(`game:${gameId}:timeout`);
                return;
            }
        } catch (e) {
            console.error("[WS] message error:", e?.message || e);
        }
    });

    ws.on("close", () => {
        console.log(`[INFO] WS disconnected gameId=${ws.gameId} color=${ws.color}`);
    });
}

module.exports = { handleGameConnection };
