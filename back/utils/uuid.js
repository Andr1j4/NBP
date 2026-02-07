const { types } = require("cassandra-driver");

function asUuid(value, label = "uuid") {
    if (value == null) throw new Error(`${label} missing`);
    if (value instanceof types.Uuid) return value;
    if (typeof value === "string") return types.Uuid.fromString(value);
    throw new Error(`${label} invalid type: ${typeof value}`);
}

function normalizeUuid(x) {
    if (x == null) return null;
    return String(x).trim().toLowerCase();
}

module.exports = { asUuid, normalizeUuid };
