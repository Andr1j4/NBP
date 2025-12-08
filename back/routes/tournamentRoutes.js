const express = require('express');
const router = express.Router();

const {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
} = require('../controllers/tournamentController');

// POST /api/tournaments
router.post('/', createTournament);

// POST /api/tournaments/:id/register
router.post('/:id/register', registerPlayer);

// GET /api/tournaments/:id/players
router.get('/:id/players', listTournamentPlayers);

// Start a round 
router.post('/:id/start', startRound);

module.exports = router;
