const { buildViewerSnapshot } = require("../utils/viewer");

async function handleViewerConnection(ws, redis, cassandra) {
    ws.kind = "viewer";
    ws.viewerSubs = new Set();

    console.log("[INFO] Viewer WS connected");

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === "viewer_subscribe") {
                const ids = Array.isArray(data.gameIds) ? data.gameIds.filter(Boolean) : [];
                ws.viewerSubs = new Set(ids);

                const snapshots = [];
                for (const gid of ids) {
                    try {
                        snapshots.push(await buildViewerSnapshot(redis, cassandra, gid));
                    } catch (e) {
                        snapshots.push({ type: "viewer_snapshot_error", gameId: gid, error: "snapshot_failed" });
                    }
                }

                ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots }));
                return;
            }

            if (data.type === "viewer_add") {
                const gid = data.gameId;
                if (gid) ws.viewerSubs.add(gid);
                const snap = await buildViewerSnapshot(redis, cassandra, gid);
                ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots: [snap] }));
                return;
            }

            if (data.type === "viewer_remove") {
                const gid = data.gameId;
                if (gid) ws.viewerSubs.delete(gid);
                ws.send(JSON.stringify({ type: "viewer_ok", removed: gid }));
                return;
            }

            if (data.type === "viewer_clear") {
                ws.viewerSubs.clear();
                ws.send(JSON.stringify({ type: "viewer_ok", cleared: true }));
                return;
            }

            if (data.type === "viewer_resync_one") {
                const gid = data.gameId;
                if (!gid) return;
                const snap = await buildViewerSnapshot(redis, cassandra, gid);
                ws.send(JSON.stringify({ type: "viewer_snapshot_bundle", snapshots: [snap] }));
                return;
            }

            ws.send(JSON.stringify({ type: "error", reason: "unknown_viewer_message" }));
        } catch (e) {
            console.warn("[viewer] bad msg:", e);
            try {
                ws.send(JSON.stringify({ type: "error", reason: "bad_json" }));
            } catch { }
        }
    });

    ws.on("close", () => console.log("[INFO] Viewer WS disconnected"));
}

module.exports = { handleViewerConnection };
