// back/controllers/gameController.js
const cassandra = require("../db/cassandra");
const { types } = require("cassandra-driver");

function asUuid(value, label = "uuid") {
    if (!value) throw new Error(`Missing ${label}`);
    if (typeof value === "string") return types.Uuid.fromString(value);
    // cassandra-driver sometimes returns Uuid objects already
    if (value instanceof types.Uuid) return value;
    // if object with toString
    if (typeof value.toString === "function") return types.Uuid.fromString(value.toString());
    throw new Error(`Invalid ${label}: ${String(value)}`);
}


async function getGameMovesFromRedis(req, res) {
    const { gameId } = req.params;
    const redis = req.app.locals.redis;
    const streamKey = `game:${gameId}`;

    try {
        const entries = (await redis.xRange(streamKey, "-", "+", { COUNT: 2000 })) || [];

        const sanMoves = [];

        // redis v4 style: [{ id, message: {...} }, ...]
        for (const entry of entries) {
            if (!entry || !entry.message) continue;

            const obj = {};
            for (const [k, v] of Object.entries(entry.message)) {
                obj[k] = v && v.toString ? v.toString() : v;
            }

            if (obj.type === "move" && obj.move) {
                try {
                    const mv = JSON.parse(obj.move);
                    if (mv?.san) sanMoves.push(mv.san);
                } catch (e) {
                    // ignore bad move rows
                }
            }
        }

        const moves = [];
        for (let i = 0; i < sanMoves.length; i += 2) {
            moves.push({
                moveNumber: i / 2 + 1,
                white: sanMoves[i] || "",
                black: sanMoves[i + 1] || "",
            });
        }

        return res.json({ gameId, moves });
    } catch (err) {
        console.error("[ERROR] getGameMovesFromRedis", err);
        return res.status(500).json({ error: "Internal server error" });
    }
}

async function getGameArchiveFromCassandra(req, res) {
    const { gameId } = req.params;

    try {
        const q = `
      SELECT game_id, tournament_id, round, board_number,
             white_player, black_player,
             result, reason, start_time, end_time,
             final_fen, san_moves, time_control, created_at
      FROM turnir.game_archive_by_id
      WHERE game_id = ?
    `;

        const r = await cassandra.execute(q, [asUuid(gameId, "gameId")], { prepare: true });

        if (!r.rowLength) {
            return res.status(404).json({ error: "archive_not_found" });
        }

        const row = r.rows[0];

        return res.json({
            gameId: row.game_id.toString(),
            tournamentId: row.tournament_id?.toString() || null,
            round: row.round ?? null,
            boardNumber: row.board_number ?? null,
            whitePlayer: row.white_player?.toString() || null,
            blackPlayer: row.black_player?.toString() || null,
            result: row.result || "",
            reason: row.reason || "",
            start_time: row.start_time || null,
            end_time: row.end_time || null,
            finalFen: row.final_fen || null,
            sanMoves: row.san_moves || [],
            timeControl: row.time_control || null,
            createdAt: row.created_at || null,
        });
    } catch (err) {
        console.error("[ERROR] getGameArchiveFromCassandra:", err);
        return res.status(500).json({ error: "internal_server_error" });
    }
}

module.exports = { getGameArchiveFromCassandra };


module.exports = {
    getGameMovesFromRedis,
    getGameArchiveFromCassandra,
};
