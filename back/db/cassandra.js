const cassandra = require("cassandra-driver");
const { CASSANDRA_CONTACT_POINTS, CASSANDRA_KEYSPACE } = require("../utils/config");
const fs = require("fs");              // ✅ NOVO
const path = require("path");          // ✅ NOVO

const contactPoints = CASSANDRA_CONTACT_POINTS;
const keyspace = CASSANDRA_KEYSPACE;

// Glavni klijent koji će koristiti keyspace "turnir"
const client = new cassandra.Client({
    contactPoints: contactPoints,
    localDataCenter: "datacenter1",
    keyspace: keyspace,
});

// jednostavan retry mehanizam da sačeka da Cassandra proradi u Docker-u
const MAX_RETRIES = parseInt(process.env.CASSANDRA_MAX_RETRIES || "20", 10);
const RETRY_DELAY_MS = parseInt(process.env.CASSANDRA_RETRY_DELAY_MS || "3000", 10);

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ✅ NOVO: učitaj schema.cql i izvrši sve CREATE TABLE IF NOT EXISTS...
async function initSchema(bootstrap) {
    try {
        const explicitFile = process.env.SCHEMA_FILE;
        const defaultFile = path.join(__dirname, "..", "schema.cql");
        const schemaFile = explicitFile || defaultFile;

        let cqlText = process.env.SCHEMA_CQL || "";
        const exists = schemaFile && fs.existsSync(schemaFile);

        console.log("[SCHEMA_INIT_BOOTSTRAP] schemaFile:", schemaFile, "exists:", exists);

        if (!cqlText && exists) {
            cqlText = fs.readFileSync(schemaFile, "utf-8");
        }

        if (!cqlText) {
            console.warn("[SCHEMA_INIT_BOOTSTRAP] No schema CQL found, skipping table init.");
            return;
        }

        const statements = cqlText
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);

        console.log(`[SCHEMA_INIT_BOOTSTRAP] Executing ${statements.length} CQL statements...`);
        for (const stmt of statements) {
            try {
                await bootstrap.execute(stmt, [], { prepare: false });
            } catch (e) {
                console.warn("[SCHEMA_INIT_BOOTSTRAP] statement failed:", { stmt, err: e.message });
            }
        }
        console.log("[SCHEMA_INIT_BOOTSTRAP] Done.");
    } catch (e) {
        console.error("[SCHEMA_INIT_BOOTSTRAP] Fatal error:", e);
    }
}

// 1) Bootstrap konekcija BEZ keyspace-a -> CREATE KEYSPACE IF NOT EXISTS
async function ensureKeyspace() {
    const bootstrap = new cassandra.Client({
        contactPoints: contactPoints,
        localDataCenter: "datacenter1",
    });

    let attempt = 0;
    while (true) {
        attempt += 1;
        try {
            console.log(
                `[INFO] [bootstrap] Connecting to Cassandra (attempt ${attempt})...`,
                { hosts: contactPoints }
            );
            await bootstrap.connect();
            console.log(
                "[INFO] [bootstrap] Connected. Ensuring keyspace exists:",
                keyspace
            );

            await bootstrap.execute(
                `
                CREATE KEYSPACE IF NOT EXISTS ${keyspace}
                WITH replication = {'class': 'SimpleStrategy', 'replication_factor': '1'}
                AND durable_writes = true
                `
            );

            // ✅ OVDE inicijalizujemo i SVE TABELE iz schema.cql
            await initSchema(bootstrap);

            await bootstrap.shutdown();
            console.log("[INFO] [bootstrap] Keyspace and schema ready:", keyspace);
            return;
        } catch (e) {
            console.error(
                `[ERROR] [bootstrap] Cassandra connect / keyspace ensure failed (attempt ${attempt}):`,
                e.message
            );
            if (attempt >= MAX_RETRIES) {
                console.error(
                    "[ERROR] [bootstrap] Giving up connecting to Cassandra, exiting."
                );
                process.exit(1);
            }
            await sleep(RETRY_DELAY_MS);
        }
    }
}

// 2) Glavna konekcija SA keyspace-om
(async () => {
    await ensureKeyspace();

    let attempt = 0;
    while (true) {
        attempt += 1;
        try {
            console.log(`[INFO] Connecting to Cassandra (attempt ${attempt})...`, {
                hosts: contactPoints,
                keyspace: keyspace,
            });
            await client.connect();
            console.log("[INFO] Cassandra connected (keyspace:", keyspace, ")");
            break;
        } catch (e) {
            console.error(
                `[ERROR] Cassandra connect failed (attempt ${attempt}):`,
                e.message
            );
            if (attempt >= MAX_RETRIES) {
                console.error("[ERROR] Giving up connecting to Cassandra, exiting.");
                process.exit(1);
            }
            await sleep(RETRY_DELAY_MS);
        }
    }
})();

module.exports = client;
