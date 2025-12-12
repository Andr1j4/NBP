const express = require('express');
const router = express.Router();

const {
    createTournament,
    registerPlayer,
    listTournamentPlayers,
    startRound,
    getStandings,
    completeRound,
    resolveDraw,
    listRoundMatches,
    listTournaments,
    listRounds,
    getTournamentInfo,
    getRoundMatches
} = require('../controllers/tournamentController');

// POST /api/tournaments
router.post('/', createTournament);

// POST /api/tournaments/:id/register
router.post('/:id/register', registerPlayer);

// GET /api/tournaments/:id/players
router.get('/:id/players', listTournamentPlayers);

router.get('/:id/rounds/:round/matches', getRoundMatches);

// Start a round 
router.post('/:id/start', startRound);

router.get('/:id/standings', getStandings);

router.post(
    '/:id/rounds/:round/complete',
    completeRound
);

router.post(
    '/:id/rounds/:round/boards/:board/resolve-draw',
    resolveDraw
)

router.get('/:id/rounds', listRounds);


router.get('/', listTournaments)

router.get('/:id', getTournamentInfo);


module.exports = router;
