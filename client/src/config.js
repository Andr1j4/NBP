const isDev = process.env.NODE_ENV === "development";

// Docker: backend je iz perspektive browser-a na localhost:8080
const API_HOST = process.env.REACT_APP_API_HOST || "localhost";
const API_PORT = process.env.REACT_APP_API_PORT || "8080";
const WS_PROTOCOL = process.env.REACT_APP_WS_PROTOCOL || "ws";

export const API_BASE = `http://${API_HOST}:${API_PORT}`;
export const WS_BASE = `${WS_PROTOCOL}://${API_HOST}:${API_PORT}`;

export const DEFAULT_PLAYERS = [
    "0e087985-98a7-48dd-b3db-7d7f9da87520",
    "1f6fa85d-9c47-4d7f-b33f-81f172a8c82a",
    "c1bb8a8d-06f5-42bd-af1a-0b619bce08c4",
    "f8017097-2cf4-4817-bef4-1b109e8ef880",
];

export const STORAGE_KEYS = {
    AUTH_TOKEN: "authToken",
    ADMIN_TOKEN: "turnir_admin_authToken",
    ADMIN_ME: "turnir_admin_me",
    GAME_LAST_ID: (gameId) => `game:${gameId}:lastId`,
};
