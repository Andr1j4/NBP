import React, { useEffect, useMemo, useState } from "react";

const API_BASE = "http://10.121.107.106:8080";

const ADMIN_TOKEN_KEY = "turnir_admin_authToken";
const ADMIN_ME_KEY = "turnir_admin_me";

// Your 4 players (default bootstrap)
const DEFAULT_PLAYERS = [
    "0e087985-98a7-48dd-b3db-7d7f9da87520",
    "1f6fa85d-9c47-4d7f-b33f-81f172a8c82a",
    "c1bb8a8d-06f5-42bd-af1a-0b619bce08c4",
    "f8017097-2cf4-4817-bef4-1b109e8ef880",
];

function getToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setToken(token) {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function setMe(user) {
    if (user) localStorage.setItem(ADMIN_ME_KEY, JSON.stringify(user));
    else localStorage.removeItem(ADMIN_ME_KEY);
}

function getMe() {
    try {
        return JSON.parse(localStorage.getItem(ADMIN_ME_KEY) || "null");
    } catch {
        return null;
    }
}

// Accept both snake_case and camelCase from backend
function normalizeMatch(m) {
    const gameId = m.gameId ?? m.game_id ?? null;
    return {
        ...m,
        gameId,
        boardNumber: m.boardNumber ?? m.board_number ?? null,
        whitePlayer: m.whitePlayer ?? m.white_player ?? null,
        blackPlayer: m.blackPlayer ?? m.black_player ?? null,
        result: m.result ?? "",
    };
}

/**
 * Auth-aware fetch:
 * - Adds Authorization header if token exists
 * - Parses json safely
 */
async function authFetch(url, options = {}) {
    const token = getToken();
    const headers = {
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const res = await fetch(url, { ...options, headers });

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    return { res, data };
}

export default function TournamentAdmin() {
    const [status, setStatus] = useState("");

    // ---- auth UI ----
    const [me, setMeState] = useState(() => getMe());
    const [loginForm, setLoginForm] = useState({ email: "", password: "" });
    const isLoggedIn = !!getToken();

    // tournament selection + lists
    const [tournaments, setTournaments] = useState([]);
    const [tournamentId, setTournamentId] = useState("");

    // rounds
    const [rounds, setRounds] = useState([]);
    const [selectedRound, setSelectedRound] = useState("");

    // standings
    const [standings, setStandings] = useState([]);

    // matches for round
    const [matches, setMatches] = useState([]);

    // playLinks[gameId] = { w: url, b: url }
    const [playLinks, setPlayLinks] = useState({});

    // tournament create form
    const [createForm, setCreateForm] = useState({
        name: `Test Tournament ${new Date().toISOString().slice(0, 10)}`,
        location: "Belgrade",
        type: "round_robin",
        timeControl: "5+0",
    });

    // players to register (editable)
    const [playersText, setPlayersText] = useState(DEFAULT_PLAYERS.join("\n"));

    const playersList = useMemo(() => {
        return playersText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
    }, [playersText]);

    const selectedRoundObj = useMemo(
        () => rounds.find((r) => String(r.round) === String(selectedRound)),
        [rounds, selectedRound]
    );
    const isSelectedRoundFinished = !!selectedRoundObj?.finishedAt;

    // ----------------------------
    // AUTH
    // ----------------------------
    async function login() {
        setStatus("Logging in...");
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: loginForm.email,
                    password: loginForm.password,
                }),
            });

            if (!res.ok) {
                setStatus(`Login failed: ${data?.error || "login_failed"}`);
                return;
            }

            setToken(data.token);
            setMe(data.user);
            setMeState(data.user);

            setStatus(`Logged in as ${data.user?.email || "user"}`);
        } catch (e) {
            console.error(e);
            setStatus("Login failed (network/console).");
        }
    }

    async function logout() {
        setToken("");
        setMe(null);
        setMeState(null);
        setStatus("Logged out.");
    }

    async function loadMe() {
        if (!getToken()) return;
        const { res, data } = await authFetch(`${API_BASE}/api/auth/me`);
        if (res.ok && data?.user) {
            setMe(data.user);
            setMeState(data.user);
        }
    }

    useEffect(() => {
        loadMe();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ----------------------------
    // Load tournaments
    // ----------------------------
    async function loadTournaments() {
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments`);
            if (!res.ok) {
                setStatus(`Error loading tournaments: ${data?.error || "failed"}`);
                return;
            }
            setTournaments(data?.tournaments || []);
        } catch (e) {
            console.error("Failed to load tournaments", e);
            setStatus("Error loading tournaments (see console).");
        }
    }

    useEffect(() => {
        loadTournaments();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ----------------------------
    // Load rounds when tournament changes
    // ----------------------------
    async function loadRoundsForTournament(tid) {
        if (!tid) {
            setRounds([]);
            setSelectedRound("");
            return;
        }
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tid}/rounds`);
            if (!res.ok) {
                setStatus(`Error loading rounds: ${data?.error || "failed"}`);
                return;
            }
            const list = data?.rounds || [];
            setRounds(list);

            if (list.length > 0) {
                const latest = list[list.length - 1].round;
                setSelectedRound(String(latest));
            } else {
                setSelectedRound("");
            }
        } catch (e) {
            console.error("Failed to load rounds", e);
        }
    }

    useEffect(() => {
        // reset view state on tournament change
        setStandings([]);
        setMatches([]);
        setPlayLinks({});
        if (tournamentId) loadRoundsForTournament(tournamentId);
        else loadRoundsForTournament("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tournamentId]);

    // ----------------------------
    // Create tournament
    // ----------------------------
    async function createTournament() {
        setStatus("Creating tournament...");
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: createForm.name,
                    location: createForm.location,
                    type: createForm.type,
                    timeControl: createForm.timeControl,
                }),
            });

            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to create tournament"}`);
                return;
            }

            const tid = data?.tournamentId || data?.id;
            setStatus(`Tournament created: ${tid}`);
            await loadTournaments();

            if (tid) {
                setTournamentId(tid);
                await loadRoundsForTournament(tid);
            }
        } catch (e) {
            console.error(e);
            setStatus("Error: could not create tournament (check console).");
        }
    }

    // ----------------------------
    // Register players to tournament
    // ----------------------------
    async function registerPlayers() {
        if (!tournamentId) {
            setStatus("Pick a tournament first.");
            return;
        }
        if (playersList.length === 0) {
            setStatus("No players entered.");
            return;
        }

        setStatus(`Registering ${playersList.length} players...`);

        const results = [];
        for (const pid of playersList) {
            try {
                const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tournamentId}/register`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ player_id: pid }),
                });

                if (!res.ok) results.push(`❌ ${pid}: ${data?.error || "register_failed"}`);
                else results.push(`✅ ${pid}`);
            } catch {
                results.push(`❌ ${pid}: network_error`);
            }
        }

        setStatus(`Register done:\n${results.join("\n")}`);
    }

    async function copy(text) {
        await navigator.clipboard.writeText(text);
        setStatus("Copied link to clipboard ✅");
    }

    // ----------------------------
    // Start next round
    // ----------------------------
    async function startRound() {
        if (!tournamentId) return;
        setStatus("Starting round...");
        setMatches([]);
        setPlayLinks({});

        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tournamentId}/start`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });

            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to start round"}`);
                return;
            }

            setStatus(`Round ${data.round} started.`);
            await loadRoundsForTournament(tournamentId);
            setSelectedRound(String(data.round));

            await loadMatchesForRound(String(data.round), { autoGeneratePlayLinks: true });
        } catch (err) {
            console.error(err);
            setStatus("Error: could not start round (check console).");
        }
    }

    // ----------------------------
    // Complete round (manual override)
    // ----------------------------
    async function completeRound() {
        const round = parseInt(selectedRound, 10);
        if (!round) {
            setStatus("Please select a round to complete.");
            return;
        }
        if (isSelectedRoundFinished) {
            setStatus(`Round ${round} is already marked as finished.`);
            return;
        }

        setStatus(`Completing round ${round}...`);
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tournamentId}/rounds/${round}/complete`, {
                method: "POST",
            });

            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to complete round"}`);
                return;
            }

            if (data.roundCompleted) setStatus(`Round ${round} marked as finished.`);
            else setStatus(`Round ${round} not completed: ${data.reason || "unknown"}`);

            await loadRoundsForTournament(tournamentId);
        } catch (err) {
            console.error(err);
            setStatus("Error: could not complete round (check console).");
        }
    }

    // ----------------------------
    // Load standings
    // ----------------------------
    async function loadStandings() {
        if (!tournamentId) return;
        setStatus("Loading standings...");
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tournamentId}/standings`);
            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to load standings"}`);
                return;
            }

            setStandings(data?.standings || []);
            setStatus(`Loaded standings for tournament ${tournamentId}.`);
        } catch (err) {
            console.error(err);
            setStatus("Error: could not load standings (check console).");
        }
    }

    // ----------------------------
    // Load matches for selected round
    // ----------------------------
    async function loadMatchesForRound(roundStr = selectedRound, opts = {}) {
        const round = parseInt(roundStr, 10);
        if (!round) {
            setStatus("Please select a valid round to load matches.");
            return;
        }

        setStatus(`Loading matches for round ${round}...`);
        setMatches([]);
        setPlayLinks({});

        try {
            const { res, data } = await authFetch(`${API_BASE}/api/tournaments/${tournamentId}/rounds/${round}/matches`);
            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to load matches"}`);
                return;
            }

            const list = (data?.matches || []).map(normalizeMatch);
            setMatches(list);
            setStatus(`Loaded ${list.length} matches for round ${round}.`);

            if (opts.autoGeneratePlayLinks) {
                await generatePlayLinksForAllMatches(list);
            }
        } catch (err) {
            console.error(err);
            setStatus("Error: could not load matches (check console).");
        }
    }

    // ----------------------------
    // Resolve a draw (admin override)
    // ----------------------------
    async function resolveDraw(boardNumber, winner) {
        const round = parseInt(selectedRound, 10);
        if (!round) {
            setStatus("Round number invalid.");
            return;
        }

        setStatus(`Resolving draw: round ${round}, board ${boardNumber} => ${winner} wins...`);
        try {
            const { res, data } = await authFetch(
                `${API_BASE}/api/tournaments/${tournamentId}/rounds/${round}/boards/${boardNumber}/resolve-draw`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ winner }), // "white" | "black"
                }
            );

            if (!res.ok) {
                setStatus(`Error: ${data?.error || "failed to resolve draw"}`);
                return;
            }

            setStatus(`Draw resolved on board ${boardNumber}: ${data.oldResult} -> ${data.newResult}.`);
            await loadMatchesForRound(selectedRound, { autoGeneratePlayLinks: false });
        } catch (err) {
            console.error(err);
            setStatus("Error: could not resolve draw (check console).");
        }
    }

    // ----------------------------
    // Generate playlink for a game + player_id
    // ----------------------------
    async function generatePlayLink(gameId, player_id) {
        try {
            const { res, data } = await authFetch(`${API_BASE}/api/games/${gameId}/playlink`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ player_id }),
            });
            if (!res.ok) throw new Error(data?.error || "playlink_failed");
            return data.playUrl;
        } catch (e) {
            console.warn("playlink failed", { gameId, player_id, e });
            return null;
        }
    }

    async function generatePlayLinksForMatch(m) {
        const gameId = m.gameId;
        const white = m.whitePlayer;
        const black = m.blackPlayer;

        if (!gameId || !white || !black) {
            setStatus("Cannot generate playlinks: missing gameId/white/black in match object.");
            return;
        }

        setStatus(`Generating playlinks for ${gameId}...`);

        const [wUrl, bUrl] = await Promise.all([generatePlayLink(gameId, white), generatePlayLink(gameId, black)]);

        setPlayLinks((prev) => ({
            ...prev,
            [gameId]: { w: wUrl, b: bUrl },
        }));

        setStatus(`Playlinks generated for ${gameId}.`);
    }

    async function generatePlayLinksForAllMatches(list = matches) {
        if (!Array.isArray(list) || list.length === 0) return;

        setStatus(`Generating playlinks for ${list.length} match(es)...`);

        const next = {};
        for (const m of list) {
            const gameId = m.gameId;
            const white = m.whitePlayer;
            const black = m.blackPlayer;
            if (!gameId || !white || !black) continue;

            const [wUrl, bUrl] = await Promise.all([generatePlayLink(gameId, white), generatePlayLink(gameId, black)]);
            next[gameId] = { w: wUrl, b: bUrl };
        }

        setPlayLinks(next);
        setStatus(`Playlinks generated for ${Object.keys(next).length} game(s).`);
    }

    // ----------------------------
    // UI helpers
    // ----------------------------
    const canAdmin = true;

    return (
        <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
            <h2>🏁 Tournament Admin</h2>

            {/* AUTH */}
            <div style={{ padding: "0.75rem", border: "1px solid #ddd", borderRadius: 6, marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Auth</h3>

                {isLoggedIn ? (
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <div>
                            Logged in as: <b>{me?.email || "?"}</b>{" "}
                            {me?.player_id ? <span style={{ color: "#666" }}>(player_id: {me.player_id})</span> : null}
                        </div>
                        <button onClick={logout}>Logout</button>
                    </div>
                ) : (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                            placeholder="email"
                            value={loginForm.email}
                            onChange={(e) => setLoginForm((p) => ({ ...p, email: e.target.value }))}
                            style={{ width: 260 }}
                        />
                        <input
                            placeholder="password"
                            type="password"
                            value={loginForm.password}
                            onChange={(e) => setLoginForm((p) => ({ ...p, password: e.target.value }))}
                            style={{ width: 220 }}
                        />
                        <button onClick={login}>Login</button>
                    </div>
                )}
            </div>

            {/* Create tournament */}
            <div style={{ padding: "0.75rem", border: "1px solid #ddd", borderRadius: 6, marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Create tournament</h3>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <label>
                        Name:&nbsp;
                        <input style={{ width: 260 }} value={createForm.name} onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))} />
                    </label>

                    <label>
                        Location:&nbsp;
                        <input
                            style={{ width: 160 }}
                            value={createForm.location}
                            onChange={(e) => setCreateForm((p) => ({ ...p, location: e.target.value }))}
                        />
                    </label>

                    <label>
                        Type:&nbsp;
                        <select value={createForm.type} onChange={(e) => setCreateForm((p) => ({ ...p, type: e.target.value }))}>
                            <option value="round_robin">round_robin</option>
                            <option value="swiss">swiss</option>
                            <option value="single_elim">single_elim</option>
                        </select>
                    </label>

                    <label>
                        Time:&nbsp;
                        <input
                            style={{ width: 80 }}
                            value={createForm.timeControl}
                            onChange={(e) => setCreateForm((p) => ({ ...p, timeControl: e.target.value }))}
                            placeholder="5+0"
                        />
                    </label>

                    <button onClick={createTournament} disabled={!canAdmin}>
                        ➕ Create
                    </button>
                </div>
            </div>

            {/* Select tournament */}
            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Tournament:&nbsp;
                    <select value={tournamentId} onChange={(e) => setTournamentId(e.target.value)}>
                        <option value="">-- select tournament --</option>
                        {tournaments.map((t) => (
                            <option key={t.id || t.tournamentId} value={t.id || t.tournamentId}>
                                {t.name} ({t.status}) – {t.id || t.tournamentId}
                            </option>
                        ))}
                    </select>
                </label>
                &nbsp;
                <button onClick={loadTournaments}>🔄 refresh</button>
            </div>

            {/* Register players */}
            <div style={{ padding: "0.75rem", border: "1px solid #ddd", borderRadius: 6, marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Register players</h3>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <textarea style={{ width: 520, height: 110, fontFamily: "monospace" }} value={playersText} onChange={(e) => setPlayersText(e.target.value)} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button onClick={registerPlayers} disabled={!tournamentId || !canAdmin}>
                            🧾 Register listed players
                        </button>
                    </div>
                </div>
            </div>

            {/* Round controls */}
            <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
                <button onClick={startRound} disabled={!tournamentId || !canAdmin}>
                    ▶️ Start next round
                </button>

                <button onClick={loadStandings} disabled={!tournamentId}>
                    📊 Load standings
                </button>
            </div>

            {/* Rounds dropdown + complete + load matches */}
            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Round:&nbsp;
                    <select value={selectedRound} onChange={(e) => setSelectedRound(String(e.target.value))} disabled={!tournamentId}>
                        <option value="">-- select round --</option>
                        {rounds.map((r) => (
                            <option key={r.round} value={r.round}>
                                Round {r.round} {r.finishedAt ? "(finished)" : "(ongoing)"}
                            </option>
                        ))}
                    </select>
                </label>
                &nbsp;
                <button onClick={() => loadMatchesForRound(selectedRound, { autoGeneratePlayLinks: true })} disabled={!tournamentId || !selectedRound}>
                    🔎 Load matches (+playlinks)
                </button>
                &nbsp;
                <button onClick={completeRound} disabled={!tournamentId || !selectedRound || isSelectedRoundFinished || !canAdmin}>
                    ✅ Complete round
                </button>

                {matches.length > 0 ? (
                    <>
                        &nbsp;
                        <button onClick={() => generatePlayLinksForAllMatches(matches)} disabled={!canAdmin}>
                            🔐 Generate playlinks for all
                        </button>
                    </>
                ) : null}

                {selectedRound && (
                    <span style={{ marginLeft: "0.5rem", fontStyle: "italic" }}>
                        {isSelectedRoundFinished ? "Already finished ✅" : "Not finished yet ⏳"}
                    </span>
                )}
            </div>

            {/* Status */}
            {status && (
                <pre style={{ margin: "0.5rem 0", padding: 10, background: "#f7f7f7", borderRadius: 6, whiteSpace: "pre-wrap" }}>{status}</pre>
            )}

            {/* Standings */}
            {standings && standings.length > 0 && (
                <div style={{ marginTop: "1.5rem" }}>
                    <h3>Standings</h3>
                    <table border="1" cellPadding="4" style={{ borderCollapse: "collapse" }}>
                        <thead>
                            <tr>
                                <th>Rank</th>
                                <th>Player ID</th>
                                <th>Points</th>
                            </tr>
                        </thead>
                        <tbody>
                            {standings.map((s) => {
                                const pid = s.player_id || s.playerId;
                                return (
                                    <tr key={pid}>
                                        <td>{s.rank}</td>
                                        <td style={{ fontFamily: "monospace" }}>{pid}</td>
                                        <td>{s.points}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Matches + draw resolution + playlinks */}
            <div style={{ marginTop: "1.5rem", padding: "0.75rem", border: "1px solid #ccc", borderRadius: "4px" }}>
                <h3 style={{ marginTop: 0 }}>Round matches / resolve draws / play links</h3>

                {matches.length === 0 ? (
                    <div style={{ color: "#666" }}>Load matches for a round to see them here.</div>
                ) : (
                    <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                            <tr>
                                <th>Board</th>
                                <th>Game ID</th>
                                <th>White</th>
                                <th>Black</th>
                                <th>Result</th>
                                <th>Resolve Draw</th>
                                <th>PlayLinks</th>
                            </tr>
                        </thead>
                        <tbody>
                            {matches.map((raw) => {
                                const m = normalizeMatch(raw);
                                const board = m.boardNumber;
                                const gameId = m.gameId;
                                const white = m.whitePlayer;
                                const black = m.blackPlayer;

                                const links = gameId ? playLinks[gameId] : null;

                                return (
                                    <tr key={`${board}-${gameId}`}>
                                        <td>{board}</td>
                                        <td style={{ fontFamily: "monospace" }}>{gameId}</td>
                                        <td style={{ fontFamily: "monospace" }}>{white}</td>
                                        <td style={{ fontFamily: "monospace" }}>{black}</td>
                                        <td>{m.result || "-"}</td>

                                        <td>
                                            {m.result === "1/2-1/2" ? (
                                                <>
                                                    <button onClick={() => resolveDraw(board, "white")} style={{ marginRight: "0.25rem" }}>
                                                        White wins
                                                    </button>
                                                    <button onClick={() => resolveDraw(board, "black")}>Black wins</button>
                                                </>
                                            ) : (
                                                <span style={{ color: "#888" }}>—</span>
                                            )}
                                        </td>

                                        <td>
                                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                                <button onClick={() => generatePlayLinksForMatch(m)} disabled={!canAdmin}>
                                                    🔐 Generate (W/B)
                                                </button>

                                                <div style={{ fontSize: 12 }}>
                                                    <div>
                                                        W:&nbsp;
                                                        {links?.w ? (
                                                            <>
                                                                <a href={links.w} target="_blank" rel="noreferrer">
                                                                    open
                                                                </a>
                                                                <button onClick={() => copy(links.w)} style={{ marginLeft: 6 }}>
                                                                    copy
                                                                </button>
                                                            </>
                                                        ) : (
                                                            "—"
                                                        )}
                                                    </div>
                                                    <div>
                                                        B:&nbsp;
                                                        {links?.b ? (
                                                            <>
                                                                {/* ✅ FIX: black must open links.b */}
                                                                <a href={links.b} target="_blank" rel="noreferrer">
                                                                    open
                                                                </a>
                                                                <button onClick={() => copy(links.b)} style={{ marginLeft: 6 }}>
                                                                    copy
                                                                </button>
                                                            </>
                                                        ) : (
                                                            "—"
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
