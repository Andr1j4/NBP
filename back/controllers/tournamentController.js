const cassandra = require('../db/cassandra');
const { randomUUID } = require('crypto');
const { types } = require('cassandra-driver');
const { queryWithRetry } = require("../utils/cassandraHelper");


async function fetchPlayLink(gameId, player_id) {
    // call your own server endpoint

    const res = await fetch(`http://10.121.107.106:8080/api/games/${gameId}/playlink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id }),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || "playlink_failed");
    }
    return data; // { playUrl, token, color, ... }
}

function getPlayTokenFromWsReq(req) {
    try {
        const url = new URL(req.url, "http://localhost");
        return url.searchParams.get("play");
    } catch (_) {
        return null;
    }
}

function normalizeUuid(x) {
    if (!x) return null;
    return String(x).trim().toLowerCase();
}



// POST /api/tournaments
async function createTournament(req, res) {
    try {
        const {
            name,
            location,
            startDate,
            endDate,
            type = 'single_elim',
            timeControl = '5+0',
        } = req.body || {};

        console.log('[CREATE_TOURNAMENT] Starting tournament creation', {
            name,
            location,
            type,
            timeControl,
            timestamp: new Date().toISOString(),
        });

        if (!name) {
            console.warn('[CREATE_TOURNAMENT] Missing name field');
            return res.status(400).json({ error: 'name is required' });
        }

        const tournamentId = randomUUID();
        const now = new Date();

        console.log('[CREATE_TOURNAMENT] Generated tournamentId', { tournamentId });

        await cassandra.execute(
            `INSERT INTO tournaments (tournament_id, name, location, start_date, end_date, status, type, time_control, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tournamentId, name, location || null, startDate || null, endDate || null, 'registration', type, timeControl, now],
            { prepare: true }
        );

        console.log('[CREATE_TOURNAMENT] Successfully inserted to Cassandra', {
            tournamentId,
            name,
            status: 'registration',
        });

        const response = {
            id: tournamentId,
            tournamentId,
            name,
            location: location || null,
            startDate: startDate || null,
            endDate: endDate || null,
            status: 'registration',
            type,
            timeControl,
            createdAt: now
        };

        console.log('[CREATE_TOURNAMENT] Returning response', response);

        return res.status(201).json(response);
    } catch (err) {
        console.error('[CREATE_TOURNAMENT] ERROR', {
            error: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString(),
        });
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function registerPlayer(req, res) {
    try {
        const tournament_id = req.params.id;
        const { player_id, rating } = req.body || {};

        console.log('[REGISTER_PLAYER] Starting player registration', {
            tournament_id,
            player_id,
            rating,
            timestamp: new Date().toISOString(),
        });

        if (!player_id) {
            console.warn('[REGISTER_PLAYER] Missing player_id');
            return res.status(400).json({ error: 'player_id is required' });
        }

        const joined_at = new Date();

        await cassandra.execute(
            'INSERT INTO tournament_players (tournament_id, player_id, joined_at, rating) VALUES (?, ?, ?, ?)',
            [tournament_id, player_id, joined_at, rating],
            { prepare: true }
        );

        console.log('[REGISTER_PLAYER] Successfully registered player', {
            tournament_id,
            player_id,
            joined_at,
        });

        return res.status(201).json({
            tournament_id,
            player_id,
            joined_at,
        });
    } catch (err) {
        console.error('[REGISTER_PLAYER] ERROR', {
            error: err.message,
            tournament_id: req.params.id,
            player_id: req.body?.player_id,
            stack: err.stack,
        });
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function listTournamentPlayers(req, res) {
    try {
        const tournamentId = req.params.id;

        const result = await cassandra.execute(
            'SELECT player_id, joined_at, rating FROM tournament_players WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        res.json(result.rows);
    } catch (err) {
        console.error('[ERROR] listTournamentPlayers:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}


/**
 * POST /api/tournaments/:id/start
 * Body: { round?: number }
 */
/**
 * POST /api/tournaments/:id/start
 * Body: { round?: number }
 */
async function startRound(req, res) {
    try {
        const tournamentId = req.params.id;
        const requestedRound = req.body?.round; // optional

        console.log('[START_ROUND] Starting round creation', {
            tournamentId,
            requestedRound,
            timestamp: new Date().toISOString(),
        });

        // 1) Load tournament
        const tResult = await cassandra.execute(
            "SELECT tournament_id, status, type FROM tournaments WHERE tournament_id = ?",
            [tournamentId],
            { prepare: true }
        );

        if (!tResult.rowLength) {
            console.warn('[START_ROUND] Tournament not found', { tournamentId });
            return res.status(404).json({ error: "Tournament not found" });
        }

        const tournament = tResult.rows[0];
        const format = String(tournament.type || "single_elim").trim().toLowerCase();

        console.log('[START_ROUND] Loaded tournament', { tournamentId, format });

        // 2) Read existing rounds
        const roundsResult = await cassandra.execute(
            "SELECT round, finished_at FROM rounds_by_tournament WHERE tournament_id = ?",
            [tournamentId],
            { prepare: true }
        );

        const existingRounds = roundsResult.rows.map((r) => ({
            round: r.round,
            finished: !!r.finished_at,
        }));

        console.log('[START_ROUND] Existing rounds', { tournamentId, rounds: existingRounds });

        // 3) Decide which round to start
        let round = requestedRound;

        if (round) {
            const exists = existingRounds.find((r) => r.round === round);
            if (exists) {
                console.warn('[START_ROUND] Round already exists', { tournamentId, round });
                return res.status(400).json({ error: "This round already exists", round });
            }
        } else {
            if (existingRounds.length === 0) {
                round = 1;
            } else {
                const maxRound = Math.max(...existingRounds.map((r) => r.round));
                const lastRound = existingRounds.find((r) => r.round === maxRound);
                if (!lastRound.finished) {
                    console.warn('[START_ROUND] Previous round not finished', { tournamentId, maxRound });
                    return res.status(400).json({
                        error: "Previous round is not finished yet",
                        lastRound: maxRound,
                    });
                }
                round = maxRound + 1;
            }
        }

        console.log('[START_ROUND] Determined round number', { tournamentId, round, format });

        // 4) Load players
        let players = [];

        if (format === "single_elim") {
            if (round === 1) {
                // Round 1: load all registered tournament players
                const playersResult = await cassandra.execute(
                    "SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?",
                    [tournamentId],
                    { prepare: true }
                );

                players = playersResult.rows.map((r) => ({
                    id: r.player_id,
                    rating: r.rating,
                }));

                console.log('[START_ROUND] Loaded players for round 1', { tournamentId, playerCount: players.length });
            } else {
                // Round 2+: load WINNERS from previous round
                const prevRound = round - 1;
                const matchesResult = await cassandra.execute(
                    `
                    SELECT white_player, black_player, result
                    FROM matches
                    WHERE tournament_id = ? AND round = ?
                    `,
                    [tournamentId, prevRound],
                    { prepare: true }
                );

                if (!matchesResult.rowLength) {
                    console.warn('[START_ROUND] No matches from previous round', { tournamentId, prevRound });
                    return res.status(400).json({
                        error: `No matches found for previous round ${prevRound}`,
                    });
                }

                const winners = [];
                let hasUnfinished = false;
                let hasDraws = false;

                for (const row of matchesResult.rows) {
                    const { white_player, black_player, result } = row;

                    if (!result) {
                        hasUnfinished = true;
                        console.warn('[START_ROUND] Unfinished match found', { white: white_player, black: black_player });
                        continue;
                    }

                    if (result === "1-0") {
                        winners.push(white_player);
                    } else if (result === "0-1") {
                        winners.push(black_player);
                    } else if (result === "1/2-1/2") {
                        hasDraws = true;
                        console.warn('[START_ROUND] Draw found (needs resolution)', { white: white_player, black: black_player });
                    }
                }

                if (hasUnfinished || hasDraws) {
                    console.error('[START_ROUND] Cannot start KO round', { hasUnfinished, hasDraws });
                    return res.status(400).json({
                        error: "Cannot start next KO round: some games are unfinished or ended in a draw that needs tie-break.",
                        previousRound: prevRound,
                        details: { hasUnfinished, hasDraws },
                    });
                }

                if (winners.length < 2) {
                    console.warn('[START_ROUND] Not enough winners for next round', { winnersCount: winners.length });
                    return res.status(400).json({
                        error: "Not enough winners to create next round",
                        winnersCount: winners.length,
                    });
                }

                console.log('[START_ROUND] Found winners from previous round', {
                    tournamentId,
                    round,
                    prevRound,
                    winnerCount: winners.length,
                    winners: winners.map(w => String(w))
                });

                // ✅ FIX: umesto players, koristi tournament_players za ovaj turnir
                players = [];
                for (const pid of winners) {
                    const pRes = await cassandra.execute(
                        "SELECT player_id, rating FROM tournament_players WHERE tournament_id = ? AND player_id = ?",
                        [tournamentId, pid],
                        { prepare: true }
                    );
                    if (pRes.rowLength) {
                        players.push({
                            id: pRes.rows[0].player_id,
                            rating: pRes.rows[0].rating,
                        });
                    } else {
                        console.warn('[START_ROUND] Winner not found in tournament_players', {
                            tournamentId,
                            playerId: String(pid),
                        });
                    }
                }

                console.log('[START_ROUND] Loaded player details for winners', {
                    tournamentId,
                    round,
                    playerCount: players.length
                });
            }
        } else {
            // Swiss/Round-robin: load all players every round
            const playersResult = await cassandra.execute(
                "SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?",
                [tournamentId],
                { prepare: true }
            );

            players = playersResult.rows.map((r) => ({
                id: r.player_id,
                rating: r.rating,
            }));

            console.log('[START_ROUND] Loaded all players for', format, { tournamentId, playerCount: players.length });

            if (format === "round_robin") {
                const maxRounds = roundRobinTotalRounds(players.length);
                console.log('[START_ROUND] Round-robin maxRounds', { tournamentId, maxRounds, requested: round });
                if (round > maxRounds) {
                    // ✅ auto-finish tournament when max rounds reached
                    await cassandra.execute(
                        "UPDATE tournaments SET status = ? WHERE tournament_id = ?",
                        ["finished", tournamentId],
                        { prepare: true }
                    );
                    return res.status(400).json({
                        error: "round_robin_finished",
                        maxRounds,
                        requestedRound: round,
                    });
                }
            }
        }

        if (players.length < 2) {
            console.warn('[START_ROUND] Not enough players', { tournamentId, playerCount: players.length });
            return res.status(400).json({
                error: "Not enough players to start a round (need at least 2)",
                playersCount: players.length,
            });
        }

        // 5) Shuffle & build pairings
        const shuffled = [...players];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const pairings = [];
        const byes = [];  // ✅ Track bye rounds

        for (let i = 0; i < shuffled.length; i += 2) {
            if (i + 1 >= shuffled.length) {
                // ✅ NEW: Handle bye (unpaired player)
                byes.push(shuffled[i]);
                console.log('[START_ROUND] Bye assigned to player:', shuffled[i].id);
                break;
            }
            pairings.push({ white: shuffled[i], black: shuffled[i + 1] });
        }

        if (pairings.length === 0) {
            console.warn('[START_ROUND] Not enough players for pairings', { playerCount: shuffled.length });
            return res.status(400).json({ error: "Not enough players to create pairings" });
        }

        console.log('[START_ROUND] Created pairings', {
            tournamentId,
            round,
            pairingCount: pairings.length,
            byeCount: byes.length  // ✅ Log bye count
        });

        const now = new Date();

        // 6) Insert round
        await cassandra.execute(
            `INSERT INTO rounds_by_tournament (tournament_id, round, started_at) VALUES (?, ?, ?)`,
            [tournamentId, round, now],
            { prepare: true }
        );

        console.log('[START_ROUND] Inserted round to Cassandra', { tournamentId, round, startedAt: now });

        // 7) Insert matches (WITHOUT playlinks first)
        const queries = [];
        const responsePairings = [];

        for (let index = 0; index < pairings.length; index++) {
            const pair = pairings[index];
            const boardNumber = index + 1;
            const gameId = randomUUID();

            console.log('[START_ROUND] Creating match', {
                tournamentId,
                round,
                boardNumber,
                gameId,
                white: String(pair.white.id),
                black: String(pair.black.id),
            });

            queries.push({
                query: `INSERT INTO matches (tournament_id, round, board_number, game_id, white_player, black_player, result, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                params: [tournamentId, round, boardNumber, gameId, pair.white.id, pair.black.id, null, now, null],
            });

            queries.push({
                query: `INSERT INTO matches_by_game (game_id, tournament_id, round, board_number, white_player, black_player, result, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                params: [gameId, tournamentId, round, boardNumber, pair.white.id, pair.black.id, null, now, null],
            });

            responsePairings.push({
                board: boardNumber,
                gameId,
                white: String(pair.white.id),
                black: String(pair.black.id),
                urls: {
                    white: null,
                    black: null,
                },
            });
        }

        // ✅ NEW: Add byes to response
        for (const byePlayer of byes) {
            responsePairings.push({
                board: pairings.length + byes.indexOf(byePlayer) + 1,
                gameId: null,
                white: String(byePlayer.id),
                black: "BYE",
                urls: { white: null, black: null },
            });

            console.log('[START_ROUND] Bye player gets automatic point:', String(byePlayer.id));

            // ✅ Give bye player 1 point automatically (only for swiss/round_robin)
            if (format !== "single_elim") {
                try {
                    const existingPoints = await cassandra.execute(
                        "SELECT points FROM leaderboard_by_player WHERE tournament_id = ? AND player_id = ?",
                        [tournamentId, byePlayer.id],
                        { prepare: true }
                    );
                    const currentPoints = existingPoints.rowLength ? existingPoints.rows[0].points : 0.0;

                    await cassandra.execute(
                        "INSERT INTO leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)",
                        [tournamentId, byePlayer.id, currentPoints + 1.0],
                        { prepare: true }
                    );

                    console.log('[START_ROUND] Updated bye player points:', {
                        playerId: String(byePlayer.id),
                        newPoints: currentPoints + 1.0
                    });
                } catch (e) {
                    console.warn('[START_ROUND] Failed to award bye point:', e.message);
                }
            }
        }

        await cassandra.batch(queries, { prepare: true });

        console.log('[START_ROUND] Inserted all matches to Cassandra', {
            tournamentId,
            round,
            matchCount: pairings.length,
        });

        // ✅ WAIT za eventual consistency
        console.log('[START_ROUND] Waiting for Cassandra consistency...');
        await new Promise(r => setTimeout(r, 500));

        // 8) Mark tournament running
        await cassandra.execute(
            "UPDATE tournaments SET status = ? WHERE tournament_id = ?",
            ["running", tournamentId],
            { prepare: true }
        );

        console.log('[START_ROUND] Updated tournament status to running', { tournamentId });

        // ✅ AUTOMATIC ROUND COMPLETION HOOK
        setTimeout(() => {
            maybeAutoCompleteRound(tournamentId, round)
                .then(() => console.log(`[AUTO_COMPLETE] Checked round ${round} for tournament ${tournamentId}`))
                .catch(e => console.warn(`[AUTO_COMPLETE] Error:`, e));
        }, 2000); // 2 sekunde nakon starta runde

        const response = {
            tournamentId,
            round,
            createdAt: now,
            pairings: responsePairings,  // ✅ Now includes byes
        };

        console.log('[START_ROUND] SUCCESS', {
            tournamentId,
            round,
            pairingCount: pairings.length,
            byeCount: byes.length
        });

        return res.status(201).json(response);
    } catch (err) {
        console.error('[START_ROUND] ERROR', {
            error: err.message,
            stack: err.stack,
            tournamentId: req.params.id,
            timestamp: new Date().toISOString(),
        });
        res.status(500).json({ error: "Internal server error" });
    }
}

async function maybeAutoCompleteRound(tournamentId, round) {
    const matchesResult = await cassandra.execute(
        'SELECT game_id, result FROM matches WHERE tournament_id = ? AND round = ?',
        [tournamentId, round],
        { prepare: true }
    );

    if (!matchesResult.rowLength) return;

    const unfinished = matchesResult.rows.filter(r => !r.result);
    if (unfinished.length > 0) return;

    const now = new Date();
    await cassandra.execute(
        `
        UPDATE rounds_by_tournament
        SET finished_at = ?
        WHERE tournament_id = ? AND round = ?
        `,
        [now, tournamentId, round],
        { prepare: true }
    );

    console.log(`[INFO] Round ${round} for tournament ${tournamentId} auto-completed at ${now}`);

    // Dodaj automatsko završavanje turnira za single_elim
    const tRes = await cassandra.execute(
        'SELECT type FROM tournaments WHERE tournament_id = ?',
        [tournamentId],
        { prepare: true }
    );
    const type = tRes.rowLength ? tRes.rows[0].type : null;

    if (type === 'single_elim') {
        // Pozovi completeRound automatski
        await completeRound({ params: { id: tournamentId, round: String(round) } }, {
            status: () => ({ json: () => { } }),
            json: () => { }
        });
    }

    if (type === 'round_robin') {
        const playerCount = await getTournamentPlayerCount(tournamentId);
        const maxRounds = roundRobinTotalRounds(playerCount);
        if (round >= maxRounds && maxRounds > 0) {
            await cassandra.execute(
                "UPDATE tournaments SET status = ? WHERE tournament_id = ?",
                ["finished", tournamentId],
                { prepare: true }
            );
            console.log('[ROUND_ROBIN] Tournament finished', { tournamentId, round, maxRounds });
        }
    }
}

async function getStandings(req, res) {
    const { id: tournamentId } = req.params;

    try {
        const lbRes = await cassandra.execute(
            'SELECT player_id, points FROM leaderboard_by_player WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        const standings = [];

        for (const row of lbRes.rows) {
            const playerId = row.player_id;
            const points = row.points;

            // fetch player details
            const pRes = await cassandra.execute(
                'SELECT first_name, rating FROM players WHERE player_id = ?',
                [playerId],
                { prepare: true }
            );

            let name = null;
            let rating = null;

            if (pRes.rowLength) {
                name = pRes.rows[0].first_name;
                rating = pRes.rows[0].rating;
            }

            standings.push({
                playerId,
                name,      // <-- UI expects "name"
                rating,    // <-- UI shows rating if present
                points
            });
        }

        // sort by descending points
        standings.sort((a, b) => b.points - a.points);

        // give each a rank
        standings.forEach((s, i) => {
            s.rank = i + 1;
        });

        res.json({
            tournamentId,
            standings
        });

    } catch (err) {
        console.error('[ERROR] getStandings:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}


async function completeRound(req, res) {
    const tournamentId = req.params.id;
    const round = parseInt(req.params.round, 10);

    if (!round || isNaN(round)) {
        return res.status(400).json({ error: 'Invalid round' });
    }

    try {
        // 1) Load matches for this round
        const mRes = await cassandra.execute(
            `
            SELECT board_number, white_player, black_player, result
            FROM matches
            WHERE tournament_id = ? AND round = ?
            `,
            [tournamentId, round],
            { prepare: true }
        );

        if (!mRes.rowLength) {
            return res.status(404).json({ error: 'No matches for this round' });
        }

        // Check all matches completed & collect winners
        const winners = [];
        for (const row of mRes.rows) {
            const resStr = row.result;

            if (!resStr) {
                return res.status(400).json({
                    roundCompleted: false,
                    reason: `Board ${row.board_number} has no result yet`
                });
            }

            if (resStr === '1-0') {
                winners.push(row.white_player);
            } else if (resStr === '0-1') {
                winners.push(row.black_player);
            } else if (resStr === '1/2-1/2') {
                // Draw in KO -> requires admin resolve-draw
                return res.status(400).json({
                    roundCompleted: false,
                    reason: `Board ${row.board_number} is a draw (1/2-1/2); resolve it first.`
                });
            } else {
                return res.status(400).json({
                    roundCompleted: false,
                    reason: `Unknown result "${resStr}" on board ${row.board_number}`
                });
            }
        }

        // 2) Mark round as finished
        const now = new Date();
        await cassandra.execute(
            `
            UPDATE rounds_by_tournament
            SET finished_at = ?
            WHERE tournament_id = ? AND round = ?
            `,
            [now, tournamentId, round],
            { prepare: true }
        );

        // 3) Check tournament type
        const tRes = await cassandra.execute(
            'SELECT type, status FROM tournaments WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        if (!tRes.rowLength) {
            return res.status(404).json({ error: 'Tournament not found' });
        }

        const tRow = tRes.rows[0];
        const type = tRow.type;
        // const status = tRow.status; // if you need it

        let championId = null;

        if (type === 'single_elim') {
            // For single_elim we say: if this round produced exactly ONE winner,
            // that is the champion -> finish tournament.
            const uniqueWinners = [...new Set(winners.map(w => w.toString()))];

            if (uniqueWinners.length === 1) {
                // one person left
                championId = winners[0];

                await cassandra.execute(
                    `
                    UPDATE tournaments
                    SET status = ?, winner_id = ?
                    WHERE tournament_id = ?
                    `,
                    ['finished', championId, tournamentId],
                    { prepare: true }
                );
            }
        }

        return res.json({
            roundCompleted: true,
            round,
            championDecided: !!championId,
            championId: championId || null
        });
    } catch (err) {
        console.error('[ERROR] completeRound:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}


async function listTournaments(req, res) {
    try {
        console.log('[LIST_TOURNAMENTS] Loading all tournaments', {
            timestamp: new Date().toISOString(),
        });

        const result = await cassandra.execute(
            `SELECT tournament_id, name, location, start_date, end_date, status, type, time_control, created_at FROM tournaments`,
            [],
            { prepare: true }
        );

        const tournaments = result.rows.map(row => ({
            id: row.tournament_id,
            tournamentId: row.tournament_id,
            name: row.name,
            location: row.location,
            startDate: row.start_date,
            endDate: row.end_date,
            status: row.status,
            type: row.type,
            timeControl: row.time_control,
            createdAt: row.created_at,
        }));

        console.log('[LIST_TOURNAMENTS] SUCCESS', { tournamentCount: tournaments.length });

        res.json({ tournaments });
    } catch (err) {
        console.error('[LIST_TOURNAMENTS] ERROR', {
            error: err.message,
            stack: err.stack,
        });
        res.status(500).json({ error: 'Internal server error' });
    }
}

// controllers/tournamentController.js

async function listRounds(req, res) {
    try {
        const tournamentId = req.params.id;

        const result = await cassandra.execute(
            `
            SELECT round, started_at, finished_at
            FROM rounds_by_tournament
            WHERE tournament_id = ?
            `,
            [tournamentId],
            { prepare: true }
        );

        const rounds = result.rows
            .map(r => ({
                round: r.round,
                startedAt: r.started_at,
                finishedAt: r.finished_at,
            }))
            .sort((a, b) => a.round - b.round);

        return res.json({
            tournamentId,
            rounds,
        });
    } catch (err) {
        console.error('[ERROR] listRounds:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function getTournamentInfo(req, res) {
    try {
        const tournamentId = req.params.id;

        const result = await cassandra.execute(
            `
            SELECT tournament_id, name, location,
                   start_date, end_date, status,
                   type, time_control, created_at,
                   winner_id
            FROM tournaments
            WHERE tournament_id = ?
            `,
            [tournamentId],
            { prepare: true }
        );

        if (!result.rowLength) {
            return res.status(404).json({ error: 'Tournament not found' });
        }

        const row = result.rows[0];

        const winnerId = row.winner_id || null;
        let winnerName = null;

        if (winnerId) {
            const pRes = await cassandra.execute(
                'SELECT first_name, rating FROM players WHERE player_id = ?',
                [winnerId],
                { prepare: true }
            );
            if (pRes.rowLength) {
                winnerName = pRes.rows[0].first_name;
            }
        }

        // ✅ Only ONE response
        return res.json({
            tournamentId: row.tournament_id,
            name: row.name,
            location: row.location,
            startDate: row.start_date,
            endDate: row.end_date,
            status: row.status,
            type: row.type,
            timeControl: row.time_control,
            createdAt: row.created_at,
            winnerId,
            winnerName,
        });
    } catch (err) {
        console.error('[ERROR] getTournamentInfo:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

async function loadPlayerMap(playerIds) {
    if (!playerIds || playerIds.length === 0) return {};

    const map = {};
    // simple version: 1 query per player (fine for your current scale)
    for (const pid of playerIds) {
        const res = await cassandra.execute(
            'SELECT player_id, first_name, rating FROM players WHERE player_id = ?',
            [pid],
            { prepare: true }
        );
        if (res.rowLength) {
            const row = res.rows[0];
            map[pid.toString()] = {
                name: row.first_name,
                rating: row.rating
            };
        }
    }
    return map;
}


async function getRoundMatches(req, res) {
    try {
        const tournamentId = req.params.id;
        const round = parseInt(req.params.round, 10);

        const result = await cassandra.execute(
            `
            SELECT board_number, game_id, white_player, black_player, result
            FROM matches
            WHERE tournament_id = ? AND round = ?
            `,
            [tournamentId, round],
            { prepare: true }
        );

        const matchesRaw = result.rows.map(r => ({
            boardNumber: r.board_number,
            gameId: r.game_id.toString(),
            whitePlayer: r.white_player.toString(),
            blackPlayer: r.black_player.toString(),
            result: r.result || ""
        }));

        // ⬇️ NEW: enrich with names
        const allIds = new Set();
        for (const m of matchesRaw) {
            allIds.add(m.whitePlayer);
            allIds.add(m.blackPlayer);
        }
        const playerMap = await loadPlayerMap(Array.from(allIds));

        const matches = matchesRaw.map(m => ({
            ...m,
            whiteName: playerMap[m.whitePlayer]?.name || null,
            whiteRating: playerMap[m.whitePlayer]?.rating ?? null,
            blackName: playerMap[m.blackPlayer]?.name || null,
            blackRating: playerMap[m.blackPlayer]?.rating ?? null
        }));

        res.json({
            tournamentId,
            round,
            matches
        });
    } catch (err) {
        console.error('[ERROR] getRoundMatches:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function getSanMovesFromStream(redis, gameId) {
    const streamKey = `game:${gameId}`;
    const entries = await redis.xRange(streamKey, '-', '+', { COUNT: 5000 });

    const san = [];
    for (const [id, fields] of entries) {
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

        if (obj.type === 'move' && obj.move) {
            try {
                const mv = JSON.parse(obj.move);
                if (mv?.san) san.push(mv.san);
            } catch { }
        }
    }
    return san;
}



// ✅ NEW: Safe round loading sa retry
async function loadRoundsForTournamentSafe(tournamentId, maxWaitMs = 2000) {
    console.log('[LOAD_ROUNDS_SAFE] Starting with retry logic', { tournamentId, maxWaitMs });

    const startTime = Date.now();
    let lastResult = null;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const result = await cassandra.execute(
                "SELECT round, finished_at FROM rounds_by_tournament WHERE tournament_id = ?",
                [tournamentId],
                { prepare: true }
            );

            const rounds = result.rows.map(r => ({
                round: r.round,
                finishedAt: r.finished_at,
            }));

            // ✅ If we got new rounds, return immediately
            if (rounds.length > (lastResult?.length || 0)) {
                console.log('[LOAD_ROUNDS_SAFE] Found new rounds:', { count: rounds.length });
                return rounds;
            }

            lastResult = rounds;

            if (result.rowLength === 0) {
                const elapsedMs = Date.now() - startTime;
                if (elapsedMs < maxWaitMs) {
                    console.log('[LOAD_ROUNDS_SAFE] No rounds yet, retrying...', { elapsedMs });
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
            }

            return rounds;
        } catch (err) {
            console.error('[LOAD_ROUNDS_SAFE] Query error:', err.message);
            throw err;
        }
    }

    console.warn('[LOAD_ROUNDS_SAFE] Timeout after', maxWaitMs, 'ms');
    return lastResult || [];
}

// ✅ NEW: Safe match loading
async function loadMatchesSafe(tournamentId, round, maxWaitMs = 3000) {
    console.log('[LOAD_MATCHES_SAFE] Starting with retry', { tournamentId, round, maxWaitMs });

    const startTime = Date.now();
    let lastCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const result = await cassandra.execute(
                `SELECT board_number, game_id, white_player, black_player, result
                 FROM matches WHERE tournament_id = ? AND round = ?`,
                [tournamentId, round],
                { prepare: true }
            );

            const matches = result.rows.map(r => ({
                boardNumber: r.board_number,
                gameId: r.game_id.toString(),
                whitePlayer: r.white_player.toString(),
                blackPlayer: r.black_player.toString(),
                result: r.result || ""
            }));

            // ✅ If we got new matches, return immediately
            if (matches.length > lastCount && matches.length > 0) {
                console.log('[LOAD_MATCHES_SAFE] Found matches:', { count: matches.length });
                return matches;
            }

            lastCount = matches.length;

            if (matches.length === 0) {
                const elapsedMs = Date.now() - startTime;
                if (elapsedMs < maxWaitMs) {
                    console.log('[LOAD_MATCHES_SAFE] No matches yet, retrying...', { elapsedMs });
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
            }

            return matches;
        } catch (err) {
            console.error('[LOAD_MATCHES_SAFE] Query error:', err.message);
            throw err;
        }
    }

    console.warn('[LOAD_MATCHES_SAFE] Timeout after', maxWaitMs, 'ms');
    return [];
}

module.exports = {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
    getStandings,
    completeRound,
    listTournaments,
    getTournamentInfo,
    listRounds,
    getRoundMatches,
    getSanMovesFromStream,
    loadRoundsForTournamentSafe,
    loadMatchesSafe,
};

function roundRobinTotalRounds(playerCount) {
    // N = broj registrovanih igrača
    if (!playerCount || playerCount < 2) return 0;
    return playerCount % 2 === 0 ? playerCount - 1 : playerCount;
}