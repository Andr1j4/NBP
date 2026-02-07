// server/middleware/auth.js
const jwt = require("jsonwebtoken");

function authRequired(req, res, next) {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

    if (!token) return res.status(401).json({ error: "missing_token" });

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.user = payload; // { user_id, email, role, player_id }
        return next();
    } catch (e) {
        return res.status(401).json({ error: "invalid_token" });
    }
}

function authOptional(req, _res, next) {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

    if (!token) {
        req.user = null;
        return next();
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
        req.user = null;
    }
    return next();
}

function asUuid(value, label = "uuid") {
    if (!value) throw new Error(`Missing ${label}`);
    if (typeof value === "string") return types.Uuid.fromString(value);
    // cassandra-driver sometimes returns Uuid objects already
    if (value instanceof types.Uuid) return value;
    // if object with toString
    if (typeof value.toString === "function") return types.Uuid.fromString(value.toString());
    throw new Error(`Invalid ${label}: ${String(value)}`);
}


function requireRole(role) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: "missing_token" });
        if (req.user.role !== role) return res.status(403).json({ error: "forbidden" });
        return next();
    };
}

module.exports = { authRequired, authOptional, requireRole, asUuid };
