// client/src/TournamentAdmin.js
import React, { useState } from "react";

export default function TournamentAdmin() {
    const [tournamentId, setTournamentId] = useState("");
    const [lastRound, setLastRound] = useState(null);
    const [pairings, setPairings] = useState(null);
    const [byes, setByes] = useState([]);
    const [standings, setStandings] = useState([]);
    const [roundToComplete, setRoundToComplete] = useState("");
    const [status, setStatus] = useState("");

    const [matches, setMatches] = useState([]);
    const [matchesRoundInput, setMatchesRoundInput] = useState(""); // which round to inspect


    async function startRound() {
        setStatus("Starting round...");
        setPairings(null);
        setByes([]);

        try {
            const res = await fetch(`http://192.168.0.2:8080/api/tournaments/${tournamentId}/start`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // You can optionally send { round: X } here, but we let backend auto-pick
                body: JSON.stringify({})
            });

            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to start round"}`);
                return;
            }

            setLastRound(data.round);
            setPairings(data.pairings || []);
            setByes(data.byes || []);
            setStatus(`Round ${data.round} started.`);
        } catch (err) {
            console.error(err);
            setStatus("Error: could not start round (check console).");
        }
    }

    async function completeRound() {
        if (!roundToComplete) {
            setStatus("Please enter round number to complete.");
            return;
        }

        setStatus("Completing round...");

        try {
            const res = await fetch(
                `http://192.168.0.2:8080/api/tournaments/${tournamentId}/rounds/${roundToComplete}/complete`,
                { method: "POST" }
            );

            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to complete round"}`);
                return;
            }

            if (data.roundCompleted) {
                setStatus(`Round ${roundToComplete} marked as finished.`);
            } else {
                setStatus(`Round ${roundToComplete} not completed: ${data.reason || "unknown"}`);
            }
        } catch (err) {
            console.error(err);
            setStatus("Error: could not complete round (check console).");
        }
    }

    async function loadStandings() {
        setStatus("Loading standings...");
        try {
            const res = await fetch(`http://192.168.0.2:8080/api/tournaments/${tournamentId}/standings`);
            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to load standings"}`);
                return;
            }

            setStandings(data.standings || []);
            setStatus(`Loaded standings for tournament ${data.tournamentId}.`);
        } catch (err) {
            console.error(err);
            setStatus("Error: could not load standings (check console).");
        }
    }

    async function loadMatchesForRound() {
        const round = parseInt(matchesRoundInput || lastRound, 10);

        if (!round) {
            setStatus("Please enter a valid round to load matches.");
            return;
        }

        setStatus(`Loading matches for round ${round}...`);
        setMatches([]);

        try {
            const res = await fetch(
                `http://192.168.0.2:8080/api/tournaments/${tournamentId}/rounds/${round}/matches`
            );
            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to load matches"}`);
                return;
            }

            setMatches(data.matches || []);
            setStatus(`Loaded ${data.matches.length} matches for round ${data.round}.`);
        } catch (err) {
            console.error(err);
            setStatus("Error: could not load matches (check console).");
        }
    }

    async function resolveDraw(boardNumber, winner) {
        const round = parseInt(matchesRoundInput || lastRound, 10);

        if (!round) {
            setStatus("Round number invalid.");
            return;
        }

        setStatus(`Resolving draw on round ${round}, board ${boardNumber} as ${winner} wins...`);

        try {
            const res = await fetch(
                `http://192.168.0.2:8080/api/tournaments/${tournamentId}/rounds/${round}/boards/${boardNumber}/resolve-draw`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ winner }), // "white" | "black"
                }
            );
            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to resolve draw"}`);
                return;
            }

            setStatus(
                `Draw resolved on board ${boardNumber}: ${data.oldResult} -> ${data.newResult}.`
            );

            // reload matches so table shows updated result
            await loadMatchesForRound();
        } catch (err) {
            console.error(err);
            setStatus("Error: could not resolve draw (check console).");
        }
    }



    return (
        <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
            <h2>🏁 Tournament Admin</h2>

            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Tournament ID:&nbsp;
                    <input
                        style={{ width: "420px" }}
                        value={tournamentId}
                        onChange={(e) => setTournamentId(e.target.value.trim())}
                        placeholder="5899-... your UUID here"
                    />
                </label>
            </div>

            <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
                <button onClick={startRound} disabled={!tournamentId}>
                    ▶️ Start next round
                </button>

                <button onClick={loadStandings} disabled={!tournamentId}>
                    📊 Load standings
                </button>
            </div>

            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Round to complete:&nbsp;
                    <input
                        type="number"
                        min="1"
                        style={{ width: "60px" }}
                        value={roundToComplete}
                        onChange={(e) => setRoundToComplete(e.target.value)}
                    />
                </label>
                &nbsp;
                <button onClick={completeRound} disabled={!tournamentId}>
                    ✅ Complete round
                </button>
            </div>

            {status && (
                <div style={{ margin: "0.5rem 0", fontStyle: "italic" }}>
                    {status}
                </div>
            )}

            {lastRound && pairings && pairings.length > 0 && (
                <div style={{ marginTop: "1.5rem" }}>
                    <h3>Round {lastRound} pairings</h3>
                    <table
                        border="1"
                        cellPadding="4"
                        style={{ borderCollapse: "collapse" }}
                    >
                        <thead>
                            <tr>
                                <th>Board</th>
                                <th>White (player_id)</th>
                                <th>Black (player_id)</th>
                                <th>White URL</th>
                                <th>Black URL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pairings.map((p) => (
                                <tr key={p.board}>
                                    <td>{p.board}</td>
                                    <td>{p.white}</td>
                                    <td>{p.black}</td>
                                    <td>
                                        <a
                                            href={p.urls.white}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {p.urls.white}
                                        </a>
                                    </td>
                                    <td>
                                        <a
                                            href={p.urls.black}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {p.urls.black}
                                        </a>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {byes.length > 0 && (
                        <div style={{ marginTop: "0.5rem" }}>
                            <strong>Byes this round:</strong> {byes.join(", ")}
                        </div>
                    )}
                </div>
            )}

            {standings && standings.length > 0 && (
                <div style={{ marginTop: "1.5rem" }}>
                    <h3>Standings</h3>
                    <table
                        border="1"
                        cellPadding="4"
                        style={{ borderCollapse: "collapse" }}
                    >
                        <thead>
                            <tr>
                                <th>Rank</th>
                                <th>Player ID</th>
                                <th>Points</th>
                            </tr>
                        </thead>
                        <tbody>
                            {standings.map((s) => (
                                <tr key={s.playerId}>
                                    <td>{s.rank}</td>
                                    <td>{s.playerId}</td>
                                    <td>{s.points}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 👇 NEW: round matches & draw resolution block */}
            <div
                style={{
                    marginTop: "1.5rem",
                    padding: "0.75rem",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                }}
            >
                <h3>Round matches / resolve draws</h3>

                <div style={{ marginBottom: "0.5rem" }}>
                    <label>
                        Round:&nbsp;
                        <input
                            type="number"
                            value={matchesRoundInput}
                            onChange={(e) => setMatchesRoundInput(e.target.value)}
                            placeholder={lastRound ? `default: ${lastRound}` : ""}
                            style={{ width: "60px" }}
                        />
                    </label>
                    &nbsp;
                    <button onClick={loadMatchesForRound} disabled={!tournamentId}>
                        🔎 Load matches
                    </button>
                </div>

                {matches.length > 0 && (
                    <table
                        border="1"
                        cellPadding="4"
                        style={{ borderCollapse: "collapse" }}
                    >
                        <thead>
                            <tr>
                                <th>Board</th>
                                <th>Game ID</th>
                                <th>White</th>
                                <th>Black</th>
                                <th>Result</th>
                                <th>Resolve Draw</th>
                            </tr>
                        </thead>
                        <tbody>
                            {matches.map((m) => (
                                <tr key={m.boardNumber}>
                                    <td>{m.boardNumber}</td>
                                    <td style={{ fontFamily: "monospace" }}>
                                        {m.gameId}
                                    </td>
                                    <td>{m.whitePlayer}</td>
                                    <td>{m.blackPlayer}</td>
                                    <td>{m.result || "-"}</td>
                                    <td>
                                        {m.result === "1/2-1/2" ? (
                                            <>
                                                <button
                                                    onClick={() =>
                                                        resolveDraw(
                                                            m.boardNumber,
                                                            "white"
                                                        )
                                                    }
                                                    style={{ marginRight: "0.25rem" }}
                                                >
                                                    White wins
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        resolveDraw(
                                                            m.boardNumber,
                                                            "black"
                                                        )
                                                    }
                                                >
                                                    Black wins
                                                </button>
                                            </>
                                        ) : (
                                            <span style={{ color: "#888" }}>—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );

}
