const cassandra = require('../db/cassandra');
const { randomUUID } = require('crypto');
const { types } = require('cassandra-driver');


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
async function startRound(req, res) {
    try {
        const tournamentId = req.params.id;
        const requestedRound = req.body?.round; // optional

        // 1) Load tournament (type is important: single_elim vs swiss later)
        const tResult = await cassandra.execute(
            'SELECT tournament_id, status, type FROM tournaments WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        if (!tResult.rowLength) {
            return res.status(404).json({ error: 'Tournament not found' });
        }

        const tournament = tResult.rows[0];
        const format = tournament.type || 'single_elim';

        // 2) Read existing rounds (source of truth)
        const roundsResult = await cassandra.execute(
            'SELECT round, finished_at FROM rounds_by_tournament WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        const existingRounds = roundsResult.rows.map(r => ({
            round: r.round,
            finished: !!r.finished_at
        }));

        // 3) Decide which round to start
        let round = requestedRound;

        if (round) {
            // disallow starting same round twice
            const exists = existingRounds.find(r => r.round === round);
            if (exists) {
                return res.status(400).json({
                    error: 'This round already exists',
                    round
                });
            }

            // enforce previous round finished
            const prevRound = round - 1;
            if (prevRound > 0) {
                const prev = existingRounds.find(r => r.round === prevRound);
                if (!prev || !prev.finished) {
                    return res.status(400).json({
                        error: 'Previous round is not finished yet',
                        lastRound: prevRound
                    });
                }
            }
        } else {
            // no round provided -> auto next round
            if (existingRounds.length === 0) {
                round = 1;
            } else {
                const maxRound = Math.max(...existingRounds.map(r => r.round));
                const lastRound = existingRounds.find(r => r.round === maxRound);
                if (!lastRound.finished) {
                    return res.status(400).json({
                        error: 'Previous round is not finished yet',
                        lastRound: maxRound
                    });
                }
                round = maxRound + 1;
            }
        }

        // 4) Decide which players play this round
        let players = [];

        if (format === 'single_elim') {
            if (round === 1) {
                // first round: all registered players
                const playersResult = await cassandra.execute(
                    'SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?',
                    [tournamentId],
                    { prepare: true }
                );

                players = playersResult.rows.map(r => ({
                    id: r.player_id,
                    rating: r.rating
                }));
            } else {
                // later KO rounds: only winners from previous round
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
                        error: `No matches found for previous round ${prevRound}`
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

                    if (result === '1-0') {
                        winners.push(white_player);
                    } else if (result === '0-1') {
                        winners.push(black_player);
                    } else if (result === '1/2-1/2') {
                        // single_elim cannot advance from a pure draw
                        hasDraws = true;
                        console.warn(
                            `[WARN] KO round ${prevRound} game is a draw (1/2-1/2) – needs tie-break/manual decision`
                        );
                    } else {
                        console.warn(
                            `[WARN] Unknown result "${result}" in round ${prevRound} – ignoring for winner selection`
                        );
                    }
                }

                if (hasUnfinished || hasDraws) {
                    return res.status(400).json({
                        error: 'Cannot start next KO round: some games are unfinished or ended in a draw that needs tie-break.',
                        previousRound: prevRound,
                        details: {
                            hasUnfinished,
                            hasDraws
                        }
                    });
                }

                if (winners.length < 2) {
                    return res.status(400).json({
                        error: 'Not enough winners to create next round',
                        winnersCount: winners.length
                    });
                }

                // load ratings for winners from players table
                players = [];
                for (const pid of winners) {
                    const pRes = await cassandra.execute(
                        'SELECT player_id, rating FROM players WHERE player_id = ?',
                        [pid],
                        { prepare: true }
                    );
                    if (pRes.rowLength) {
                        players.push({
                            id: pRes.rows[0].player_id,
                            rating: pRes.rows[0].rating
                        });
                    }
                }
            }
        } else {
            // non-KO format (e.g. swiss): everybody plays each round
            const playersResult = await cassandra.execute(
                'SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?',
                [tournamentId],
                { prepare: true }
            );

            players = playersResult.rows.map(r => ({
                id: r.player_id,
                rating: r.rating
            }));
        }

        if (players.length < 2) {
            return res.status(400).json({
                error: 'Not enough players to start a round (need at least 2)',
                playersCount: players.length
            });
        }

        // 5) Shuffle & build pairings (same as before)
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
            const white = shuffled[i];
            const black = shuffled[i + 1];
            pairings.push({ white, black });
        }

        if (pairings.length === 0) {
            return res.status(400).json({ error: 'Not enough players to create any pairing' });
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

        // 7) Insert matches + matches_by_game
        const queries = [];
        const responsePairings = [];

        pairings.forEach((pair, index) => {
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
                    null
                ]
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
                    null
                ]
            });

            responsePairings.push({
                board: boardNumber,
                gameId,
                white: pair.white.id,
                black: pair.black.id,
                urls: {
                    white: `/play?game_id=${gameId}&color=w`,
                    black: `/play?game_id=${gameId}&color=b`
                }
            });
        });

        await cassandra.batch(queries, { prepare: true });

        // 8) Mark tournament as running (optional)
        await cassandra.execute(
            'UPDATE tournaments SET status = ? WHERE tournament_id = ?',
            ['running', tournamentId],
            { prepare: true }
        );

        return res.status(201).json({
            tournamentId,
            round,
            createdAt: now,
            pairings: responsePairings,
            byes: byes.map(p => p.id)
        });

    } catch (err) {
        console.error('[ERROR] startRound:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    // ...other exports
    startRound
};


async function getStandings(req, res) {
    // sort in memory by points DESC
    console.log('[HTTP] GET /api/tournaments/:id/standings', req.params.id);

    try {
        const { id } = req.params;

        // 1) parse tournament id as UUID
        const tournamentId = types.Uuid.fromString(id);

        // 2) query leaderboard_by_player
        const result = await cassandra.execute(
            'SELECT player_id, points FROM leaderboard_by_player WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        // 3) sort by points desc
        const rows = result.rows.slice().sort((a, b) => {
            const pa = a.points || 0;
            const pb = b.points || 0;
            return pb - pa;
        });

        // 4) add rank numbers
        const standings = rows.map((row, idx) => ({
            rank: idx + 1,
            playerId: row.player_id.toString(),
            points: row.points || 0
        }));

        return res.json({
            tournamentId: id,
            standings
        });
    } catch (err) {
        console.error('[ERROR] getTournamentStandings failed:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

async function completeRound(req, res) {
    try {
        const tournamentId = req.params.id;
        const roundParam = req.params.round;

        // round comes as string -> convert
        const round = parseInt(roundParam, 10);
        if (Number.isNaN(round)) {
            return res.status(400).json({ error: 'Invalid round number' });
        }

        // 1) Load matches for this round
        const matchesResult = await cassandra.execute(
            `
            SELECT game_id, result
            FROM matches
            WHERE tournament_id = ? AND round = ?
            `,
            [tournamentId, round],
            { prepare: true }
        );

        if (matchesResult.rowLength === 0) {
            return res.status(404).json({
                error: 'No matches found for this round',
                tournamentId,
                round
            });
        }

        // 2) Check if all matches have a result
        const rows = matchesResult.rows;
        const unfinished = rows
            .filter(r => !r.result)       // null / undefined
            .map(r => r.game_id);         // list of unfinished game_ids

        if (unfinished.length > 0) {
            return res.status(400).json({
                roundCompleted: false,
                reason: 'Some games are still unfinished',
                unfinishedGames: unfinished
            });
        }

        // 3) All matches finished -> mark round finished
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

        return res.status(200).json({
            roundCompleted: true,
            tournamentId,
            round,
            finishedAt: now
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

async function listRoundMatches(req, res) {
    try {
        const tournamentId = req.params.id;
        const round = parseInt(req.params.round, 10);

        if (!Number.isInteger(round)) {
            return res.status(400).json({ error: 'round must be an integer' });
        }

        const result = await cassandra.execute(
            `
            SELECT round, board_number, game_id, white_player, black_player, result
            FROM matches
            WHERE tournament_id = ? AND round = ?
            `,
            [tournamentId, round],
            { prepare: true }
        );

        // sort by board_number
        const rows = result.rows.sort((a, b) => a.board_number - b.board_number);

        const matches = rows.map(r => ({
            round: r.round,
            boardNumber: r.board_number,
            gameId: r.game_id,
            whitePlayer: r.white_player,
            blackPlayer: r.black_player,
            result: r.result || null
        }));

        return res.json({
            tournamentId,
            round,
            matches
        });
    } catch (err) {
        console.error('[ERROR] listRoundMatches:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}



module.exports = {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
    getStandings,
    completeRound,
    resolveDraw,
    listRoundMatches
};