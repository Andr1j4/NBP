import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import ReplayBoard from "./ReplayBoard";

const API_BASE = "http://10.121.107.106:8080";
const WS_BASE = "ws://10.121.107.106:8080";

function normalizeMatch(m) {
    const gameId = m.gameId ?? m.game_id ?? null;
    return {
        ...m,
        gameId,
        boardNumber: m.boardNumber ?? m.board_number ?? null,
        whitePlayer: m.whitePlayer ?? m.white_player ?? null,
        blackPlayer: m.blackPlayer ?? m.black_player ?? null,
        whiteName: m.whiteName ?? m.white_name ?? null,
        blackName: m.blackName ?? m.black_name ?? null,
        result: m.result ?? "",
    };
}

function uniq(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
}

export default function TournamentViewer() {
    const [tournaments, setTournaments] = useState([]);
    const [selectedTournamentId, setSelectedTournamentId] = useState("");
    const [info, setInfo] = useState(null);
    const [rounds, setRounds] = useState([]);
    const [activeRound, setActiveRound] = useState(null);

    const [matches, setMatches] = useState([]);
    const [standings, setStandings] = useState([]);

    const [activeTab, setActiveTab] = useState("pairings");
    const [status, setStatus] = useState("");

    const [watchedGameIds, setWatchedGameIds] = useState([]);
    const [replayGameId, setReplayGameId] = useState(null);

    const [archiveStatus, setArchiveStatus] = useState({});
    const [archiveCache, setArchiveCache] = useState({});

    const [refreshMs] = useState(5000);

    // Viewer WS
    const wsRef = useRef(null);
    const [viewerWsStatus, setViewerWsStatus] = useState("closed");

    const [gameStates, setGameStates] = useState({});

    // 1) tournaments
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/tournaments`);
                const data = await res.json();
                setTournaments(data.tournaments || []);
            } catch (e) {
                console.error("Failed to load tournaments", e);
            }
        })();
    }, []);

    // 2) load tournament info/rounds/matches/standings
    useEffect(() => {
        if (!selectedTournamentId) {
            setInfo(null);
            setRounds([]);
            setMatches([]);
            setStandings([]);
            setActiveRound(null);
            setWatchedGameIds([]);
            setReplayGameId(null);
            setGameStates({});
            return;
        }

        async function loadAll() {
            setStatus("Loading tournament data...");
            try {
                const infoRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}`);
                const infoData = await infoRes.json();
                if (!infoRes.ok) throw new Error(infoData.error || "failed to load tournament");
                setInfo(infoData);

                const rRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/rounds`);
                const rData = await rRes.json();
                if (!rRes.ok) throw new Error(rData.error || "failed to load rounds");

                const sortedRounds = (rData.rounds || []).sort((a, b) => a.round - b.round);
                setRounds(sortedRounds);

                const roundToView = sortedRounds.length ? sortedRounds[sortedRounds.length - 1].round : null;
                setActiveRound(roundToView);

                const sRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/standings`);
                const sData = await sRes.json();
                if (!sRes.ok) throw new Error(sData.error || "failed to load standings");
                setStandings(sData.standings || []);

                if (roundToView) {
                    const mRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${roundToView}/matches`);
                    const mData = await mRes.json();
                    if (!mRes.ok) throw new Error(mData.error || "failed to load matches");
                    setMatches((mData.matches || []).map(normalizeMatch));
                    setStatus(`Loaded round ${roundToView}`);
                } else {
                    setMatches([]);
                    setStatus("Tournament has no rounds yet.");
                }

                setWatchedGameIds([]);
                setReplayGameId(null);
                setGameStates({});
            } catch (err) {
                console.error(err);
                setStatus("Error loading tournament data (see console).");
            }
        }

        loadAll();
    }, [selectedTournamentId]);

    // 3) active round => matches
    useEffect(() => {
        if (!selectedTournamentId || !activeRound) return;

        async function loadMatches() {
            try {
                setStatus(`Loading matches for round ${activeRound}...`);
                const mRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${activeRound}/matches`);
                const mData = await mRes.json();
                if (!mRes.ok) {
                    setStatus(mData.error || "Failed to load matches");
                    return;
                }

                setMatches((mData.matches || []).map(normalizeMatch));
                setStatus(`Loaded matches for round ${activeRound}`);

                setWatchedGameIds([]);
                setReplayGameId(null);
                setGameStates({});
            } catch (err) {
                console.error(err);
                setStatus("Error loading matches (see console).");
            }
        }

        loadMatches();
    }, [selectedTournamentId, activeRound]);

    // 4) refresh standings + matches
    useEffect(() => {
        if (!selectedTournamentId || !activeRound) return;

        const id = setInterval(async () => {
            try {
                const sRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/standings`);
                const sData = await sRes.json();
                if (sRes.ok) setStandings(sData.standings || []);

                const mRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${activeRound}/matches`);
                const mData = await mRes.json();
                if (mRes.ok) setMatches((mData.matches || []).map(normalizeMatch));
            } catch (err) {
                console.error("Auto-refresh failed", err);
            }
        }, refreshMs);

        return () => clearInterval(id);
    }, [selectedTournamentId, activeRound, refreshMs]);

    const currentRoundMeta = rounds.find((r) => r.round === activeRound) || null;

    const finishedMatches = useMemo(() => matches.filter((m) => m.result), [matches]);
    const ongoingMatches = useMemo(() => matches.filter((m) => !m.result), [matches]);

    // archive probing
    useEffect(() => {
        for (const m of finishedMatches) {
            const gid = m.gameId;
            if (!gid) continue;
            if (archiveStatus[gid]) continue;
            probeArchive(gid);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishedMatches]);

    async function probeArchive(gameId) {
        setArchiveStatus((prev) => ({ ...prev, [gameId]: prev[gameId] || "loading" }));
        try {
            const res = await fetch(`${API_BASE}/api/games/${gameId}/archive`);
            if (res.status === 404) return setArchiveStatus((prev) => ({ ...prev, [gameId]: "missing" }));
            if (!res.ok) return setArchiveStatus((prev) => ({ ...prev, [gameId]: "error" }));
            const data = await res.json();
            setArchiveCache((prev) => ({ ...prev, [gameId]: data }));
            setArchiveStatus((prev) => ({ ...prev, [gameId]: "ok" }));
        } catch {
            setArchiveStatus((prev) => ({ ...prev, [gameId]: "error" }));
        }
    }

    // ===================== MULTI LIVE helpers =====================
    function isWatched(gameId) {
        return watchedGameIds.includes(gameId);
    }

    function toggleWatch(gameId) {
        if (!gameId) return;
        setReplayGameId(null);
        setWatchedGameIds((prev) => (prev.includes(gameId) ? prev.filter((x) => x !== gameId) : [...prev, gameId]));
    }

    function watchAllOngoing() {
        setReplayGameId(null);
        setWatchedGameIds(uniq(ongoingMatches.map((m) => m.gameId)));
    }

    function clearWatched() {
        setWatchedGameIds([]);
    }

    function openReplay(gameId) {
        setWatchedGameIds([]);
        setReplayGameId(gameId);
    }

    const matchByGameId = useMemo(() => {
        const mp = new Map();
        for (const x of matches) if (x.gameId) mp.set(x.gameId, x);
        return mp;
    }, [matches]);

    // ===================== VIEWER WS =====================
    useEffect(() => {
        const token = localStorage.getItem("authToken") || "";
        const qs = token ? `?token=${encodeURIComponent(token)}` : "";

        const urlsToTry = [
            `${WS_BASE}/viewer${qs}`,
            `${WS_BASE}/ws/viewer${qs}`,
        ];

        let attempt = 0;
        let ws = null;

        const connect = () => {
            const url = urlsToTry[attempt];
            attempt += 1;

            setViewerWsStatus("connecting");
            ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                setViewerWsStatus("open");
                ws.send(JSON.stringify({ type: "viewer_subscribe", gameIds: watchedGameIds }));
                ws.send(JSON.stringify({ type: "viewer_resync", gameIds: watchedGameIds }));
            };

            ws.onerror = () => setViewerWsStatus("error");

            ws.onclose = () => {
                setViewerWsStatus("closed");
                if (attempt < urlsToTry.length) connect();
            };

            ws.onmessage = (evt) => {
                try {
                    const data = JSON.parse(evt.data);

                    if (data.type === "viewer_snapshot_bundle") {
                        const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
                        setGameStates((prev) => {
                            const next = { ...prev };
                            for (const s of snaps) {
                                if (!s?.gameId) continue;
                                next[s.gameId] = {
                                    fen: s.fen || "",
                                    moves: Array.isArray(s.moves) ? s.moves : [],
                                    clock: s.clock || null,
                                    meta: s.meta || null,
                                    resultText:
                                        s?.meta?.finished && (s?.meta?.result || s?.meta?.reason)
                                            ? `${s.meta.result || ""}${s.meta.reason ? " – " + s.meta.reason : ""}`.trim()
                                            : "",
                                };
                            }
                            return next;
                        });
                        return;
                    }

                    const gid = data.gameId;
                    if (!gid) return;

                    if (data.type === "clock_state") {
                        setGameStates((prev) => ({
                            ...prev,
                            [gid]: {
                                ...(prev[gid] || {}),
                                clock: {
                                    ...(prev[gid]?.clock || {}),
                                    whiteMs: data.whiteMs,
                                    blackMs: data.blackMs,
                                    active: data.active,
                                    running: !!data.running,
                                    serverNow: data.serverNow,
                                },
                            },
                        }));
                        return;
                    }

                    if (data.type === "move") {
                        setGameStates((prev) => {
                            const old = prev[gid] || {};
                            const oldMoves = Array.isArray(old.moves) ? old.moves : [];

                            const mv = data.move || {};
                            const san = mv.san;

                            let nextMoves = oldMoves;
                            if (san) {
                                nextMoves = [...oldMoves];
                                if (mv.color === "w") {
                                    nextMoves.push({ moveNumber: nextMoves.length + 1, white: san, black: "" });
                                } else {
                                    if (nextMoves.length === 0) nextMoves.push({ moveNumber: 1, white: "...", black: san });
                                    else nextMoves[nextMoves.length - 1] = { ...nextMoves[nextMoves.length - 1], black: san };
                                }
                            }

                            return {
                                ...prev,
                                [gid]: { ...old, fen: data.fen || old.fen || "", moves: nextMoves },
                            };
                        });
                        return;
                    }

                    if (data.type === "undo") {
                        const ws2 = wsRef.current;
                        if (ws2?.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: "viewer_resync_one", gameId: gid }));
                        return;
                    }

                    if (data.type === "reset") {
                        setGameStates((prev) => ({
                            ...prev,
                            [gid]: {
                                ...(prev[gid] || {}),
                                fen: data.fen || "",
                                moves: Array.isArray(data.moves) ? data.moves : [],
                                resultText: "",
                                meta: { ...(prev[gid]?.meta || {}), finished: false, result: "", reason: "" },
                            },
                        }));
                        return;
                    }

                    if (data.type === "game_result") {
                        const txt = (data.result || "Game finished") + (data.reason ? ` – ${data.reason}` : "");
                        setGameStates((prev) => ({
                            ...prev,
                            [gid]: {
                                ...(prev[gid] || {}),
                                resultText: txt,
                                meta: { ...(prev[gid]?.meta || {}), finished: true, result: data.result || "", reason: data.reason || "" },
                                clock: prev[gid]?.clock ? { ...prev[gid].clock, running: false } : prev[gid]?.clock,
                            },
                        }));
                        return;
                    }
                } catch (e) {
                    console.warn("[viewer ws] bad message", e);
                }
            };
        };

        connect();

        return () => {
            try {
                ws?.close();
            } catch { }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // When watched list changes, send subscribe (if open)
    useEffect(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "viewer_subscribe", gameIds: watchedGameIds }));
        ws.send(JSON.stringify({ type: "viewer_resync", gameIds: watchedGameIds }));
    }, [watchedGameIds]);

    function downloadTextFile(filename, text) {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function buildPgnFromArchive(a) {
        const ev = a.tournamentId ? `Tournament ${a.tournamentId}` : "Game";
        const site = a.tournamentId ? `Round ${a.round ?? "?"} Board ${a.boardNumber ?? "?"}` : "Local";
        const white = a.whitePlayer || "White";
        const black = a.blackPlayer || "Black";
        const result = a.result || "*";
        const san = Array.isArray(a.sanMoves) ? a.sanMoves : [];

        const moves = [];
        for (let i = 0; i < san.length; i += 2) {
            const moveNo = i / 2 + 1;
            const w = san[i] || "";
            const b = san[i + 1] || "";
            moves.push(`${moveNo}. ${w}${b ? " " + b : ""}`.trim());
        }

        const tags = [
            `[Event "${ev}"]`,
            `[Site "${site}"]`,
            `[Date "${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}"]`,
            `[Round "${a.round ?? "?"}"]`,
            `[White "${white}"]`,
            `[Black "${black}"]`,
            `[Result "${result}"]`,
        ];
        if (a.finalFen) tags.push(`[FEN "${a.finalFen}"]`);

        return `${tags.join("\n")}\n\n${moves.join(" ")} ${result}\n`;
    }

    async function downloadPgn(gameId) {
        let a = archiveCache[gameId];
        if (!a) {
            const res = await fetch(`${API_BASE}/api/games/${gameId}/archive`);
            if (!res.ok) return;
            a = await res.json();
            setArchiveCache((prev) => ({ ...prev, [gameId]: a }));
            setArchiveStatus((prev) => ({ ...prev, [gameId]: "ok" }));
        }
        const pgn = buildPgnFromArchive(a);
        downloadTextFile(`${gameId}.pgn`, pgn);
    }

    const viewerWsColor =
        viewerWsStatus === "open" ? "green" : viewerWsStatus === "connecting" ? "orange" : viewerWsStatus === "error" ? "red" : "#555";

    // ===================== UI =====================

    return (
        <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
            <h2>♟ Tournament Viewer</h2>

            <div style={{ marginBottom: 10, fontSize: "0.9rem" }}>
                Viewer WS: <span style={{ color: viewerWsColor }}>{viewerWsStatus}</span>
            </div>

            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Tournament:&nbsp;
                    <select value={selectedTournamentId} onChange={(e) => setSelectedTournamentId(e.target.value)}>
                        <option value="">-- select tournament --</option>
                        {tournaments.map((t) => (
                            <option key={t.id || t.tournamentId} value={t.id || t.tournamentId}>
                                {t.name} ({t.status}) – {t.id || t.tournamentId}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {info && (
                <div style={{ marginBottom: "1rem", padding: "0.75rem", border: "1px solid #ccc", borderRadius: "4px", background: "#fafafa" }}>
                    <div>
                        <strong>{info.name}</strong>
                    </div>
                    <div>Location: {info.location || "—"}</div>
                    <div>Status: {info.status}</div>
                    <div>Format: {info.type} | Time control: {info.timeControl}</div>

                    <div>
                        Rounds:&nbsp;
                        {rounds.length === 0
                            ? "none yet"
                            : rounds.map((r) => {
                                const finished = !!r.finishedAt;
                                return (
                                    <button
                                        key={r.round}
                                        onClick={() => setActiveRound(r.round)}
                                        style={{
                                            marginRight: "0.25rem",
                                            padding: "0.15rem 0.4rem",
                                            fontSize: "0.8rem",
                                            borderRadius: "3px",
                                            border: r.round === activeRound ? "2px solid #333" : "1px solid #aaa",
                                            background: finished ? "#e6ffe6" : "#ffe",
                                        }}
                                    >
                                        R{r.round}
                                    </button>
                                );
                            })}
                    </div>

                    {currentRoundMeta && (
                        <div style={{ marginTop: "0.25rem", fontSize: "0.9rem" }}>
                            Viewing round {currentRoundMeta.round} – {currentRoundMeta.finishedAt ? "finished" : "in progress"}
                        </div>
                    )}
                </div>
            )}

            <div style={{ marginBottom: "0.75rem" }}>
                <button
                    onClick={() => setActiveTab("pairings")}
                    disabled={!selectedTournamentId}
                    style={{ marginRight: "0.3rem", fontWeight: activeTab === "pairings" ? "bold" : "normal" }}
                >
                    Pairings
                </button>
                <button
                    onClick={() => setActiveTab("standings")}
                    disabled={!selectedTournamentId}
                    style={{ marginRight: "0.3rem", fontWeight: activeTab === "standings" ? "bold" : "normal" }}
                >
                    Standings
                </button>
                <button onClick={() => setActiveTab("finished")} disabled={!selectedTournamentId} style={{ fontWeight: activeTab === "finished" ? "bold" : "normal" }}>
                    Finished games
                </button>
            </div>

            {status && <div style={{ marginBottom: "0.5rem", fontStyle: "italic" }}>{status}</div>}

            {activeTab === "pairings" && ongoingMatches.length > 0 && (
                <div style={{ marginBottom: "1rem", padding: "0.75rem", border: "1px solid #ccc", borderRadius: "4px", background: "#f4f8ff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <strong>Live boards ({watchedGameIds.length})</strong>
                        <button onClick={watchAllOngoing} disabled={!selectedTournamentId}>
                            Watch all ongoing
                        </button>
                        <button onClick={clearWatched} disabled={watchedGameIds.length === 0}>
                            Clear
                        </button>
                    </div>

                    {watchedGameIds.length > 0 && (
                        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12 }}>
                            {watchedGameIds.map((gid) => {
                                const m = matchByGameId.get(gid);
                                const title = m ? `Board ${m.boardNumber}: ${m.whiteName || m.whitePlayer} vs ${m.blackName || m.blackPlayer}` : gid;
                                const state = gameStates[gid] || null;

                                return <ViewerBoardTile key={gid} gameId={gid} title={title} state={state} onClose={() => toggleWatch(gid)} />;
                            })}
                        </div>
                    )}
                </div>
            )}

            {activeTab === "pairings" && activeRound && (
                <div>
                    <h3>Round {activeRound} – pairings</h3>

                    {matches.length === 0 ? (
                        <div>No matches for this round.</div>
                    ) : (
                        <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", minWidth: "760px" }}>
                            <thead>
                                <tr>
                                    <th>Board</th>
                                    <th>Game ID</th>
                                    <th>White</th>
                                    <th>Black</th>
                                    <th>Result</th>
                                    <th>Watch</th>
                                </tr>
                            </thead>
                            <tbody>
                                {ongoingMatches.length === 0 && (
                                    <tr>
                                        <td colSpan="6" style={{ textAlign: "center", color: "#777" }}>
                                            All games finished.
                                        </td>
                                    </tr>
                                )}

                                {ongoingMatches.map((m) => (
                                    <tr key={m.boardNumber}>
                                        <td>{m.boardNumber}</td>
                                        <td style={{ fontFamily: "monospace" }}>{m.gameId}</td>
                                        <td title={m.whitePlayer}>{m.whiteName || m.whitePlayer}</td>
                                        <td title={m.blackPlayer}>{m.blackName || m.blackPlayer}</td>
                                        <td>{m.result || "in progress"}</td>
                                        <td>
                                            <button onClick={() => toggleWatch(m.gameId)}>{isWatched(m.gameId) ? "Unwatch" : "Watch"}</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {activeTab === "standings" && (
                <div>
                    <h3>Standings</h3>
                    {standings.length === 0 ? (
                        <div>No standings yet.</div>
                    ) : (
                        <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", minWidth: "400px" }}>
                            <thead>
                                <tr>
                                    <th>Rank</th>
                                    <th>Player</th>
                                    <th>Points</th>
                                </tr>
                            </thead>
                            <tbody>
                                {standings.map((s) => {
                                    const pid = s.player_id || s.playerId;
                                    return (
                                        <tr key={pid}>
                                            <td>{s.rank}</td>
                                            <td title={pid}>{s.name || pid}</td>
                                            <td>{s.points}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {activeTab === "finished" && activeRound && (
                <div>
                    <h3>Round {activeRound} – finished games</h3>

                    {finishedMatches.length === 0 ? (
                        <div>No finished games in this round.</div>
                    ) : (
                        <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", minWidth: "900px" }}>
                            <thead>
                                <tr>
                                    <th>Board</th>
                                    <th>Game ID</th>
                                    <th>White</th>
                                    <th>Black</th>
                                    <th>Result</th>
                                    <th>Archive</th>
                                    <th>Replay</th>
                                    <th>PGN</th>
                                </tr>
                            </thead>
                            <tbody>
                                {finishedMatches.map((m) => {
                                    const st = archiveStatus?.[m.gameId];
                                    return (
                                        <tr key={m.boardNumber}>
                                            <td>{m.boardNumber}</td>
                                            <td style={{ fontFamily: "monospace" }}>{m.gameId}</td>
                                            <td title={m.whitePlayer}>{m.whiteName || m.whitePlayer}</td>
                                            <td title={m.blackPlayer}>{m.blackName || m.blackPlayer}</td>
                                            <td>{m.result}</td>

                                            <td style={{ textAlign: "center" }}>
                                                {st === "ok" && <span title="Archived">✅</span>}
                                                {st === "missing" && <span title="Missing archive">❌</span>}
                                                {st === "loading" && <span title="Checking…">⏳</span>}
                                                {st === "error" && <span title="Archive check error">⚠️</span>}
                                                {!st && <span title="Not checked yet">—</span>}
                                            </td>

                                            <td>
                                                <button onClick={() => openReplay(m.gameId)} disabled={st !== "ok"}>
                                                    Replay
                                                </button>
                                            </td>
                                            <td>
                                                <button onClick={() => downloadPgn(m.gameId)} disabled={st !== "ok"}>
                                                    PGN
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {replayGameId && (
                <div style={{ marginTop: "1.5rem", padding: "0.75rem", border: "1px solid #ccc", borderRadius: "4px", background: "#fff9f3" }}>
                    <div style={{ marginBottom: "0.5rem" }}>
                        <strong>Replay:</strong> <code>{replayGameId}</code>
                        <button style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }} onClick={() => setReplayGameId(null)}>
                            ✖ Close
                        </button>
                    </div>
                    <ReplayBoard gameId={replayGameId} />
                </div>
            )}
        </div>
    );
}

/* ===================== Viewer-only tile (NO extra websockets) ===================== */

function ViewerBoardTile({ gameId, title, state, onClose }) {
    const boardWidth = 320;

    const fen = state?.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const clock = state?.clock || null;
    const resultText = state?.resultText || "";

    const [displayClock, setDisplayClock] = useState({ whiteMs: null, blackMs: null });

    useEffect(() => {
        if (!clock?.serverNow || clock.whiteMs == null || clock.blackMs == null) {
            setDisplayClock({ whiteMs: clock?.whiteMs ?? null, blackMs: clock?.blackMs ?? null });
            return;
        }

        let rafId = null;

        const tick = () => {
            if (!clock.running || !clock.active) {
                setDisplayClock({ whiteMs: clock.whiteMs, blackMs: clock.blackMs });
                rafId = requestAnimationFrame(tick);
                return;
            }

            const now = Date.now();
            const elapsed = now - clock.serverNow;

            let w = clock.whiteMs;
            let b = clock.blackMs;

            if (clock.active === "w") w = Math.max(0, clock.whiteMs - elapsed);
            if (clock.active === "b") b = Math.max(0, clock.blackMs - elapsed);

            setDisplayClock({ whiteMs: w, blackMs: b });
            rafId = requestAnimationFrame(tick);
        };

        rafId = requestAnimationFrame(tick);
        return () => {
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [clock?.serverNow, clock?.whiteMs, clock?.blackMs, clock?.active, clock?.running]);

    function formatTime(ms) {
        if (ms == null) return "—";
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    return (
        <div style={{ border: "1px solid #c9d6ff", borderRadius: 6, background: "#fff", padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div>
                    <div style={{ fontWeight: "bold" }}>{title}</div>
                    <div style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#555" }}>{gameId}</div>
                </div>
                <button onClick={onClose} style={{ whiteSpace: "nowrap" }}>
                    ✖ Close
                </button>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "monospace", fontSize: "0.9rem" }}>
                <div>
                    ♟ White <span style={{ fontWeight: clock?.active === "w" && clock?.running ? "bold" : "normal" }}>{formatTime(displayClock.whiteMs)}</span>
                </div>
                <div>
                    ♟ Black <span style={{ fontWeight: clock?.active === "b" && clock?.running ? "bold" : "normal" }}>{formatTime(displayClock.blackMs)}</span>
                </div>
            </div>

            <div style={{ marginTop: 8 }}>
                <Chessboard
                    boardWidth={boardWidth}
                    position={fen}
                    arePiecesDraggable={false}
                    customBoardStyle={{
                        borderRadius: "4px",
                        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.25)",
                    }}
                />
            </div>

            {resultText && (
                <div style={{ marginTop: 8, padding: "0.25rem 0.5rem", background: "#eee", borderRadius: 4, fontSize: "0.9rem" }}>
                    <strong>Result:</strong> {resultText}
                </div>
            )}
        </div>
    );
}
