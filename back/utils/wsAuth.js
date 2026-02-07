function parseWsUrl(req) {
    return new URL(req.url, "http://localhost");
}

function getJwtFromWsReq(req) {
    try {
        const url = parseWsUrl(req);
        return url.searchParams.get("token");
    } catch {
        return null;
    }
}

function getPlayFromWsReq(req) {
    try {
        const url = parseWsUrl(req);
        return url.searchParams.get("play");
    } catch {
        return null;
    }
}

module.exports = { parseWsUrl, getJwtFromWsReq, getPlayFromWsReq };
