const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, PLAYLINK_SECRET } = require("./config");

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

function signJwt(payload, expiresIn = "12h") {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyJwt(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
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

    try {
        const obj = JSON.parse(b64urlDecodeToString(payload));
        if (obj.exp && Date.now() > obj.exp) return null;
        return obj;
    } catch {
        return null;
    }
}

module.exports = { signJwt, verifyJwt, signPlayToken, verifyPlayToken };
