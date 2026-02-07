const RUN_ENV = process.env.RUN_ENV || process.env.NODE_ENV || "local";
const isDocker = RUN_ENV === "docker";

module.exports = {
    PORT: process.env.PORT || 8080,
    JWT_SECRET: process.env.JWT_SECRET || "dev_jwt_secret_change_me",
    PLAYLINK_SECRET: process.env.PLAYLINK_SECRET || "dev_playlink_secret_change_me",

    // Lokalno: koristiš svoju IP adresu; Docker: ime servisa "redis"
    REDIS_URL:
        process.env.REDIS_URL ||
        (isDocker ? "redis://redis:6379" : "redis://192.168.122.230:6379"),

    // FRONTEND_BASE je ono što će biti u linkovima za playlink (što vidi browser)
    FRONTEND_BASE:
        process.env.FRONTEND_BASE ||
        (isDocker ? "http://localhost:3000" : "http://192.168.0.2:3000"),

    // Cassandra host lokalno vs Docker ("cassandra" kao service name)
    CASSANDRA_CONTACT_POINTS: (
        process.env.CASSANDRA_HOSTS ||
        (isDocker ? "cassandra" : "192.168.122.230")
    ).split(","),

    CASSANDRA_KEYSPACE: process.env.CASSANDRA_KEYSPACE || "turnir",

    // CORS origin-i: lista razdvojena zarezom, ili razumna podrazumevana vrednost
    CORS_ORIGINS: (
        process.env.CORS_ORIGINS ||
        (isDocker
            ? "http://localhost:3000"
            : "http://localhost:3000,http://127.0.0.1:3000,http://192.168.0.1:3000,http://192.168.0.2:3000")
    )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
};
