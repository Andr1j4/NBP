// client/src/TournamentViewer.js
import React, { useEffect, useState } from "react";
import SpectatorBoard from "./SpectatorBoard";
import ReplayBoard from "./ReplayBoard";

export default function TournamentViewer() {
    const [tournaments, setTournaments] = useState([]);
    const [selectedTournamentId, setSelectedTournamentId] = useState("");
    const [info, setInfo] = useState(null);
    const [rounds, setRounds] = useState([]);
    const [activeRound, setActiveRound] = useState(null);

    const [matches, setMatches] = useState([]);
    const [standings, setStandings] = useState([]);

    const [activeTab, setActiveTab] = useState("pairings"); // "pairings" | "standings" | "finished"
    const [status, setStatus] = useState("");

    const [watchedGameId, setWatchedGameId] = useState(null); // LIVE
    const [replayGameId, setReplayGameId] = useState(null);   // ARCHIVE

    const [archiveStatus, setArchiveStatus] = useState({});
    // { [gameId]: 'loading' | 'ok' | 'missing' | 'error' }

    const [archiveCache, setArchiveCache] = useState({});
    // { [gameId]: archiveJson }


    const [refreshMs] = useState(5000); // 5s auto-refresh
    const API_BASE = "http://192.168.0.2:8080";

    // 1) Load all tournaments on mount
    useEffect(() => {
        async function loadTournaments() {
            try {
                const res = await fetch(`${API_BASE}/api/tournaments`);
                const data = await res.json();
                setTournaments(data.tournaments || []);
            } catch (e) {
                console.error("Failed to load tournaments", e);
            }
        }
        loadTournaments();
    }, [API_BASE]);

    // 2) When a tournament is selected: load info, rounds, standings, matches for latest round
    useEffect(() => {
        if (!selectedTournamentId) {
            setInfo(null);
            setRounds([]);
            setMatches([]);
            setStandings([]);
            setActiveRound(null);
            setWatchedGameId(null);
            setReplayGameId(null);
            return;
        }

        async function loadAll() {
            setStatus("Loading tournament data...");

            try {
                // info
                const infoRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}`);
                const infoData = await infoRes.json();
                if (!infoRes.ok) throw new Error(infoData.error || "failed to load tournament");
                setInfo(infoData);

                // rounds
                const rRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/rounds`);
                const rData = await rRes.json();
                if (!rRes.ok) throw new Error(rData.error || "failed to load rounds");

                const sortedRounds = (rData.rounds || []).sort((a, b) => a.round - b.round);
                setRounds(sortedRounds);

                let roundToView = null;
                if (sortedRounds.length > 0) {
                    roundToView = sortedRounds[sortedRounds.length - 1].round; // latest
                }
                setActiveRound(roundToView);

                // standings
                const sRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/standings`);
                const sData = await sRes.json();
                if (!sRes.ok) throw new Error(sData.error || "failed to load standings");
                setStandings(sData.standings || []);

                // matches for latest round
                if (roundToView) {
                    const mRes = await fetch(
                        `${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${roundToView}/matches`
                    );
                    const mData = await mRes.json();
                    if (!mRes.ok) throw new Error(mData.error || "failed to load matches");
                    setMatches(mData.matches || []);
                    setStatus(`Loaded round ${roundToView}`);
                } else {
                    setMatches([]);
                    setStatus("Tournament has no rounds yet.");
                }

                // reset boards when switching tournament
                setWatchedGameId(null);
                setReplayGameId(null);
            } catch (err) {
                console.error(err);
                setStatus("Error loading tournament data (see console).");
            }
        }

        loadAll();
    }, [selectedTournamentId, API_BASE]);

    // 3) When activeRound changes, load its matches
    useEffect(() => {
        if (!selectedTournamentId || !activeRound) return;

        async function loadMatches() {
            try {
                setStatus(`Loading matches for round ${activeRound}...`);
                const mRes = await fetch(
                    `${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${activeRound}/matches`
                );
                const mData = await mRes.json();
                if (!mRes.ok) {
                    setStatus(mData.error || "Failed to load matches");
                    return;
                }
                setMatches(mData.matches || []);
                setStatus(`Loaded matches for round ${activeRound}`);

                // reset boards when switching round
                setWatchedGameId(null);
                setReplayGameId(null);
            } catch (err) {
                console.error(err);
                setStatus("Error loading matches (see console).");
            }
        }

        loadMatches();
    }, [selectedTournamentId, activeRound, API_BASE]);

    // 4) Auto-refresh standings + matches for active round
    useEffect(() => {
        if (!selectedTournamentId || !activeRound) return;

        const id = setInterval(async () => {
            try {
                // refresh standings
                const sRes = await fetch(`${API_BASE}/api/tournaments/${selectedTournamentId}/standings`);
                const sData = await sRes.json();
                if (sRes.ok) setStandings(sData.standings || []);

                // refresh matches
                const mRes = await fetch(
                    `${API_BASE}/api/tournaments/${selectedTournamentId}/rounds/${activeRound}/matches`
                );
                const mData = await mRes.json();
                if (mRes.ok) setMatches(mData.matches || []);
            } catch (err) {
                console.error("Auto-refresh failed", err);
            }
        }, refreshMs);

        return () => clearInterval(id);
    }, [selectedTournamentId, activeRound, refreshMs, API_BASE]);




    const currentRoundMeta = rounds.find((r) => r.round === activeRound) || null;

    const finishedMatches = matches.filter((m) => m.result && m.result !== "");
    const ongoingMatches = matches.filter((m) => !m.result || m.result === "");

    useEffect(() => {
        // when finishedMatches changes, probe any gameIds we haven't checked yet
        for (const m of finishedMatches) {
            const gid = m.gameId;
            if (!gid) continue;
            if (archiveStatus[gid]) continue; // already checked
            probeArchive(gid);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishedMatches]);

    async function probeArchive(gameId) {
        if (!gameId) return;
        setArchiveStatus((prev) => ({ ...prev, [gameId]: prev[gameId] || "loading" }));

        try {
            const res = await fetch(`${API_BASE}/api/games/${gameId}/archive`);
            if (res.status === 404) {
                setArchiveStatus((prev) => ({ ...prev, [gameId]: "missing" }));
                return;
            }
            if (!res.ok) {
                setArchiveStatus((prev) => ({ ...prev, [gameId]: "error" }));
                return;
            }
            const data = await res.json();
            setArchiveCache((prev) => ({ ...prev, [gameId]: data }));
            setArchiveStatus((prev) => ({ ...prev, [gameId]: "ok" }));
        } catch (e) {
            setArchiveStatus((prev) => ({ ...prev, [gameId]: "error" }));
        }
    }

    function buildPgnFromArchive(a) {
        // minimal PGN (works well for lichess/chess.com import too)
        const ev = a.tournamentId ? `Tournament ${a.tournamentId}` : "Game";
        const site = a.tournamentId ? `Round ${a.round ?? "?"} Board ${a.boardNumber ?? "?"}` : "Local";
        const white = a.whitePlayer || "White";
        const black = a.blackPlayer || "Black";
        const result = a.result || "*";

        const san = Array.isArray(a.sanMoves) ? a.sanMoves : [];

        // Build "1. e4 e5 2. Nf3 Nc6 ..."
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

        // Optional: include final fen (helps if something weird happened)
        if (a.finalFen) tags.push(`[FEN "${a.finalFen}"]`);

        return `${tags.join("\n")}\n\n${moves.join(" ")} ${result}\n`;
    }

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



    function openLive(gameId) {
        setReplayGameId(null);
        setWatchedGameId(gameId);
    }

    function openReplay(gameId) {
        setWatchedGameId(null);
        setReplayGameId(gameId);
    }

    return (
        <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
            <h2>♟ Tournament Viewer</h2>

            {/* Tournament selector */}
            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Tournament:&nbsp;
                    <select
                        value={selectedTournamentId}
                        onChange={(e) => setSelectedTournamentId(e.target.value)}
                    >
                        <option value="">-- select tournament --</option>
                        {tournaments.map((t) => (
                            <option key={t.id || t.tournamentId} value={t.id || t.tournamentId}>
                                {t.name} ({t.status}) – {t.id || t.tournamentId}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {/* Champion */}
            {info && info.winnerId && (
                <div style={{ marginTop: "0.25rem", fontSize: "0.9rem", color: "#006400" }}>
                    🏆 Champion:&nbsp;{info.winnerName || info.winnerId}
                </div>
            )}

            {/* Tournament header */}
            {info && (
                <div
                    style={{
                        marginBottom: "1rem",
                        padding: "0.75rem",
                        border: "1px solid #ccc",
                        borderRadius: "4px",
                        background: "#fafafa",
                    }}
                >
                    <div>
                        <strong>{info.name}</strong>
                    </div>
                    <div>Location: {info.location || "—"}</div>
                    <div>Status: {info.status}</div>
                    <div>
                        Format: {info.type} | Time control: {info.timeControl}
                    </div>

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
                            Viewing round {currentRoundMeta.round} –{" "}
                            {currentRoundMeta.finishedAt ? "finished" : "in progress"}
                        </div>
                    )}
                </div>
            )}

            {/* Tabs */}
            <div style={{ marginBottom: "0.75rem" }}>
                <button
                    onClick={() => setActiveTab("pairings")}
                    disabled={!selectedTournamentId}
                    style={{
                        marginRight: "0.3rem",
                        fontWeight: activeTab === "pairings" ? "bold" : "normal",
                    }}
                >
                    Pairings
                </button>
                <button
                    onClick={() => setActiveTab("standings")}
                    disabled={!selectedTournamentId}
                    style={{
                        marginRight: "0.3rem",
                        fontWeight: activeTab === "standings" ? "bold" : "normal",
                    }}
                >
                    Standings
                </button>
                <button
                    onClick={() => setActiveTab("finished")}
                    disabled={!selectedTournamentId}
                    style={{ fontWeight: activeTab === "finished" ? "bold" : "normal" }}
                >
                    Finished games
                </button>
            </div>

            {status && <div style={{ marginBottom: "0.5rem", fontStyle: "italic" }}>{status}</div>}

            {/* TAB: Pairings */}
            {activeTab === "pairings" && activeRound && (
                <div>
                    <h3>Round {activeRound} – pairings</h3>

                    {matches.length === 0 ? (
                        <div>No matches for this round.</div>
                    ) : (
                        <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", minWidth: "650px" }}>
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
                                        <td title={m.whitePlayer}>
                                            {m.whiteName || m.whitePlayer}
                                            {m.whiteRating != null && (
                                                <span style={{ color: "#777", marginLeft: 4 }}>({m.whiteRating})</span>
                                            )}
                                        </td>
                                        <td title={m.blackPlayer}>
                                            {m.blackName || m.blackPlayer}
                                            {m.blackRating != null && (
                                                <span style={{ color: "#777", marginLeft: 4 }}>({m.blackRating})</span>
                                            )}
                                        </td>
                                        <td>{m.result || "in progress"}</td>
                                        <td>
                                            <button onClick={() => openLive(m.gameId)}>Watch</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* TAB: Standings */}
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
                                {standings.map((s) => (
                                    <tr key={s.playerId}>
                                        <td>{s.rank}</td>
                                        <td title={s.playerId}>
                                            {s.name || s.playerId}
                                            {s.rating != null && (
                                                <span style={{ color: "#777", marginLeft: 4 }}>({s.rating})</span>
                                            )}
                                        </td>
                                        <td>{s.points}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* TAB: Finished games */}
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
                                    const st = archiveStatus?.[m.gameId]; // "loading" | "ok" | "missing" | "error" | undefined

                                    return (
                                        <tr key={m.boardNumber}>
                                            <td>{m.boardNumber}</td>
                                            <td style={{ fontFamily: "monospace" }}>{m.gameId}</td>

                                            <td title={m.whitePlayer}>
                                                {m.whiteName || m.whitePlayer}
                                                {m.whiteRating != null && (
                                                    <span style={{ color: "#777", marginLeft: 4 }}>({m.whiteRating})</span>
                                                )}
                                            </td>

                                            <td title={m.blackPlayer}>
                                                {m.blackName || m.blackPlayer}
                                                {m.blackRating != null && (
                                                    <span style={{ color: "#777", marginLeft: 4 }}>({m.blackRating})</span>
                                                )}
                                            </td>

                                            <td>{m.result}</td>

                                            {/* Archive indicator */}
                                            <td style={{ textAlign: "center" }}>
                                                {st === "ok" && <span title="Archived">✅</span>}
                                                {st === "missing" && <span title="Missing archive">❌</span>}
                                                {st === "loading" && <span title="Checking…">⏳</span>}
                                                {st === "error" && <span title="Archive check error">⚠️</span>}
                                                {!st && <span title="Not checked yet">—</span>}
                                            </td>

                                            {/* Replay */}
                                            <td>
                                                <button
                                                    onClick={() => openReplay(m.gameId)}
                                                    disabled={st !== "ok"}
                                                    title={st !== "ok" ? "Archive missing" : "Replay"}
                                                >
                                                    Replay
                                                </button>
                                            </td>

                                            {/* PGN */}
                                            <td>
                                                <button
                                                    onClick={() => downloadPgn(m.gameId)}
                                                    disabled={st !== "ok"}
                                                    title={st !== "ok" ? "Archive missing" : "Download PGN"}
                                                >
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

            {/* LIVE spectator board panel */}
            {watchedGameId && (
                <div
                    style={{
                        marginTop: "1.5rem",
                        padding: "0.75rem",
                        border: "1px solid #ccc",
                        borderRadius: "4px",
                        background: "#f9f9ff",
                    }}
                >
                    <div style={{ marginBottom: "0.5rem" }}>
                        <strong>Live board:</strong> <code>{watchedGameId}</code>
                        <button
                            style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
                            onClick={() => setWatchedGameId(null)}
                        >
                            ✖ Close
                        </button>
                    </div>

                    <SpectatorBoard gameId={watchedGameId} timeControl={info ? info.timeControl : null} />
                </div>
            )}

            {/* REPLAY board panel */}
            {replayGameId && (
                <div
                    style={{
                        marginTop: "1.5rem",
                        padding: "0.75rem",
                        border: "1px solid #ccc",
                        borderRadius: "4px",
                        background: "#fff9f3",
                    }}
                >
                    <div style={{ marginBottom: "0.5rem" }}>
                        <strong>Replay:</strong> <code>{replayGameId}</code>
                        <button
                            style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
                            onClick={() => setReplayGameId(null)}
                        >
                            ✖ Close
                        </button>
                    </div>

                    <ReplayBoard gameId={replayGameId} />
                </div>
            )}
        </div>
    );
}
