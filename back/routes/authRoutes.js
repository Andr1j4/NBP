// server/routes/authRoutes.js
const express = require("express");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const { authRequired } = require("../middleware/auth");
const { signJwt } = require("../utils/token");
const cassandra = require("../db/cassandra");

const router = express.Router();

function buildUserPayload(user) {
    return {
        user_id: user.user_id,
        email: user.email,
        role: user.role || "user",
        player_id: user.player_id || null,
    };
}

/**
 * POST /api/auth/register
 * body: { email, password, display_name }
 *
 * Creates:
 * - users_by_email
 * - users_by_id
 * - (optionally) users_by_player
 * - also creates a "player" row + links it to the user
 */
// server/routes/authRoutes.js  (REGISTER route)
router.post("/register", async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        const role = "user";

        console.log('[AUTH_REGISTER] Starting registration', {
            email,
            timestamp: new Date().toISOString(),
        });

        if (!email || !password) {
            console.warn('[AUTH_REGISTER] Missing credentials', { email });
            return res.status(400).json({ error: "missing_email_or_password" });
        }

        if (password.length < 6) {
            console.warn('[AUTH_REGISTER] Password too short', { email });
            return res.status(400).json({ error: "password_too_short" });
        }

        // already exists?
        const existing = await cassandra.execute(
            "SELECT email FROM users_by_email WHERE email = ?",
            [email],
            { prepare: true }
        );
        if (existing.rowLength) {
            console.warn('[AUTH_REGISTER] Email already registered', { email });
            return res.status(409).json({ error: "email_already_registered" });
        }

        const userId = uuidv4();
        const createdAt = new Date();

        console.log('[AUTH_REGISTER] User validation passed', { email, userId });

        // if player_id provided: validate it exists
        let finalPlayerId = playerId;
        let displayName = email;

        if (finalPlayerId) {
            const pRes = await cassandra.execute(
                "SELECT player_id, first_name, last_name FROM players WHERE player_id = ?",
                [finalPlayerId],
                { prepare: true }
            );
            if (!pRes.rowLength) return res.status(400).json({ error: "player_id_not_found" });

            const p = pRes.rows[0];
            displayName = `${p.first_name || ""} ${p.last_name || ""}`.trim() || email;
        } else {
            // create a NEW player row (optional path)
            finalPlayerId = uuidv4();
            displayName = `${firstName} ${lastName}`.trim() || email;

            await cassandra.execute(
                "INSERT INTO players (player_id, country, first_name, last_name, rating) VALUES (?, ?, ?, ?, ?)",
                [finalPlayerId, country || "Serbia", firstName || "New", lastName || "User", rating],
                { prepare: true }
            );
        }

        const hash = await bcrypt.hash(password, 10);

        await cassandra.execute(
            "INSERT INTO users_by_email (email, user_id, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?)",
            [email, userId, hash, createdAt, role],
            { prepare: true }
        );

        await cassandra.execute(
            "INSERT INTO users_by_id (user_id, email, created_at, role, player_id, display_name) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, email, createdAt, role, finalPlayerId, displayName],
            { prepare: true }
        );

        await cassandra.execute(
            "INSERT INTO users_by_player (player_id, user_id, email) VALUES (?, ?, ?)",
            [finalPlayerId, userId, email],
            { prepare: true }
        );

        const user = {
            user_id: userId,
            email,
            role,
            player_id: finalPlayerId,
            display_name: displayName,
        };

        const token = signJwt(buildUserPayload(user), "12h");
        console.log('[AUTH_REGISTER] SUCCESS', { email, userId });

        return res.json({ token, user });
    } catch (e) {
        console.error("[auth/register] ERROR", {
            error: e.message,
            email: req.body.email,
            stack: e.stack,
            timestamp: new Date().toISOString(),
        });
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * POST /api/auth/login
 * body: { email, password }
 */
router.post("/login", async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        console.log('[AUTH_LOGIN] Login attempt', {
            email,
            timestamp: new Date().toISOString(),
        });

        if (!email || !password) {
            console.warn('[AUTH_LOGIN] Missing credentials');
            return res.status(400).json({ error: "missing_email_or_password" });
        }

        const u = await cassandra.execute(
            "SELECT user_id, password_hash, role FROM users_by_email WHERE email = ?",
            [email],
            { prepare: true }
        );

        if (!u.rowLength) {
            console.warn('[AUTH_LOGIN] User not found', { email });
            return res.status(401).json({ error: "invalid_credentials" });
        }

        const row = u.rows[0];
        const ok = await bcrypt.compare(password, row.password_hash);

        if (!ok) {
            console.warn('[AUTH_LOGIN] Invalid password', { email });
            return res.status(401).json({ error: "invalid_credentials" });
        }

        // load extra profile
        const prof = await cassandra.execute(
            "SELECT player_id, display_name FROM users_by_id WHERE user_id = ?",
            [row.user_id],
            { prepare: true }
        );

        const playerId = prof.rowLength ? prof.rows[0].player_id : null;
        const displayName = prof.rowLength ? prof.rows[0].display_name : email;

        const user = {
            user_id: row.user_id,
            email,
            role: row.role || "user",
            player_id: playerId,
            display_name: displayName,
        };

        const token = signJwt(buildUserPayload(user), "12h");

        console.log('[AUTH_LOGIN] SUCCESS', { email, userId: user.user_id });

        return res.json({ token, user });
    } catch (e) {
        console.error("[auth/login] ERROR", {
            error: e.message,
            email: req.body.email,
            stack: e.stack,
        });
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * GET /api/auth/me
 */
router.get("/me", authRequired, async (req, res) => {
    try {
        const userId = req.user.user_id;

        const prof = await cassandra.execute(
            "SELECT user_id, email, role, player_id, display_name, created_at FROM users_by_id WHERE user_id = ?",
            [userId],
            { prepare: true }
        );

        if (!prof.rowLength) return res.status(404).json({ error: "user_not_found" });
        return res.json({ user: prof.rows[0] });
    } catch (e) {
        console.error("[auth/me] error:", e);
        return res.status(500).json({ error: "server_error" });
    }
});

module.exports = router;
