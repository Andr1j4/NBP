const cassandra = require('../db/cassandra');
const { randomUUID } = require('crypto');
const { types } = require('cassandra-driver');


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
            type = 'single_elim',   // ⬅️ tournament format
            timeControl = '5+0',    // ⬅️ e.g. "5+0", "3+2", "15+10"
        } = req.body || {};

        if (!name) {
            return res.status(400).json({
                error: 'name is required\n full table\n tournament_id,name,location,start_date,end_date,status,type,time_control'
            });
        }

        const tournamentId = randomUUID();
        const now = new Date();

        await cassandra.execute(
            `
            INSERT INTO tournaments (
                tournament_id,
                name,
                location,
                start_date,
                end_date,
                status,
                type,
                time_control,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                tournamentId,
                name,
                location || null,
                startDate || null,
                endDate || null,
                'registration',   // or 'created', but be consistent
                type,
                timeControl,
                now
            ],
            { prepare: true }
        );

        return res.status(201).json({
            tournamentId,
            name,
            location: location || null,
            startDate: startDate || null,
            endDate: endDate || null,
            status: 'registration',
            type,
            timeControl,
            createdAt: now
        });
    } catch (err) {
        console.error('[ERROR] createTournament:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// POST /api/tournaments/:id/register
async function registerPlayer(req, res) {
    try {
        const tournament_id = req.params.id;
        const { player_id, rating } = req.body || {};

        if (!player_id) {
            return res.status(400).json({ error: 'player_id is required, full table\n player_id,rating' });
        }


        const joined_at = new Date();

        // Optionally fetch rating from players table first

        // Example CQL
        await cassandra.execute(
            'INSERT INTO tournament_players (tournament_id, player_id, joined_at, rating) VALUES (?, ?, ?, ?)',
            [tournament_id, player_id, joined_at, rating],
            { prepare: true }
        );

        return res.status(201).json({
            tournament_id,
            player_id,
            joined_at,
        });
    } catch (err) {
        console.error('[ERROR] registerPlayer:', err);
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

        // 1) Load tournament (type is important: single_elim vs swiss later)
        const tResult = await cassandra.execute(
            "SELECT tournament_id, status, type FROM tournaments WHERE tournament_id = ?",
            [tournamentId],
            { prepare: true }
        );

        if (!tResult.rowLength) {
            return res.status(404).json({ error: "Tournament not found" });
        }

        const tournament = tResult.rows[0];
        const format = tournament.type || "single_elim";

        // 2) Read existing rounds (source of truth)
        const roundsResult = await cassandra.execute(
            "SELECT round, finished_at FROM rounds_by_tournament WHERE tournament_id = ?",
            [tournamentId],
            { prepare: true }
        );

        const existingRounds = roundsResult.rows.map((r) => ({
            round: r.round,
            finished: !!r.finished_at,
        }));

        // 3) Decide which round to start
        let round = requestedRound;

        if (round) {
            const exists = existingRounds.find((r) => r.round === round);
            if (exists) {
                return res.status(400).json({ error: "This round already exists", round });
            }

            const prevRound = round - 1;
            if (prevRound > 0) {
                const prev = existingRounds.find((r) => r.round === prevRound);
                if (!prev || !prev.finished) {
                    return res.status(400).json({
                        error: "Previous round is not finished yet",
                        lastRound: prevRound,
                    });
                }
            }
        } else {
            if (existingRounds.length === 0) {
                round = 1;
            } else {
                const maxRound = Math.max(...existingRounds.map((r) => r.round));
                const lastRound = existingRounds.find((r) => r.round === maxRound);
                if (!lastRound.finished) {
                    return res.status(400).json({
                        error: "Previous round is not finished yet",
                        lastRound: maxRound,
                    });
                }
                round = maxRound + 1;
            }
        }

        // 4) Decide which players play this round
        let players = [];

        if (format === "single_elim") {
            if (round === 1) {
                const playersResult = await cassandra.execute(
                    "SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?",
                    [tournamentId],
                    { prepare: true }
                );

                players = playersResult.rows.map((r) => ({
                    id: r.player_id,
                    rating: r.rating,
                }));
            } else {
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
                        continue;
                    }

                    if (result === "1-0") winners.push(white_player);
                    else if (result === "0-1") winners.push(black_player);
                    else if (result === "1/2-1/2") hasDraws = true;
                }

                if (hasUnfinished || hasDraws) {
                    return res.status(400).json({
                        error:
                            "Cannot start next KO round: some games are unfinished or ended in a draw that needs tie-break.",
                        previousRound: prevRound,
                        details: { hasUnfinished, hasDraws },
                    });
                }

                if (winners.length < 2) {
                    return res.status(400).json({
                        error: "Not enough winners to create next round",
                        winnersCount: winners.length,
                    });
                }

                players = [];
                for (const pid of winners) {
                    const pRes = await cassandra.execute(
                        "SELECT player_id, rating FROM players WHERE player_id = ?",
                        [pid],
                        { prepare: true }
                    );
                    if (pRes.rowLength) {
                        players.push({
                            id: pRes.rows[0].player_id,
                            rating: pRes.rows[0].rating,
                        });
                    }
                }
            }
        } else {
            const playersResult = await cassandra.execute(
                "SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?",
                [tournamentId],
                { prepare: true }
            );

            players = playersResult.rows.map((r) => ({
                id: r.player_id,
                rating: r.rating,
            }));
        }

        if (players.length < 2) {
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
        const byes = [];

        for (let i = 0; i < shuffled.length; i += 2) {
            if (i + 1 >= shuffled.length) {
                byes.push(shuffled[i]);
                break;
            }
            pairings.push({ white: shuffled[i], black: shuffled[i + 1] });
        }

        if (pairings.length === 0) {
            return res.status(400).json({ error: "Not enough players to create any pairing" });
        }

        const now = new Date();

        // 6) Insert round row
        await cassandra.execute(
            `
        INSERT INTO rounds_by_tournament (tournament_id, round, started_at)
        VALUES (?, ?, ?)
      `,
            [tournamentId, round, now],
            { prepare: true }
        );

        // helper: ask server for signed playlink for a given player in a given game
        async function fetchPlayLink(gameId, player_id) {
            const r = await fetch(`http://10.121.107.106:8080/api/games/${gameId}/playlink`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ player_id }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || "playlink_failed");
            return d; // { playUrl, token, color, ... }
        }

        // 7) Insert matches + matches_by_game
        const queries = [];
        const responsePairings = [];

        for (let index = 0; index < pairings.length; index++) {
            const pair = pairings[index];
            const boardNumber = index + 1;
            const gameId = randomUUID();

            queries.push({
                query: `
          INSERT INTO matches (
            tournament_id, round, board_number,
            game_id, white_player, black_player,
            result, start_time, end_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                params: [
                    tournamentId,
                    round,
                    boardNumber,
                    gameId,
                    pair.white.id,
                    pair.black.id,
                    null,
                    now,
                    null,
                ],
            });

            queries.push({
                query: `
          INSERT INTO matches_by_game (
            game_id, tournament_id, round, board_number,
            white_player, black_player, result, start_time, end_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                params: [
                    gameId,
                    tournamentId,
                    round,
                    boardNumber,
                    pair.white.id,
                    pair.black.id,
                    null,
                    now,
                    null,
                ],
            });

            // ✅ NEW: generate signed play links
            let whiteLink = null;
            let blackLink = null;

            try {
                whiteLink = await fetchPlayLink(gameId, String(pair.white.id));
            } catch (e) {
                console.warn("[WARN] playlink(white) failed:", e.message);
            }

            try {
                blackLink = await fetchPlayLink(gameId, String(pair.black.id));
            } catch (e) {
                console.warn("[WARN] playlink(black) failed:", e.message);
            }

            responsePairings.push({
                board: boardNumber,
                gameId,
                white: String(pair.white.id),
                black: String(pair.black.id),
                urls: {
                    // prefer signed token links; fallback to legacy if playlink failed
                    white: whiteLink?.playUrl || `/play?game_id=${gameId}&color=w`,
                    black: blackLink?.playUrl || `/play?game_id=${gameId}&color=b`,
                },
            });
        }

        await cassandra.batch(queries, { prepare: true });

        // 8) Mark tournament running
        await cassandra.execute("UPDATE tournaments SET status = ? WHERE tournament_id = ?", ["running", tournamentId], {
            prepare: true,
        });

        return res.status(201).json({
            tournamentId,
            round,
            createdAt: now,
            pairings: responsePairings,
            byes: byes.map((p) => String(p.id)),
        });
    } catch (err) {
        console.error("[ERROR] startRound:", err);
        res.status(500).json({ error: "Internal server error" });
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
}

