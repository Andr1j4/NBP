const { createClient } = require("redis");
const { REDIS_URL } = require("../utils/config");


const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => console.error("[ERROR] Redis:", err));

(async () => {
    try {
        await redis.connect();
        console.log("[INFO] Redis connected");
    } catch (e) {
        console.error("[ERROR] Redis connect failed:", e);
        process.exit(1);
    }
})();

module.exports = redis;