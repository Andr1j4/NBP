import { useState } from "react";

export default function TournamentStandings() {
    const [tournamentId, setTournamentId] = useState("");
    const [standings, setStandings] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function loadStandings() {
        if (!tournamentId) {
            setError("Please enter a tournament ID");
            return;
        }
        setError("");
        setLoading(true);

        try {
            // if you have CRA proxy set up to 8080, `/api/...` is enough
            const res = await fetch(`http://10.121.107.106:8080/api/tournaments/${tournamentId}/standings`);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            setStandings(data.standings || []);
        } catch (e) {
            console.error("Failed to load standings", e);
            setError("Failed to load standings");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div style={{ marginTop: "2rem" }}>
            <h2>Tournament standings</h2>

            <div style={{ marginBottom: "1rem" }}>
                <input
                    type="text"
                    placeholder="Tournament UUID"
                    value={tournamentId}
                    onChange={(e) => setTournamentId(e.target.value)}
                    style={{ width: "400px", marginRight: "0.5rem" }}
                />
                <button onClick={loadStandings}>Load standings</button>
            </div>

            {loading && <div>Loading...</div>}
            {error && <div style={{ color: "red" }}>{error}</div>}

            {standings.length > 0 && (
                <table border="1" cellPadding="6">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Player ID</th>
                            <th>Points</th>
                        </tr>
                    </thead>
                    <tbody>
                        {standings.map((row) => (
                            <tr key={row.playerId}>
                                <td>{row.rank}</td>
                                <td>{row.playerId}</td>
                                <td>{row.points}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {standings.length === 0 && !loading && !error && (
                <div>No standings loaded yet.</div>
            )}
        </div>
    );
}