async function resolveDraw(req, res) {
    try {
        const tournamentId = req.params.id;
        const round = parseInt(req.params.round, 10);
        const boardNumber = parseInt(req.params.board, 10);
        const { winner } = req.body || {};

        if (!Number.isInteger(round) || !Number.isInteger(boardNumber)) {
            return res.status(400).json({ error: 'round and board must be integers' });
        }

        if (winner !== 'white' && winner !== 'black') {
            return res.status(400).json({
                error: 'winner must be "white" or "black"'
            });
        }

        // 1) Load the match
        const matchRes = await cassandra.execute(
            `
            SELECT game_id, white_player, black_player, result
            FROM matches
            WHERE tournament_id = ? AND round = ? AND board_number = ?
            `,
            [tournamentId, round, boardNumber],
            { prepare: true }
        );

        if (!matchRes.rowLength) {
            return res.status(404).json({
                error: 'Match not found for given tournament / round / board'
            });
        }

        const match = matchRes.rows[0];
        const gameId = match.game_id;
        const whiteId = match.white_player;
        const blackId = match.black_player;
        const oldResult = match.result;

        // 2) Ensure we are actually resolving a draw
        if (oldResult !== '1/2-1/2') {
            return res.status(400).json({
                error: 'Match is not a draw (1/2-1/2), nothing to resolve',
                currentResult: oldResult
            });
        }

        // Old scoring
        const oldWhitePoints = 0.5;
        const oldBlackPoints = 0.5;

        // 3) Decide new result & new points
        let newResult;
        let newWhitePoints;
        let newBlackPoints;

        if (winner === 'white') {
            newResult = '1-0';
            newWhitePoints = 1.0;
            newBlackPoints = 0.0;
        } else {
            newResult = '0-1';
            newWhitePoints = 0.0;
            newBlackPoints = 1.0;
        }

        // Deltas for leaderboard
        const deltaWhite = newWhitePoints - oldWhitePoints; // +0.5 or -0.5
        const deltaBlack = newBlackPoints - oldBlackPoints; // -0.5 or +0.5

        // 4) Update leaderboard_by_player (if you’re using it for KO too)
        // White
        const whiteLB = await cassandra.execute(
            'SELECT points FROM leaderboard_by_player WHERE tournament_id = ? AND player_id = ?',
            [tournamentId, whiteId],
            { prepare: true }
        );
        const whiteCurrent = whiteLB.rowLength ? whiteLB.rows[0].points : 0.0;
        const whiteNew = whiteCurrent + deltaWhite;

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
        const blackNew = blackCurrent + deltaBlack;

        await cassandra.execute(
            'INSERT INTO leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)',
            [tournamentId, blackId, blackNew],
            { prepare: true }
        );

        console.log(
            `[INFO] resolveDraw: updated leaderboard_by_player: white=${whiteId} -> ${whiteNew}, black=${blackId} -> ${blackNew}`
        );

        // 5) Update matches
        await cassandra.execute(
            `
            UPDATE matches
            SET result = ?
            WHERE tournament_id = ? AND round = ? AND board_number = ?
            `,
            [newResult, tournamentId, round, boardNumber],
            { prepare: true }
        );

        // 6) Update matches_by_game
        await cassandra.execute(
            `
            UPDATE matches_by_game
            SET result = ?
            WHERE game_id = ?
            `,
            [newResult, gameId],
            { prepare: true }
        );

        console.log(
            `[INFO] resolveDraw: match updated to ${newResult} for tournament=${tournamentId} round=${round} board=${boardNumber}`
        );



        return res.status(200).json({
            ok: true,
            tournamentId,
            round,
            boardNumber,
            gameId,
            oldResult,
            newResult,
            leaderboard: {
                white: { playerId: whiteId, points: whiteNew },
                black: { playerId: blackId, points: blackNew }
            }
        });

    } catch (err) {
        console.error('[ERROR] resolveDraw:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function listTournaments(req, res) {
    try {
        const result = await cassandra.execute(
            `
            SELECT tournament_id, name, location, start_date, end_date,
                   status, type, time_control, created_at
            FROM tournaments
            `,
            [],
            { prepare: true }
        );

        const tournaments = result.rows.map(row => ({
            id: row.tournament_id,
            name: row.name,
            location: row.location,
            startDate: row.start_date,
            endDate: row.end_date,
            status: row.status,
            type: row.type,
            timeControl: row.time_control,
            createdAt: row.created_at,
        }));

        res.json({ tournaments });
    } catch (err) {
        console.error('[ERROR] listTournaments:', err);
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



module.exports = {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
    getStandings,
    completeRound,
    resolveDraw,
    listTournaments,
    getTournamentInfo,
    listRounds,
    getRoundMatches,
    getSanMovesFromStream
};