const express = require('express');
const router = express.Router();

const { createPlayer } = require('../controllers/playerController');

// POST /api/players
router.post('/', createPlayer);

module.exports = router;
