const { asUuid } = require("./uuid");
const { getSanMovesFromRedisStream } = require("./archive");
const { broadcastToGame } = require("./broadcast");

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
    cassandra,
}) {
    const streamKey = `game:${gameId}`;
    const t0 = Date.now();

    console.log("[handleGameOver] START", {
        gameId,
        result,
        reason,
        endTime: endTime?.toISOString?.() || endTime,
    });

    // 1) mark redis finished
    try {
        await redis.hSet(`${streamKey}:meta`, {
            finished: "1",
            result: result || "",
            reason: reason || "",
            finalFen: finalFen || "",
            loser: loser || "",
            winner: winner || "",
        });
        await redis.del(`${streamKey}:timeout`);
    } catch (e) {
        console.error("[handleGameOver] redis meta write failed", e);
    }

    // 2) broadcast result
    try {
        broadcastToGame(wss, gameId, {
            type: "game_result",
            gameId,
            result,
            reason,
            loser: loser || null,
            winner: winner || null,
            finalFen: finalFen || null,
        });
    } catch (e) {
        console.warn("[handleGameOver] broadcast failed", e);
    }

    if (!result) {
        console.warn("[handleGameOver] missing result -> skipping cassandra writes", { gameId });
        return;
    }

    // 3) match lookup
    let tournamentId, round, boardNumber, whiteId, blackId;
    try {
        const matchRes = await cassandra.execute(
            `
      SELECT tournament_id, round, board_number, white_player, black_player
      FROM turnir.matches_by_game
      WHERE game_id = ?
      `,
            [asUuid(gameId, "gameId")],
            { prepare: true }
        );

        console.log("[handleGameOver] matches_by_game", { gameId, rows: matchRes.rowLength });

        if (!matchRes.rowLength) {
            console.error("[handleGameOver] STOP matches_by_game not found => cannot archive", { gameId });
            return;
        }

        const row = matchRes.rows[0];
        tournamentId = row.tournament_id;
        round = row.round;
        boardNumber = row.board_number;
        whiteId = row.white_player;
        blackId = row.black_player;
    } catch (e) {
        console.error("[handleGameOver] match lookup failed", e);
        return;
    }

    // 4) leaderboard (best-effort)
    try {
        let whiteDelta = 0;
        let blackDelta = 0;

        if (result === "1-0") {
            whiteDelta = 1.0;
            blackDelta = 0.0;
        } else if (result === "0-1") {
            whiteDelta = 0.0;
            blackDelta = 1.0;
        } else if (result === "1/2-1/2") {
            whiteDelta = 0.5;
            blackDelta = 0.5;
        }

        if (result === "1-0" || result === "0-1" || result === "1/2-1/2") {
            const whiteLB = await cassandra.execute(
                "SELECT points FROM turnir.leaderboard_by_player WHERE tournament_id = ? AND player_id = ?",
                [tournamentId, whiteId],
                { prepare: true }
            );
            const whiteCurrent = whiteLB.rowLength ? whiteLB.rows[0].points : 0.0;

            await cassandra.execute(
                "INSERT INTO turnir.leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)",
                [tournamentId, whiteId, whiteCurrent + whiteDelta],
                { prepare: true }
            );

            const blackLB = await cassandra.execute(
                "SELECT points FROM turnir.leaderboard_by_player WHERE tournament_id = ? AND player_id = ?",
                [tournamentId, blackId],
                { prepare: true }
            );
            const blackCurrent = blackLB.rowLength ? blackLB.rows[0].points : 0.0;

            await cassandra.execute(
                "INSERT INTO turnir.leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)",
                [tournamentId, blackId, blackCurrent + blackDelta],
                { prepare: true }
            );

            console.log("[handleGameOver] leaderboard updated", { gameId });
        }
    } catch (e) {
        console.warn("[handleGameOver] leaderboard update failed", e);
    }

    // 5) update matches tables
    try {
        await cassandra.execute(
            `
      UPDATE turnir.matches
      SET result = ?, end_time = ?, final_fen = ?
      WHERE tournament_id = ? AND round = ? AND board_number = ?
      `,
            [result, endTime, finalFen, tournamentId, round, boardNumber],
            { prepare: true }
        );

        await cassandra.execute(
            `
      UPDATE turnir.matches_by_game
      SET result = ?, end_time = ?
      WHERE game_id = ?
      `,
            [result, endTime, asUuid(gameId, "gameId")],
            { prepare: true }
        );

        console.log("[handleGameOver] matches updated", { gameId });
    } catch (e) {
        console.error("[handleGameOver] matches update failed", e);
    }

    // 6) archive insert
    try {
        let startedAt = null;
        try {
            const startedRes = await cassandra.execute(
                `
        SELECT start_time
        FROM turnir.matches
        WHERE tournament_id = ? AND round = ? AND board_number = ?
        `,
                [tournamentId, round, boardNumber],
                { prepare: true }
            );
            if (startedRes.rowLength) startedAt = startedRes.rows[0].start_time || null;
        } catch (e) {
            console.warn("[handleGameOver] archive start_time read failed", e);
        }

        let timeControl = null;
        try {
            const tRes = await cassandra.execute(
                "SELECT time_control FROM turnir.tournaments WHERE tournament_id = ?",
                [tournamentId],
                { prepare: true }
            );
            if (tRes.rowLength) timeControl = tRes.rows[0].time_control || null;
        } catch (e) {
            console.warn("[handleGameOver] archive time_control read failed", e);
        }

        let sanMoves = [];
        try {
            sanMoves = await getSanMovesFromRedisStream(redis, gameId, 5000);
        } catch (e) {
            console.warn("[handleGameOver] archive SAN read failed", e);
            sanMoves = [];
        }

        await cassandra.execute(
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

        console.log("[handleGameOver] archive insert", { gameId, sanMoves: sanMoves.length });
    } catch (e) {
        console.error("[handleGameOver] archive insert FAILED", { gameId, err: e });
    }

    // 7) auto-finish round
    try {
        const rRes = await cassandra.execute(
            `
      SELECT board_number, result
      FROM turnir.matches
      WHERE tournament_id = ? AND round = ?
      `,
            [tournamentId, round],
            { prepare: true }
        );
        const unfinished = rRes.rows.filter((r) => !r.result);
        if (unfinished.length === 0) {
            await cassandra.execute(
                `
        UPDATE turnir.rounds_by_tournament
        SET finished_at = ?
        WHERE tournament_id = ? AND round = ?
        `,
                [new Date(), tournamentId, round],
                { prepare: true }
            );
            console.log("[handleGameOver] round auto-finished", { tournamentId: String(tournamentId), round });
        }
    } catch (e) {
        console.warn("[handleGameOver] auto-finish-round failed", e);
    }

    console.log("[handleGameOver] DONE", { gameId, ms: Date.now() - t0 });
}

module.exports = { handleGameOver };
