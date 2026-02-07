const { types } = require("cassandra-driver");

async function getSanMovesFromRedisStream(redis, gameId, max = 5000) {
    const streamKey = `game:${gameId}`;
    const entries = (await redis.xRange(streamKey, "-", "+", { COUNT: max })) || [];

    const sanMoves = [];

    for (const entry of entries) {
        if (entry && entry.message) {
            const msg = entry.message;
            if ((msg.type || "").toString() !== "move") continue;

            const moveRaw = (msg.move || "").toString();
            if (!moveRaw) continue;

            try {
                const mv = JSON.parse(moveRaw);
                if (mv?.san) sanMoves.push(mv.san);
            } catch (_) { }
        }
    }

    return sanMoves;
}

async function loadPlayerMap(cassandra, playerIds) {
    if (!playerIds || playerIds.length === 0) return {};

    const map = {};
    for (const pid of playerIds) {
        try {
            const res = await cassandra.execute(
                "SELECT player_id, first_name, rating FROM players WHERE player_id = ?",
                [pid],
                { prepare: true }
            );
            if (res.rowLength) {
                const row = res.rows[0];
                map[pid.toString()] = {
                    name: row.first_name,
                    rating: row.rating,
                };
            }
        } catch (e) {
            console.warn("[loadPlayerMap] failed for", pid, e);
        }
    }
    return map;
}

module.exports = { getSanMovesFromRedisStream, loadPlayerMap };
