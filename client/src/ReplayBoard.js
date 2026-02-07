import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

export default function ReplayBoard({ gameId }) {
    const API_BASE = "http://10.121.107.106:8080";

    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState("");

    const [sanMoves, setSanMoves] = useState([]);
    const [result, setResult] = useState("");
    const [reason, setReason] = useState("");

    const [ply, setPly] = useState(0); // 0..sanMoves.length
    const [playing, setPlaying] = useState(false);
    const [speedMs, setSpeedMs] = useState(800); // playback speed

    const timerRef = useRef(null);

    // Build positions for each ply: positions[0] = start, positions[i] = after i SAN moves
    const positions = useMemo(() => {
        const g = new Chess();
        const pos = [g.fen()];

        for (const san of sanMoves) {
            try {
                const mv = g.move(san, { sloppy: true });
                if (!mv) break;
                pos.push(g.fen());
            } catch {
                break;
            }
        }
        return pos;
    }, [sanMoves]);

    const currentFen = positions[Math.min(ply, positions.length - 1)] || new Chess().fen();

    // load archive
    useEffect(() => {
        if (!gameId) return;

        let cancelled = false;

        async function load() {
            setLoading(true);
            setErr("");
            setPlaying(false);
            setPly(0);

            try {
                const res = await fetch(`${API_BASE}/api/games/${gameId}/archive`);
                const data = await res.json();

                if (!res.ok) {
                    throw new Error(data.error || "failed_to_load_archive");
                }

                if (cancelled) return;

                setSanMoves(data.sanMoves || []);
                setResult(data.result || "");
                setReason(data.reason || "");
            } catch (e) {
                if (!cancelled) setErr(String(e.message || e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, [gameId]);

    // playback loop
    useEffect(() => {
        if (!playing) {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            return;
        }

        if (timerRef.current) clearInterval(timerRef.current);

        timerRef.current = setInterval(() => {
            setPly((p) => {
                const next = p + 1;
                if (next >= sanMoves.length) {
                    // stop at the end
                    setPlaying(false);
                    return sanMoves.length;
                }
                return next;
            });
        }, speedMs);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
        };
    }, [playing, speedMs, sanMoves.length]);

    function prettyResult() {
        if (!result) return "";
        let txt = result;
        if (result === "1-0") txt = "1–0 (white wins)";
        else if (result === "0-1") txt = "0–1 (black wins)";
        else if (result === "1/2-1/2") txt = "½–½ (draw)";
        if (reason) txt += ` – ${reason}`;
        return txt;
    }

    const maxPly = sanMoves.length;

    const moveText = (() => {
        // show move number + SAN around current ply
        if (ply === 0) return "Start position";
        const san = sanMoves[ply - 1];
        const moveNo = Math.ceil(ply / 2);
        const isWhite = ply % 2 === 1;
        return `${moveNo}${isWhite ? "." : "..."} ${san}`;
    })();

    if (!gameId) return <div style={{ fontStyle: "italic" }}>No game selected.</div>;

    return (
        <div
            style={{
                display: "flex",
                gap: "1rem",
                padding: "0.75rem",
                border: "1px solid #ccc",
                borderRadius: 6,
                background: "#fafafa",
                alignItems: "flex-start",
            }}
        >
            <div>
                <div style={{ marginBottom: 6, fontFamily: "monospace" }}>
                    Replay game: {gameId}
                </div>

                <Chessboard
                    boardWidth={420}
                    position={currentFen}
                    arePiecesDraggable={false}
                />

                <div style={{ marginTop: 8, fontSize: 14 }}>
                    <strong>At:</strong> {moveText}
                </div>

                {result && (
                    <div style={{ marginTop: 6, fontSize: 14 }}>
                        <strong>Result:</strong> {prettyResult()}
                    </div>
                )}

                {loading && <div style={{ marginTop: 8, fontStyle: "italic" }}>Loading archive…</div>}
                {err && <div style={{ marginTop: 8, color: "crimson" }}>{err}</div>}
            </div>

            <div style={{ minWidth: 320 }}>
                <div style={{ marginBottom: 8, fontWeight: "bold" }}>Timeline</div>

                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => { setPlaying(false); setPly(0); }} disabled={loading || maxPly === 0}>
                        ⏮ Start
                    </button>
                    <button onClick={() => { setPlaying(false); setPly((p) => Math.max(0, p - 1)); }} disabled={loading || maxPly === 0}>
                        ◀ Step
                    </button>
                    <button onClick={() => setPlaying((v) => !v)} disabled={loading || maxPly === 0}>
                        {playing ? "⏸ Pause" : "▶ Play"}
                    </button>
                    <button onClick={() => { setPlaying(false); setPly((p) => Math.min(maxPly, p + 1)); }} disabled={loading || maxPly === 0}>
                        Step ▶
                    </button>
                    <button onClick={() => { setPlaying(false); setPly(maxPly); }} disabled={loading || maxPly === 0}>
                        End ⏭
                    </button>
                </div>

                <div style={{ marginBottom: 10 }}>
                    <input
                        type="range"
                        min="0"
                        max={maxPly}
                        value={Math.min(ply, maxPly)}
                        onChange={(e) => {
                            setPlaying(false);
                            setPly(parseInt(e.target.value, 10));
                        }}
                        style={{ width: "100%" }}
                        disabled={loading || maxPly === 0}
                    />
                    <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 4 }}>
                        ply {ply} / {maxPly}
                    </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 13 }}>
                        Speed:&nbsp;
                        <select
                            value={speedMs}
                            onChange={(e) => setSpeedMs(parseInt(e.target.value, 10))}
                            disabled={loading}
                        >
                            <option value={1500}>Slow</option>
                            <option value={800}>Normal</option>
                            <option value={350}>Fast</option>
                            <option value={150}>Turbo</option>
                        </select>
                    </label>
                </div>

                <div
                    style={{
                        maxHeight: 420,
                        overflowY: "auto",
                        border: "1px solid #ddd",
                        borderRadius: 6,
                        padding: 8,
                        background: "#fff",
                        fontFamily: "monospace",
                        fontSize: 13,
                    }}
                >
                    {sanMoves.length === 0 ? (
                        <div style={{ fontStyle: "italic" }}>No SAN moves archived.</div>
                    ) : (
                        <>
                            {(() => {
                                const rows = [];
                                for (let i = 0; i < sanMoves.length; i += 2) {
                                    const moveNo = i / 2 + 1;
                                    const w = sanMoves[i] || "";
                                    const b = sanMoves[i + 1] || "";
                                    const wPly = i + 1;
                                    const bPly = i + 2;

                                    rows.push(
                                        <div key={moveNo} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                                            <div style={{ width: 32 }}>{moveNo}.</div>
                                            <div
                                                style={{
                                                    width: 120,
                                                    cursor: "pointer",
                                                    background: ply === wPly ? "#e6f2ff" : "transparent",
                                                    borderRadius: 4,
                                                    padding: "0 4px",
                                                }}
                                                onClick={() => { setPlaying(false); setPly(wPly); }}
                                            >
                                                {w}
                                            </div>
                                            <div
                                                style={{
                                                    width: 120,
                                                    cursor: "pointer",
                                                    background: ply === bPly ? "#e6f2ff" : "transparent",
                                                    borderRadius: 4,
                                                    padding: "0 4px",
                                                }}
                                                onClick={() => { setPlaying(false); setPly(Math.min(bPly, maxPly)); }}
                                            >
                                                {b}
                                            </div>
                                        </div>
                                    );
                                }
                                return rows;
                            })()}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
