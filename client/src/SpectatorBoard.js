import React, { useEffect, useState } from "react";
import { Chessboard } from "react-chessboard";

export default function SpectatorBoard({ gameId, state, compact = false, boardWidth = 400 }) {
    // state comes from TournamentViewer (viewer ws)
    // state = { fen, moves, clock, resultText, meta }

    const fen = state?.fen || "";
    const moves = Array.isArray(state?.moves) ? state.moves : [];
    const resultText = state?.resultText || "";
    const clock = state?.clock || null;

    const [displayClock, setDisplayClock] = useState({ whiteMs: null, blackMs: null });

    function formatTime(ms) {
        if (ms == null) return "—";
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    // Smooth ticking based on last server snapshot
    useEffect(() => {
        if (!clock || !clock.serverNow || clock.whiteMs == null || clock.blackMs == null) {
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
        return () => rafId && cancelAnimationFrame(rafId);
    }, [clock?.whiteMs, clock?.blackMs, clock?.active, clock?.running, clock?.serverNow]);

    if (!gameId) return <div style={{ padding: "0.5rem", fontStyle: "italic" }}>No game selected.</div>;

    const uiBoardWidth = compact ? boardWidth : 400;

    return (
        <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
            <div>
                {/* clocks */}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem", fontFamily: "monospace", fontSize: "0.9rem" }}>
                    <div>
                        ♟ White{" "}
                        <span style={{ fontWeight: clock?.active === "w" && clock?.running ? "bold" : "normal" }}>
                            {formatTime(displayClock.whiteMs)}
                        </span>
                    </div>
                    <div>
                        ♟ Black{" "}
                        <span style={{ fontWeight: clock?.active === "b" && clock?.running ? "bold" : "normal" }}>
                            {formatTime(displayClock.blackMs)}
                        </span>
                    </div>
                </div>

                <Chessboard
                    boardWidth={uiBoardWidth}
                    position={fen || undefined}
                    arePiecesDraggable={false}
                    customBoardStyle={{ borderRadius: "4px", boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)" }}
                />

                {resultText && (
                    <div style={{ marginTop: "0.5rem", padding: "0.25rem 0.5rem", background: "#eee", borderRadius: "4px", fontSize: "0.9rem" }}>
                        <strong>Result:</strong> {resultText}
                    </div>
                )}
            </div>

            {/* moves */}
            {!compact && (
                <div style={{ minWidth: "180px", maxHeight: "400px", overflowY: "auto", border: "1px solid #ccc", borderRadius: "4px", padding: "0.25rem" }}>
                    <div style={{ fontSize: "0.9rem", marginBottom: "0.25rem", fontWeight: "bold" }}>Moves</div>

                    {moves.length === 0 ? (
                        <div style={{ fontStyle: "italic", fontSize: "0.85rem" }}>No moves yet.</div>
                    ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                            <thead>
                                <tr>
                                    <th style={{ textAlign: "left", width: "2.5rem" }}>#</th>
                                    <th style={{ textAlign: "left" }}>White</th>
                                    <th style={{ textAlign: "left" }}>Black</th>
                                </tr>
                            </thead>
                            <tbody>
                                {moves.map((m, idx) => (
                                    <tr key={m.moveNumber + "-" + idx} style={idx === moves.length - 1 ? { background: "#f0f8ff" } : {}}>
                                        <td>{m.moveNumber}.</td>
                                        <td>{m.white}</td>
                                        <td>{m.black}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
