const { asUuid } = require("./uuid");

async function getSanMovesFromRedisStream(redisClient, gameId, max = 5000) {
    const streamKey = `game:${gameId}`;
    const entries = (await redisClient.xRange(streamKey, "-", "+", { COUNT: max })) || [];

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
            continue;
        }

        if (Array.isArray(entry) && entry.length === 2) {
            const fields = entry[1];
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

            if ((obj.type || "").toString() !== "move") continue;
            const moveRaw = (obj.move || "").toString();
            if (!moveRaw) continue;

            try {
                const mv = JSON.parse(moveRaw);
                if (mv?.san) sanMoves.push(mv.san);
            } catch (_) { }
        }
    }

    return sanMoves;
}

function parseArchiveSanMoves(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;

    if (typeof raw === "string") {
        try {
            const j = JSON.parse(raw);
            if (Array.isArray(j)) return j;
        } catch (_) { }

        const s = raw.trim();
        if (s.startsWith("[") && s.endsWith("]")) {
            return s
                .slice(1, -1)
                .split(",")
                .map(x => x.trim())
                .filter(Boolean);
        }
    }
    return [];
}

async function archiveGameResult(cassandraClient, {
    gameId,
    tournamentId,
    round,
    boardNumber,
    whiteId,
    blackId,
    result,
    reason,
    finalFen,
    sanMoves,
    startedAt,
    endTime,
    timeControl,
}) {
    try {
        await cassandraClient.execute(
            `
            INSERT INTO turnir.game_archive_by_id (
                game_id, tournament_id, round, board_number,
                white_player, black_player,
                result, reason,
                start_time, end_time,
                final_fen, time_control,
                san_moves, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            IF NOT EXISTS
            `,
            [
                asUuid(gameId, "gameId"),
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
                new Date(),
            ],
            { prepare: true }
        );

        console.log("[archiveGameResult] inserted", { gameId, sanMoves: sanMoves?.length || 0 });
        return true;
    } catch (e) {
        console.error("[archiveGameResult] failed", { gameId, err: e });
        return false;
    }
}

module.exports = {
    getSanMovesFromRedisStream,
    parseArchiveSanMoves,
    archiveGameResult,
};
