// client/src/TournamentAdmin.js
import React, { useState, useEffect } from "react";

export default function TournamentAdmin() {
    const [tournamentId, setTournamentId] = useState("");
    const [lastRound, setLastRound] = useState(null);
    const [pairings, setPairings] = useState(null);
    const [byes, setByes] = useState([]);
    const [standings, setStandings] = useState([]);
    const [status, setStatus] = useState("");

    const [matches, setMatches] = useState([]);
    const [matchesRoundInput, setMatchesRoundInput] = useState(""); // which round to inspect

    const [tournaments, setTournaments] = useState([]);
    const [rounds, setRounds] = useState([]);
    const [selectedRound, setSelectedRound] = useState("");

    // Find the currently selected round metadata
    const selectedRoundObj = rounds.find(
        (r) => String(r.round) === String(selectedRound)
    );

    const isSelectedRoundFinished = !!selectedRoundObj?.finishedAt;




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
            const res = await fetch(
                `http://192.168.0.2:8080/api/tournaments/${tournamentId}/rounds/${round}/complete`,
                { method: "POST" }
            );

            const data = await res.json();

            if (!res.ok) {
                setStatus(`Error: ${data.error || "failed to complete round"}`);
                return;
            }

            if (data.roundCompleted) {
                setStatus(`Round ${round} marked as finished.`);
            } else {
                setStatus(
                    `Round ${round} not completed: ${data.reason || "unknown"}`
                );
            }

            // optional: reload rounds list so dropdown shows updated "(finished)"
            // await loadRoundsForTournament();

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


    useEffect(() => {
        async function loadTournaments() {
            try {
                const res = await fetch("http://192.168.0.2:8080/api/tournaments");
                const data = await res.json();
                setTournaments(data.tournaments || []);
            } catch (e) {
                console.error("Failed to load tournaments", e);
            }
        }
        loadTournaments();
    }, []);

    // 👇 NEW: load rounds when tournamentId changes
    useEffect(() => {
        async function loadRounds() {
            if (!tournamentId) {
                setRounds([]);
                setSelectedRound("");
                return;
            }

            try {
                const res = await fetch(
                    `http://192.168.0.2:8080/api/tournaments/${tournamentId}/rounds`
                );
                const data = await res.json();
                const list = data.rounds || [];

                setRounds(list);

                if (list.length > 0) {
                    const latest = list[list.length - 1].round;
                    setSelectedRound(String(latest));
                    setMatchesRoundInput(String(latest)); // keep your old input in sync if you want
                } else {
                    setSelectedRound("");
                    setMatchesRoundInput("");
                }
            } catch (err) {
                console.error("Failed to load rounds", err);
            }
        }

        loadRounds();
    }, [tournamentId]);





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
                    Round:&nbsp;
                    <select
                        value={selectedRound}
                        onChange={(e) => {
                            const value = e.target.value;
                            setSelectedRound(value);
                            setMatchesRoundInput(value); // keep matches section in sync
                        }}
                        disabled={rounds.length === 0}
                    >
                        <option value="">-- select round --</option>
                        {rounds.map((r) => (
                            <option key={r.round} value={r.round}>
                                Round {r.round}{" "}
                                {r.finishedAt ? "(finished)" : "(ongoing)"}
                            </option>
                        ))}
                    </select>
                </label>
                &nbsp;
                <button
                    onClick={completeRound}
                    disabled={
                        !tournamentId ||
                        !selectedRound ||
                        isSelectedRoundFinished // 🔒 disable if already finished
                    }
                >
                    ✅ Complete round
                </button>
                {selectedRound && (
                    <span style={{ marginLeft: "0.5rem", fontStyle: "italic" }}>
                        {isSelectedRoundFinished ? "Already finished ✅" : "Not finished yet ⏳"}
                    </span>
                )}
            </div>

            <div style={{ marginBottom: "1rem" }}>
                <label>
                    Tournament:&nbsp;
                    <select
                        value={tournamentId}
                        onChange={(e) => setTournamentId(e.target.value)}
                    >
                        <option value="">-- select tournament --</option>
                        {tournaments.map(t => (
                            <option key={t.id} value={t.id}>
                                {t.name} ({t.status}) – {t.id}
                            </option>
                        ))}
                    </select>
                </label>
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
                        <select
                            value={selectedRound}
                            onChange={(e) => {
                                setSelectedRound(e.target.value);
                                setMatchesRoundInput(e.target.value); // optional, to keep old state in sync
                            }}
                        >
                            <option value="">-- select round --</option>
                            {rounds.map(r => (
                                <option key={r.round} value={r.round}>
                                    Round {r.round}{" "}
                                    {r.finishedAt ? "(finished)" : "(ongoing)"}
                                </option>
                            ))}
                        </select>
                    </label>
                    &nbsp;
                    <button
                        onClick={loadMatchesForRound}
                        disabled={!tournamentId || !selectedRound}
                    >
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
