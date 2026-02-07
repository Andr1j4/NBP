module.exports = {
    PORT: process.env.PORT || 8080,
    JWT_SECRET: process.env.JWT_SECRET || "dev_jwt_secret_change_me",
    PLAYLINK_SECRET: process.env.PLAYLINK_SECRET || "dev_playlink_secret_change_me",
    REDIS_URL: process.env.REDIS_URL || "redis://192.168.122.230:6379",
    FRONTEND_BASE: process.env.FRONTEND_BASE || "http://192.168.0.2:3000",
    CASSANDRA_CONTACT_POINTS: (process.env.CASSANDRA_HOSTS || "192.168.122.230").split(","),
    CASSANDRA_KEYSPACE: process.env.CASSANDRA_KEYSPACE || "turnir",
};
