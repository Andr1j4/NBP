const { buildPairedMovesFromSan } = require("./broadcast");
const { getOrInitClock, settleClock, saveClock } = require("./game");
const { getSanMovesFromRedisStream } = require("./archive");

async function buildViewerSnapshot(redis, cassandra, gameId) {
    const streamKey = `game:${gameId}`;

    const fen = (await redis.get(`${streamKey}:fen`)) || "";
    const meta = await redis.hGetAll(`${streamKey}:meta`);

    // clock is optional for viewer; don't allow it to kill snapshot
    let clockPayload = {
        whiteMs: null,
        blackMs: null,
        active: null,
        running: false,
        incMs: null,
        timeControl: null,
        serverNow: Date.now(),
    };

    try {
        const clock = await getOrInitClock(redis, cassandra, gameId);
        settleClock(clock, Date.now());
        await saveClock(redis, gameId, clock);

        clockPayload = {
            whiteMs: clock.w_ms,
            blackMs: clock.b_ms,
            active: clock.active,
            running: !!clock.running,
            incMs: clock.inc_ms,
            timeControl: clock.tc || null,
            serverNow: Date.now(),
        };
    } catch (e) {
        console.warn("[viewer] clock failed for", gameId, e);
    }

    let moves = [];
    try {
        const sanMoves = await getSanMovesFromRedisStream(redis, gameId, 5000);
        moves = buildPairedMovesFromSan(sanMoves);
    } catch (e) {
        console.warn("[viewer] moves failed for", gameId, e);
    }

    return {
        type: "viewer_snapshot",
        gameId,
        fen,
        meta: {
            finished: meta?.finished === "1",
            result: meta?.result || "",
            reason: meta?.reason || "",
            loser: meta?.loser || "",
            winner: meta?.winner || "",
            finalFen: meta?.finalFen || "",
        },
        clock: clockPayload,
        moves,
    };
}

module.exports = { buildViewerSnapshot };
