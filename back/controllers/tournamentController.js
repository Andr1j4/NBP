const cassandra = require('../db/cassandra');
const { randomUUID } = require('crypto');

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

        if (!name) {
            return res.status(400).json({ error: 'name is required\n full table\n tournament_id,name,location,start_date,end_date,status,type,time_control' });
        }

        const tournamentId = randomUUID();
        const now = new Date();

        // Example CQL
        await cassandra.execute(
            'INSERT INTO tournaments (tournament_id, name, location, start_date, end_date, status, type, time_control, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                tournamentId,
                name,
                location || null,
                startDate || null,
                endDate || null,
                'registration',
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

        // 1) Load tournament (optional but nice for validation)
        const tResult = await cassandra.execute(
            'SELECT tournament_id, status FROM tournaments WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );
        if (!tResult.rowLength) {
            return res.status(404).json({ error: 'Tournament not found' });
        }

        // 2) Load players registered for this tournament
        const playersResult = await cassandra.execute(
            'SELECT player_id, rating FROM tournament_players WHERE tournament_id = ?',
            [tournamentId],
            { prepare: true }
        );

        const players = playersResult.rows.map(r => ({
            id: r.player_id,
            rating: r.rating
        }));

        if (players.length < 2) {
            return res.status(400).json({ error: 'Not enough players to start a round (need at least 2)' });
        }

        // 3) Decide round number:
        //    - If client provided one, use it.
        //    - Otherwise compute next round = max(existing_round) + 1, or 1 if none.
        let round = requestedRound;
        if (!round) {
            const matchesResult = await cassandra.execute(
                'SELECT round FROM matches WHERE tournament_id = ?',
                [tournamentId],
                { prepare: true }
            );
            if (matchesResult.rowLength === 0) {
                round = 1;
            } else {
                const existingRounds = matchesResult.rows.map(r => r.round);
                const maxRound = Math.max(...existingRounds);
                round = maxRound + 1;
            }
        }

        // 4) Random shuffle players (NO rating-based pairing)
        const shuffled = [...players];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // 5) Create pairings: [0]vs[1], [2]vs[3], ...
        const pairings = [];
        const byes = [];

        for (let i = 0; i < shuffled.length; i += 2) {
            if (i + 1 >= shuffled.length) {
                // Odd number of players -> bye
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

        // 6) Insert matches into Cassandra
        const now = new Date();
        const queries = [];
        const responsePairings = [];

        pairings.forEach((pair, index) => {
            const boardNumber = index + 1;
            const gameId = randomUUID();

            // matches
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

            // OPTIONAL: if you created matches_by_game table, insert there too:
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

            // You can adjust this URL path to match your React route
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

        // 7) Optionally: mark tournament as "running"
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
            byes: byes.map(p => p.id)  // players who got a bye (if any)
        });

    } catch (err) {
        console.error('[ERROR] startRound:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}



module.exports = {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
};