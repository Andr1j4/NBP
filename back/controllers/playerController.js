// TODO: import your Cassandra client here
const cassandra = require('../db/cassandra');

const { randomUUID } = require('crypto'); // or use uuid library

// POST /api/players
async function createPlayer(req, res) {
    try {
        const { firstName, lastName, country } = req.body || {};

        if (!firstName || !lastName) {
            return res.status(400).json({ error: 'firstName and lastName are required' });
        }

        const playerId = randomUUID();
        const rating = 1500; // default

        // Example CQL – adjust to your cassandra client:
        await cassandra.execute(
            'INSERT INTO players (player_id, first_name, last_name, rating, country) VALUES (?, ?, ?, ?, ?)',
            [playerId, firstName, lastName, rating, country || null],
            { prepare: true }
        );

        return res.status(201).json({
            playerId,
            firstName,
            lastName,
            rating,
            country: country || null
        });
    } catch (err) {
        console.error('[ERROR] createPlayer:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    createPlayer,
};
