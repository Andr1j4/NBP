// back/routes/gameRoutes.js
const express = require("express");
const router = express.Router();

const {
    getGameMovesFromRedis,
    getGameArchiveFromCassandra,
} = require("../controllers/gameController");

router.get("/:gameId/moves", getGameMovesFromRedis);
router.get("/:gameId/archive", getGameArchiveFromCassandra);



module.exports = router;
