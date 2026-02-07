// server.js (clean + JWT auth + optional playlink)
// ------------------------------------------------
// JWT (login/register) is the "real login".
// Playlink is optional for "seat links" without a login UI.
//
// Env:
//   JWT_SECRET=...
//   PLAYLINK_SECRET=...
//   REDIS_URL=redis://192.168.122.230:6379
//   FRONTEND_BASE=http://192.168.0.2:3000
//
// Redis keyspace notifications must be enabled for expired events:
//   notify-keyspace-events Ex
// ------------------------------------------------

const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const redis = require("./db/redis");
const cassandra = require("./db/cassandra");
const fs = require("fs");
const path = require("path"); // ✅ NOVO

// ✅ Extracted utilities
const { PORT, FRONTEND_BASE, CORS_ORIGINS } = require("./utils/config");
const { signPlayToken, verifyPlayToken } = require("./utils/token");
const { asUuid, normalizeUuid } = require("./utils/uuid");
const { parseWsUrl, getJwtFromWsReq, getPlayFromWsReq } = require("./utils/wsAuth");
const {
  parseTimeControl,
  settleClock,
  getOrInitClock,
  saveClock,
  scheduleTimeoutKey,
} = require("./utils/game");
const { broadcastClock } = require("./utils/broadcast");
const { handleGameOver } = require("./utils/gameOver");
const { handleViewerConnection } = require("./ws/viewerHandler");
const { handleGameConnection } = require("./ws/gameHandler");

// routes
const authRoutes = require("./routes/authRoutes");
const gameRoutes = require("./routes/gameRoutes");
const playerRoutes = require("./routes/playerRoutes");
const tournamentRoutes = require("./routes/tournamentRoutes");

const app = express();

app.use(
  cors({
    origin: CORS_ORIGINS, // ✅ sada dolazi iz config.js (env/local/docker)
    credentials: true,
  })
);

app.use(express.json());

// ✅ REST routes
app.use("/api/auth", authRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/tournaments", tournamentRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.locals.redis = redis;

// ===============================================
//  SERVER + WS
// ===============================================

async function runSchemaInit() {
  // Šema (keyspace + tabele) se sada inicijalizuje u db/cassandra.js (ensureKeyspace + initSchema)
  console.log("[SCHEMA_INIT] Skipping here – handled in db/cassandra.ensureKeyspace()");
}

const server = app.listen(PORT, async () => {
  console.log(`[INFO] Server started on port ${PORT}`);
  await runSchemaInit();
});

const wss = new WebSocketServer({ server });

// ===============================================
//  REDIS EXPIRE HANDLER (TIMEOUT)
// ===============================================

(async () => {
  try {
    const sub = redis.duplicate();
    await sub.connect();

    await sub.subscribe("__keyevent@0__:expired", async (expiredKey) => {
      try {
        if (!expiredKey.startsWith("game:") || !expiredKey.endsWith(":timeout")) return;

        const gameId = expiredKey.split(":")[1];
        const streamKey = `game:${gameId}`;

        const meta = await redis.hGetAll(`${streamKey}:meta`);
        if (meta?.finished === "1") return;

        const clock = await getOrInitClock(redis, cassandra, gameId);
        const settle = settleClock(clock, Date.now());

        await saveClock(redis, gameId, clock);
        broadcastClock(wss, gameId, clock);

        if (!settle.flag) {
          await scheduleTimeoutKey(redis, gameId, clock);
          return;
        }

        const loser = settle.loser;
        const winner = loser === "w" ? "b" : "w";
        const result = loser === "w" ? "0-1" : "1-0";
        const reason = "timeout";
        const finalFen = (await redis.get(`${streamKey}:fen`)) || "";

        await handleGameOver({
          gameId,
          result,
          reason,
          finalFen,
          endTime: new Date(),
          loser,
          winner,
          wss,
          redis,
          cassandra,
        });

        await redis.del(`game:${gameId}:timeout`);
      } catch (e) {
        console.warn("[expired-handler] error:", e);
      }
    });

    console.log("[INFO] Redis keyspace expired subscriber active");
  } catch (e) {
    console.error("[ERROR] Failed to start keyspace subscriber:", e);
  }
})();

// ===============================================
//  WS CONNECTION ROUTING
// ===============================================

wss.on("connection", async (ws, req) => {
  const url = parseWsUrl(req);
  const parts = url.pathname.split("/").filter(Boolean);

  console.log("[WS CONNECT]", { pathname: url.pathname, parts });

  if (parts[0] !== "ws") {
    ws.close();
    return;
  }

  // VIEWER
  if (parts[1] === "viewer") {
    await handleViewerConnection(ws, redis, cassandra);
    return;
  }

  // GAME
  if (parts[1] === "game" && parts[2]) {
    const gameId = parts[2];
    ws.gameId = gameId;
    await handleGameConnection(ws, req, gameId, cassandra, redis, wss);
    return;
  }

  ws.close();
});

// ===============================================
//  PLAYLINK ENDPOINTS
// ===============================================

app.post("/api/games/:gameId/playlink", async (req, res) => {
  const { gameId } = req.params;
  const { player_id } = req.body;

  if (!player_id) return res.status(400).json({ error: "player_id required" });

  try {
    const gid = asUuid(gameId, "gameId");

    const matchRes = await cassandra.execute(
      "SELECT white_player, black_player FROM matches_by_game WHERE game_id = ?",
      [gid],
      { prepare: true }
    );

    if (!matchRes.rowLength) return res.status(404).json({ error: "match not found" });

    const { white_player, black_player } = matchRes.rows[0];

    let color = null;
    if (normalizeUuid(player_id) === normalizeUuid(white_player)) color = "w";
    if (normalizeUuid(player_id) === normalizeUuid(black_player)) color = "b";
    if (!color) return res.status(403).json({ error: "player not in this game" });

    const token = signPlayToken({
      gameId,
      player_id,
      color,
      exp: Date.now() + 1000 * 60 * 60 * 6,
    });

    const playUrl = `${FRONTEND_BASE}/play?token=${encodeURIComponent(token)}`;
    res.json({ gameId, player_id, color, playUrl, token });
  } catch (e) {
    console.error("[playlink]", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/playlink/resolve", (req, res) => {
  const token = req.query.token;
  const payload = verifyPlayToken(token);
  if (!payload) return res.status(400).json({ error: "invalid_token" });
  return res.json({ gameId: payload.gameId, player_id: payload.player_id, color: payload.color });
});
