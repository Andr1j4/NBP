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
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const { createClient } = require("redis");
const cassandra = require("./db/cassandra");
const driver = require("cassandra-driver");
const { types } = driver;

// routes
const authRoutes = require("./routes/authRoutes");
const gameRoutes = require("./routes/gameRoutes");
const playerRoutes = require("./routes/playerRoutes");
const tournamentRoutes = require("./routes/tournamentRoutes");

const app = express();
const PORT = 8080;

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const PLAYLINK_SECRET = process.env.PLAYLINK_SECRET || "dev_playlink_secret_change_me";
const REDIS_URL = process.env.REDIS_URL || "redis://192.168.122.230:6379";
const FRONTEND_BASE = process.env.FRONTEND_BASE || "http://localhost:3000";

// ------------------- middleware -------------------

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://192.168.0.1:3000",
      "http://192.168.0.2:3000",
      "http://10.121.107.106:3000",
    ],
    credentials: true,
  })
);

app.use(express.json());

// REST routes
app.use("/api/auth", authRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/tournaments", tournamentRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ------------------- redis -------------------

const redis = createClient({ url: REDIS_URL });

(async () => {
  try {
    await redis.connect();
    console.log("[INFO] Redis connected:", REDIS_URL);
  } catch (e) {
    console.error("[ERROR] Redis connect failed:", e);
  }
})();

app.locals.redis = redis;

// ------------------- server + ws -------------------

const server = app.listen(PORT, () => {
  console.log(`[INFO] Server started on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

// ===================================================
//                TOKEN HELPERS
// ===================================================

function normalizeUuid(x) {
  if (x == null) return null;
  return String(x).trim().toLowerCase();
}

function parseWsUrl(req) {
  return new URL(req.url, "http://localhost");
}

// JWT token from ws: ?token=...
function getJwtFromWsReq(req) {
  try {
    const url = parseWsUrl(req);
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

function verifyJwtOptional(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Playlink token from ws: ?play=...
function getPlayFromWsReq(req) {
  try {
    const url = parseWsUrl(req);
    return url.searchParams.get("play");
  } catch {
    return null;
  }
}

// HMAC playlink encoding
function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecodeToString(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString();
}

function asUuid(value, label = "uuid") {
  if (value == null) throw new Error(`${label} missing`);
  if (value instanceof types.Uuid) return value;
  if (typeof value === "string") return types.Uuid.fromString(value);
  throw new Error(`${label} invalid type: ${typeof value}`);
}

function signPlayToken(payloadObj) {
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const sig = b64urlEncode(
    crypto.createHmac("sha256", PLAYLINK_SECRET).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

function verifyPlayToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = b64urlEncode(
    crypto.createHmac("sha256", PLAYLINK_SECRET).update(payload).digest()
  );
  if (sig !== expected) return null;

  let obj = null;
  try {
    obj = JSON.parse(b64urlDecodeToString(payload));
  } catch {
    return null;
  }

  if (obj.exp && Date.now() > obj.exp) return null;
  return obj; // { gameId, player_id, color, exp }
}

// ===================================================
//                VIEWER BROADCAST
// ===================================================

function isViewerClient(ws) {
  return ws && ws.kind === "viewer";
}

function clientWatchesGame(ws, gameId) {
  return isViewerClient(ws) && ws.viewerSubs && ws.viewerSubs.has(gameId);
}

function broadcastToGame(wss, gameId, payloadObj, exceptWs = null) {
  const payload = JSON.stringify(payloadObj);
  let sent = 0;

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (exceptWs && client === exceptWs) return;

    const directMatch = client.gameId === gameId;
    const viewerMatch = client.kind === "viewer" && client.viewerSubs?.has(gameId);

    if (directMatch || viewerMatch) {
      client.send(payload);
      sent++;
    }
  });

  // DEBUG
  if (payloadObj.type === "move" || payloadObj.type === "clock_state" || payloadObj.type === "reset") {
    console.log(`[broadcastToGame] type=${payloadObj.type} gameId=${gameId} sent=${sent}`);
  }
}

function buildPairedMovesFromSan(sanMoves) {
  const rows = [];
  for (let i = 0; i < sanMoves.length; i += 2) {
    rows.push({
      moveNumber: i / 2 + 1,
      white: sanMoves[i] || "",
      black: sanMoves[i + 1] || "",
    });
  }
  return rows;
}

async function getSanMovesFromRedisStream(redisClient, gameId, max = 5000) {
  const streamKey = `game:${gameId}`;
  const entries = (await redisClient.xRange(streamKey, "-", "+", { COUNT: max })) || [];

  const sanMoves = [];

  for (const entry of entries) {
    // ✅ node-redis v4 shape: {id, message}
    if (entry && entry.message) {
      const msg = entry.message;
      if ((msg.type || "").toString() !== "move") continue;

      const moveRaw = (msg.move || "").toString();
      if (!moveRaw) continue;

      try {
        const mv = JSON.parse(moveRaw);
        if (mv?.san) sanMoves.push(mv.san);
      } catch (_) { }
      continue;
    }

    // ✅ old ioredis / older libs shape: [id, fields]
    if (Array.isArray(entry) && entry.length === 2) {
      const fields = entry[1];
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

      if ((obj.type || "").toString() !== "move") continue;

      const moveRaw = (obj.move || "").toString();
      if (!moveRaw) continue;

      try {
        const mv = JSON.parse(moveRaw);
        if (mv?.san) sanMoves.push(mv.san);
      } catch (_) { }
      continue;
    }
  }

  return sanMoves;
}

async function buildViewerSnapshot(redis, cassandra, gameId) {
  const streamKey = `game:${gameId}`;

  const fen = (await redis.get(`${streamKey}:fen`)) || "";
  const meta = await redis.hGetAll(`${streamKey}:meta`);

  // clock is optional for viewer; don’t allow it to kill snapshot
  let clockPayload = {
    whiteMs: null, blackMs: null, active: null, running: false,
    incMs: null, timeControl: null, serverNow: Date.now()
  };

  try {
    const clock = await getOrInitClock(redis, cassandra, gameId);
    settleClock(clock, Date.now());
    await saveClock(redis, gameId, clock);

    clockPayload = {
      whiteMs: clock.w_ms,
      blackMs: clock.b_ms,
      active: clock.active,
      running: !!clock.running,
      incMs: clock.inc_ms,
      timeControl: clock.tc || null,
      serverNow: Date.now(),
    };
  } catch (e) {
    console.warn("[viewer] clock failed for", gameId, e);
  }

  let moves = [];
  try {
    const sanMoves = await getSanMovesFromRedisStream(redis, gameId, 5000);
    moves = buildPairedMovesFromSan(sanMoves);
  } catch (e) {
    console.warn("[viewer] moves failed for", gameId, e);
  }

  return {
    type: "viewer_snapshot",
    gameId,
    fen,
    meta: {
      finished: meta?.finished === "1",
      result: meta?.result || "",
      reason: meta?.reason || "",
      loser: meta?.loser || "",
      winner: meta?.winner || "",
      finalFen: meta?.finalFen || "",
    },
    clock: clockPayload,
    moves,
  };
}


// ===================================================
//                CLOCK
// ===================================================

function parseTimeControl(tc) {
  const s = (tc || "5+0").toString().trim();
  const m = s.match(/^(\d+)\s*\+\s*(\d+)$/);
  const baseMin = m ? parseInt(m[1], 10) : 5;
  const incSec = m ? parseInt(m[2], 10) : 0;
  return { baseMs: baseMin * 60_000, incMs: incSec * 1000, tc: `${baseMin}+${incSec}` };
}

async function getOrInitClock(redisClient, cassandraClient, gameId) {
  const clockKey = `game:${gameId}:clock`;
  const existing = await redisClient.hGetAll(clockKey);

  if (existing && Object.keys(existing).length > 0) {
    return {
      w_ms: parseInt(existing.w_ms || "0", 10),
      b_ms: parseInt(existing.b_ms || "0", 10),
      active: existing.active || "w",
      running: existing.running === "1",
      last_tick: parseInt(existing.last_tick || "0", 10),
      inc_ms: parseInt(existing.inc_ms || "0", 10),
      tc: existing.tc || null,
    };
  }

  let timeControl = "5+0";
  try {
    const mRes = await cassandraClient.execute(
      "SELECT tournament_id FROM matches_by_game WHERE game_id = ?",
      [gameId],
      { prepare: true }
    );
    if (mRes.rowLength) {
      const tid = mRes.rows[0].tournament_id;
      if (tid) {
        const tRes = await cassandraClient.execute(
          "SELECT time_control FROM tournaments WHERE tournament_id = ?",
          [tid],
          { prepare: true }
        );
        if (tRes.rowLength && tRes.rows[0].time_control) {
          timeControl = tRes.rows[0].time_control;
        }
      }
    }
  } catch { }

  const { baseMs, incMs, tc } = parseTimeControl(timeControl);

  const init = {
    w_ms: baseMs,
    b_ms: baseMs,
    active: "w",
    running: false,
    last_tick: 0,
    inc_ms: incMs,
    tc,
  };

  await redisClient.hSet(clockKey, {
    w_ms: String(init.w_ms),
    b_ms: String(init.b_ms),
    active: init.active,
    running: "0",
    last_tick: "0",
    inc_ms: String(init.inc_ms),
    tc: init.tc,
  });

  return init;
}

async function saveClock(redisClient, gameId, clock) {
  const clockKey = `game:${gameId}:clock`;
  await redisClient.hSet(clockKey, {
    w_ms: String(clock.w_ms),
    b_ms: String(clock.b_ms),
    active: clock.active,
    running: clock.running ? "1" : "0",
    last_tick: String(clock.last_tick || 0),
    inc_ms: String(clock.inc_ms || 0),
    tc: clock.tc || "",
  });
}

function settleClock(clock, nowMs) {
  if (!clock.running || !clock.last_tick) return { flag: false };

  const elapsed = Math.max(0, nowMs - clock.last_tick);

  if (clock.active === "w") {
    clock.w_ms -= elapsed;
    if (clock.w_ms <= 0) {
      clock.w_ms = 0;
      return { flag: true, loser: "w" };
    }
  } else {
    clock.b_ms -= elapsed;
    if (clock.b_ms <= 0) {
      clock.b_ms = 0;
      return { flag: true, loser: "b" };
    }
  }

  clock.last_tick = nowMs;
  return { flag: false };
}

async function scheduleTimeoutKey(redisClient, gameId, clock) {
  const key = `game:${gameId}:timeout`;

  if (!clock.running) {
    await redisClient.del(key);
    return;
  }

  const remainingMs = clock.active === "w" ? clock.w_ms : clock.b_ms;
  const ttl = Math.max(1, remainingMs);

  await redisClient.set(key, `active=${clock.active}`, { PX: ttl });
}

function broadcastClock(wssInstance, gameId, clock) {
  broadcastToGame(wssInstance, gameId, {
    type: "clock_state",
    gameId,
    whiteMs: clock.w_ms,
    blackMs: clock.b_ms,
    active: clock.active,
    running: clock.running,
    incMs: clock.inc_ms,
    timeControl: clock.tc || null,
    serverNow: Date.now(),
  });
}

// ===================================================
//                GAME OVER PIPELINE
// ===================================================

async function handleGameOver({
  gameId,
  result,
  reason,
  finalFen,
  endTime = new Date(),
  loser = null,
  winner = null,
  wss,
  redis,
  cassandra,
}) {
  const streamKey = `game:${gameId}`;
  const t0 = Date.now();

  console.log("[handleGameOver] START", {
    gameId,
    result,
    reason,
    endTime: endTime?.toISOString?.() || endTime,
  });

  // 1) mark redis finished
  try {
    await redis.hSet(`${streamKey}:meta`, {
      finished: "1",
      result: result || "",
      reason: reason || "",
      finalFen: finalFen || "",
      loser: loser || "",
      winner: winner || "",
    });
    await redis.del(`${streamKey}:timeout`);
  } catch (e) {
    console.error("[handleGameOver] redis meta write failed", e);
  }

  // 2) broadcast result
  try {
    broadcastToGame(wss, gameId, {
      type: "game_result",
      gameId,
      result,
      reason,
      loser: loser || null,
      winner: winner || null,
      finalFen: finalFen || null,
    });
  } catch (e) {
    console.warn("[handleGameOver] broadcast failed", e);
  }

  if (!result) {
    console.warn("[handleGameOver] missing result -> skipping cassandra writes", { gameId });
    return;
  }

  // 3) match lookup
  let tournamentId, round, boardNumber, whiteId, blackId;
  try {
    const matchRes = await cassandra.execute(
      `
      SELECT tournament_id, round, board_number, white_player, black_player
      FROM turnir.matches_by_game
      WHERE game_id = ?
      `,
      [asUuid(gameId, "gameId")],
      { prepare: true }
    );

    console.log("[handleGameOver] matches_by_game", { gameId, rows: matchRes.rowLength });

    if (!matchRes.rowLength) {
      console.error("[handleGameOver] STOP matches_by_game not found => cannot archive", { gameId });
      return;
    }

    const row = matchRes.rows[0];
    tournamentId = row.tournament_id;
    round = row.round;
    boardNumber = row.board_number;
    whiteId = row.white_player;
    blackId = row.black_player;
  } catch (e) {
    console.error("[handleGameOver] match lookup failed", e);
    return;
  }

  // 4) leaderboard (best-effort)
  try {
    let whiteDelta = 0;
    let blackDelta = 0;

    if (result === "1-0") { whiteDelta = 1.0; blackDelta = 0.0; }
    else if (result === "0-1") { whiteDelta = 0.0; blackDelta = 1.0; }
    else if (result === "1/2-1/2") { whiteDelta = 0.5; blackDelta = 0.5; }

    if (result === "1-0" || result === "0-1" || result === "1/2-1/2") {
      const whiteLB = await cassandra.execute(
        "SELECT points FROM turnir.leaderboard_by_player WHERE tournament_id = ? AND player_id = ?",
        [tournamentId, whiteId],
        { prepare: true }
      );
      const whiteCurrent = whiteLB.rowLength ? whiteLB.rows[0].points : 0.0;

      await cassandra.execute(
        "INSERT INTO turnir.leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)",
        [tournamentId, whiteId, whiteCurrent + whiteDelta],
        { prepare: true }
      );

      const blackLB = await cassandra.execute(
        "SELECT points FROM turnir.leaderboard_by_player WHERE tournament_id = ? AND player_id = ?",
        [tournamentId, blackId],
        { prepare: true }
      );
      const blackCurrent = blackLB.rowLength ? blackLB.rows[0].points : 0.0;

      await cassandra.execute(
        "INSERT INTO turnir.leaderboard_by_player (tournament_id, player_id, points) VALUES (?, ?, ?)",
        [tournamentId, blackId, blackCurrent + blackDelta],
        { prepare: true }
      );

      console.log("[handleGameOver] leaderboard updated", { gameId });
    }
  } catch (e) {
    console.warn("[handleGameOver] leaderboard update failed", e);
  }

  // 5) update matches tables
  try {
    await cassandra.execute(
      `
      UPDATE turnir.matches
      SET result = ?, end_time = ?, final_fen = ?
      WHERE tournament_id = ? AND round = ? AND board_number = ?
      `,
      [result, endTime, finalFen, tournamentId, round, boardNumber],
      { prepare: true }
    );

    await cassandra.execute(
      `
      UPDATE turnir.matches_by_game
      SET result = ?, end_time = ?
      WHERE game_id = ?
      `,
      [result, endTime, asUuid(gameId, "gameId")],
      { prepare: true }
    );

    console.log("[handleGameOver] matches updated", { gameId });
  } catch (e) {
    console.error("[handleGameOver] matches update failed", e);
  }

  // 6) archive insert (THIS is required for replay/finished viewer)
  try {
    // start_time
    let startedAt = null;
    try {
      const startedRes = await cassandra.execute(
        `
        SELECT start_time
        FROM turnir.matches
        WHERE tournament_id = ? AND round = ? AND board_number = ?
        `,
        [tournamentId, round, boardNumber],
        { prepare: true }
      );
      if (startedRes.rowLength) startedAt = startedRes.rows[0].start_time || null;
    } catch (e) {
      console.warn("[handleGameOver] archive start_time read failed", e);
    }

    // time_control (optional)
    let timeControl = null;
    try {
      const tRes = await cassandra.execute(
        "SELECT time_control FROM turnir.tournaments WHERE tournament_id = ?",
        [tournamentId],
        { prepare: true }
      );
      if (tRes.rowLength) timeControl = tRes.rows[0].time_control || null;
    } catch (e) {
      console.warn("[handleGameOver] archive time_control read failed", e);
    }

    let sanMoves = [];
    try {
      sanMoves = await getSanMovesFromRedisStream(redis, gameId, 5000);
    } catch (e) {
      console.warn("[handleGameOver] archive SAN read failed", e);
      sanMoves = [];
    }

    const insertRes = await cassandra.execute(
      `
      INSERT INTO turnir.game_archive_by_id (
        game_id, tournament_id, round, board_number,
        white_player, black_player,
        result, reason,
        start_time, end_time,
        final_fen, time_control,
        san_moves, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      IF NOT EXISTS
      `,
      [
        asUuid(gameId, "gameId"),
        tournamentId,
        round,
        boardNumber,
        whiteId,
        blackId,
        result || "",
        reason || "",
        startedAt,
        endTime,
        finalFen || "",
        timeControl,
        sanMoves,
        new Date(),
      ],
      { prepare: true }
    );

    const applied = insertRes?.rows?.[0]?.["[applied]"];
    console.log("[handleGameOver] archive insert", { gameId, applied, sanMoves: sanMoves.length });


    try {
      const verify = await cassandra.execute(
        "SELECT game_id FROM turnir.game_archive_by_id WHERE game_id = ?",
        [asUuid(gameId, "gameId")],
        { prepare: true }
      );
      console.log("[handleGameOver] archive verify rows=", verify.rowLength, "gameId=", gameId);
    } catch (e) {
      console.error("[handleGameOver] archive verify FAILED", e);
    }


  } catch (e) {
    console.error("[handleGameOver] archive insert FAILED", { gameId, err: e });
  }

  // 7) auto-finish round (best-effort)
  try {
    const rRes = await cassandra.execute(
      `
      SELECT board_number, result
      FROM turnir.matches
      WHERE tournament_id = ? AND round = ?
      `,
      [tournamentId, round],
      { prepare: true }
    );
    const unfinished = rRes.rows.filter((r) => !r.result);
    if (unfinished.length === 0) {
      await cassandra.execute(
        `
        UPDATE turnir.rounds_by_tournament
        SET finished_at = ?
        WHERE tournament_id = ? AND round = ?
        `,
        [new Date(), tournamentId, round],
        { prepare: true }
      );
      console.log("[handleGameOver] round auto-finished", { tournamentId: String(tournamentId), round });
    }
  } catch (e) {
    console.warn("[handleGameOver] auto-finish-round failed", e);
  }

  console.log("[handleGameOver] DONE", { gameId, ms: Date.now() - t0 });
}

// ===================================================
//        REDIS EXPIRE HANDLER (TIMEOUT FINISH)
// ===================================================

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

// ===================================================
//                 WS CONNECTIONS
// ===================================================

wss.on("connection", async (ws, req) => {
  url = parseWsUrl(req);
  const parts = url.pathname.split("/").filter(Boolean);
  pathname = url.pathname;

  console.log("[WS CONNECT]", {
    url: req.url,
    pathname: new URL(req.url, "http://localhost").pathname,
    parts: new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean),
  });


  // expected:
  // /ws/viewer
  // /ws/game/:gameId
  if (parts[0] !== "ws") {
    ws.close();
    return;
  }

  // ---------------- VIEWER ----------------
  if (parts[1] === "viewer") {
    ws.kind = "viewer";
    ws.viewerSubs = new Set();

    console.log("[INFO] Viewer WS connected");

    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.type === "viewer_subscribe") {
          const ids = Array.isArray(data.gameIds) ? data.gameIds.filter(Boolean) : [];
          ws.viewerSubs = new Set(ids);

          const snapshots = [];
          for (const gid of ids) {
            try {
              snapshots.push(await buildViewerSnapshot(redis, cassandra, gid));
            } catch (e) {
              snapshots.push({ type: "viewer_snapshot_error", gameId: gid, error: "snapshot_failed" });
            }
          }

          ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots }));
          return;
        }

        if (data.type === "viewer_add") {
          const gid = data.gameId;
          if (gid) ws.viewerSubs.add(gid);
          const snap = await buildViewerSnapshot(redis, cassandra, gid);
          ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots: [snap] }));
          return;
        }

        if (data.type === "viewer_remove") {
          const gid = data.gameId;
          if (gid) ws.viewerSubs.delete(gid);
          ws.send(JSON.stringify({ type: "viewer_ok", removed: gid }));
          return;
        }

        if (data.type === "viewer_clear") {
          ws.viewerSubs.clear();
          ws.send(JSON.stringify({ type: "viewer_ok", cleared: true }));
          return;
        }

        if (data.type === "viewer_resync_one") {
          const gid = data.gameId;
          if (!gid) return;
          const snap = await buildViewerSnapshot(redis, cassandra, gid);
          ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots: [snap] }));
          return;
        }

        ws.send(JSON.stringify({ type: "error", reason: "unknown_viewer_message" }));
      } catch (e) {
        console.warn("[viewer] bad msg:", e);
        try { ws.send(JSON.stringify({ type: "error", reason: "bad_json" })); } catch { }
      }
    });

    ws.on("close", () => console.log("[INFO] Viewer WS disconnected"));
    return;
  }

  // -------- game ws: ws://host:8080/ws/game/<gameId> --------
  // URL is /ws/game/<gameId>
  // parts: ["ws","game","<gameId>"]
  if (parts[0] !== "ws" || parts[1] !== "game" || !parts[2]) {
    ws.close();
    return;
  }

  const gameId = parts[2];
  ws.gameId = gameId;

  const jwtToken = getJwtFromWsReq(req);
  const jwtUser = verifyJwtOptional(jwtToken); // { user_id, email, role, player_id } OR null

  const playToken = getPlayFromWsReq(req);
  const play = verifyPlayToken(playToken); // { gameId, player_id, color } OR null

  // Decide identity
  let identity = null;
  if (jwtUser?.player_id) {
    identity = { auth: "jwt", ...jwtUser };
  } else if (play && normalizeUuid(play.gameId) === normalizeUuid(gameId) && play.player_id) {
    identity = { auth: "playlink", player_id: play.player_id, color: play.color };
  }

  ws.user = identity;

  // Assign color
  let assignedColor = "spectator";
  let player_id = identity?.player_id || null;

  if (identity?.auth === "playlink") {
    assignedColor = identity.color === "w" ? "w" : identity.color === "b" ? "b" : "spectator";
  } else if (identity?.auth === "jwt") {
    // decide side by DB
    try {
      const matchRes = await cassandra.execute(
        "SELECT white_player, black_player FROM matches_by_game WHERE game_id = ?",
        [gameId],
        { prepare: true }
      );
      if (matchRes.rowLength) {
        const { white_player, black_player } = matchRes.rows[0];

        const me = normalizeUuid(identity.player_id);
        const w = normalizeUuid(white_player);
        const b = normalizeUuid(black_player);

        if (me && w && me === w) assignedColor = "w";
        else if (me && b && me === b) assignedColor = "b";
      }
    } catch (e) {
      console.warn("[WS] side lookup failed:", e);
    }
  }

  ws.color = assignedColor;
  ws.player_id = player_id;

  // welcome
  ws.send(
    JSON.stringify({
      type: "welcome",
      gameId,
      color: ws.color,
      user: identity
        ? {
          auth: identity.auth,
          email: identity.email || null,
          role: identity.role || "user",
          player_id: identity.player_id || null,
        }
        : null,
    })
  );

  const streamKey = `game:${gameId}`;

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      const meta = await redis.hGetAll(`${streamKey}:meta`);
      const isFinished = meta?.finished === "1";

      // spectators are read-only except resync
      if (ws.color === "spectator" && data.type !== "resync") {
        ws.send(JSON.stringify({ type: "error", reason: "spectator_read_only" }));
        return;
      }

      if (isFinished && data.type !== "resync" && data.type !== "game_over") {
        ws.send(
          JSON.stringify({
            type: "game_finished",
            gameId,
            reason: "already_finished",
            result: meta.result || "",
            finalFen: meta.finalFen || null,
          })
        );
        return;
      }

      // ---- MOVE ----
      if (data.type === "move") {
        if (ws.color !== "w" && ws.color !== "b") {
          ws.send(JSON.stringify({ type: "error", reason: "not_a_player" }));
          return;
        }

        // enforce side (when we know player_id)
        if (ws.player_id) {
          try {
            const matchRes = await cassandra.execute(
              "SELECT white_player, black_player FROM matches_by_game WHERE game_id = ?",
              [gameId],
              { prepare: true }
            );
            if (matchRes.rowLength) {
              const { white_player, black_player } = matchRes.rows[0];
              const expected = ws.color === "w" ? white_player : black_player;
              if (normalizeUuid(expected) !== normalizeUuid(ws.player_id)) {
                ws.send(JSON.stringify({ type: "error", reason: "not_authorized_for_side" }));
                return;
              }
            }
          } catch { }
        }

        // clock settle + increment
        const nowMs = Date.now();
        const clock = await getOrInitClock(redis, cassandra, gameId);

        if (!clock.running) {
          clock.running = true;
          clock.active = ws.color;
          clock.last_tick = nowMs;
        }

        const settle = settleClock(clock, nowMs);

        if (settle.flag) {
          const loser = settle.loser;
          const winner = loser === "w" ? "b" : "w";
          const result = loser === "w" ? "0-1" : "1-0";
          const reason = "timeout";
          const finalFen = (await redis.get(`${streamKey}:fen`)) || "";

          await saveClock(redis, gameId, clock);
          broadcastClock(wss, gameId, clock);

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
          return;
        }

        // increment for mover then switch active
        if (ws.color === "w") clock.w_ms += clock.inc_ms || 0;
        else clock.b_ms += clock.inc_ms || 0;

        clock.active = ws.color === "w" ? "b" : "w";
        clock.last_tick = nowMs;

        await saveClock(redis, gameId, clock);
        broadcastClock(wss, gameId, clock);
        await scheduleTimeoutKey(redis, gameId, clock);

        // persist stream
        const fen = data.fen || "";
        const id = await redis.xAdd(streamKey, "*", {
          type: "move",
          move: JSON.stringify(data.move),
          fen,
        });

        if (fen) await redis.set(`${streamKey}:fen`, fen);
        if (fen) {
          await redis.rPush(`${streamKey}:fens`, fen);
          await redis.lTrim(`${streamKey}:fens`, -1000, -1);
        }

        broadcastToGame(
          wss,
          gameId,
          { type: "move", gameId, move: data.move, streamId: id, fen: fen || undefined },
          ws
        );
        return;
      }

      // ---- RESET ----
      if (data.type === "reset") {
        const fen =
          data.fen ||
          "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

        const id = await redis.xAdd(streamKey, "*", { type: "reset", fen });

        await redis.set(`${streamKey}:fen`, fen);
        await redis.rPush(`${streamKey}:fens`, fen);
        await redis.lTrim(`${streamKey}:fens`, -1000, -1);

        // reset clock to start
        const clock = await getOrInitClock(redis, cassandra, gameId);
        const parsed = parseTimeControl(clock.tc || "5+0");
        clock.w_ms = parsed.baseMs;
        clock.b_ms = parsed.baseMs;
        clock.inc_ms = parsed.incMs;
        clock.active = "w";
        clock.running = false;
        clock.last_tick = 0;

        await saveClock(redis, gameId, clock);
        broadcastClock(wss, gameId, clock);
        await scheduleTimeoutKey(redis, gameId, clock);

        broadcastToGame(wss, gameId, { type: "reset", gameId, streamId: id, fen, moves: [] });
        return;
      }

      // ---- RESYNC ----
      if (data.type === "resync") {
        const snapshotFen = await redis.get(`${streamKey}:fen`);
        if (snapshotFen) ws.send(JSON.stringify({ type: "snapshot", fen: snapshotFen }));

        const meta2 = await redis.hGetAll(`${streamKey}:meta`);
        if (meta2?.finished === "1") {
          ws.send(
            JSON.stringify({
              type: "game_result",
              gameId,
              result: meta2.result || "",
              reason: meta2.reason || "finished",
              loser: meta2.loser || null,
              winner: meta2.winner || null,
              finalFen: meta2.finalFen || snapshotFen || null,
            })
          );
        }

        const clock = await getOrInitClock(redis, cassandra, gameId);
        settleClock(clock, Date.now());
        await saveClock(redis, gameId, clock);

        ws.send(
          JSON.stringify({
            type: "clock_state",
            gameId,
            whiteMs: clock.w_ms,
            blackMs: clock.b_ms,
            active: clock.active,
            running: clock.running,
            incMs: clock.inc_ms,
            timeControl: clock.tc || null,
            serverNow: Date.now(),
          })
        );

        await scheduleTimeoutKey(redis, gameId, clock);
        return;
      }

      // ---- GAME OVER ----
      if (data.type === "game_over") {
        const result = data.result || null;
        const reason = data.reason || null;
        const endFen = data.fen || (await redis.get(`${streamKey}:fen`)) || null;

        await handleGameOver({
          gameId,
          result,
          reason,
          finalFen: endFen,
          endTime: new Date(),
          wss,
          redis,
          cassandra,
        });

        await redis.del(`game:${gameId}:timeout`);
        return;
      }
    } catch (e) {
      console.error("[WS] message error:", e?.message || e);
    }
  });

  ws.on("close", () => {
    console.log(`[INFO] WS disconnected gameId=${ws.gameId} color=${ws.color}`);
  });
});

// ===================================================
//              PLAYLINK ENDPOINTS
// ===================================================

// Create a signed play link for a player (seat link)
app.post("/api/games/:gameId/playlink", async (req, res) => {
  const { gameId } = req.params;
  const { player_id } = req.body;

  if (!player_id) return res.status(400).json({ error: "player_id required" });

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
    exp: Date.now() + 1000 * 60 * 60 * 6, // 6h
  });

  const playUrl = `${FRONTEND_BASE}/play?token=${encodeURIComponent(token)}`;
  res.json({ gameId, player_id, color, playUrl, token });
});

app.get("/api/playlink/resolve", (req, res) => {
  const token = req.query.token;
  const payload = verifyPlayToken(token);
  if (!payload) return res.status(400).json({ error: "invalid_token" });
  return res.json({ gameId: payload.gameId, player_id: payload.player_id, color: payload.color });
});

async function loadArchiveByGameId(cassandra, gameId) {
  const aRes = await cassandra.execute(
    `SELECT game_id, tournament_id, round, board_number,
            white_player, black_player, result, reason,
            start_time, end_time, final_fen, time_control, san_moves
     FROM game_archive_by_id
     WHERE game_id = ?`,
    [gameId],
    { prepare: true }
  );
  return aRes.rowLength ? aRes.rows[0] : null;
}

function parseArchiveSanMoves(raw) {
  if (!raw) return [];
  // if list<text>, driver gives array already
  if (Array.isArray(raw)) return raw;

  // if text, you might have JSON or "[e4, f5]" style
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return j;
    } catch (_) { }

    // "[e4, f5, Qh5#]" -> split fallback
    const s = raw.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      return s
        .slice(1, -1)
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}
