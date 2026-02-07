const cassandra = require("cassandra-driver");
const { CASSANDRA_CONTACT_POINTS, CASSANDRA_KEYSPACE } = require("../utils/config");

const client = new cassandra.Client({
    contactPoints: CASSANDRA_CONTACT_POINTS,
    localDataCenter: "datacenter1",
    keyspace: CASSANDRA_KEYSPACE,
});

(async () => {
    try {
        await client.connect();
        console.log("[INFO] Cassandra connected");
    } catch (e) {
        console.error("[ERROR] Cassandra connect failed:", e);
        process.exit(1);
    }
})();

module.exports = client;
