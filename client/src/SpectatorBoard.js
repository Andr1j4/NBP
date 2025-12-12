// client/src/SpectatorBoard.js
import React, { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

export default function SpectatorBoard({ gameId, timeControl }) {
    const [position, setPosition] = useState(new Chess().fen());
    const gameRef = useRef(new Chess());

    const [moves, setMoves] = useState([]); // [{moveNumber, white, black}]
    const movesEndRef = useRef(null);

    const [resultText, setResultText] = useState("");
    const [wsStatus, setWsStatus] = useState("connecting");

    const [whiteTimeMs, setWhiteTimeMs] = useState(null);
    const [blackTimeMs, setBlackTimeMs] = useState(null);
    const activeColorRef = useRef("w"); // whose clock is ticking
    const lastTickRef = useRef(null);
    const runningRef = useRef(true);
    const incrementRef = useRef(0); // seconds

    const API_BASE = "192.168.0.2:8080"; // or "" if you use proxy


    // parse timeControl string like "5+0" or "3+2"
    useEffect(() => {
        if (!timeControl) return;
        try {
            const [minStr, incStr] = String(timeControl).split("+");
            const baseMinutes = parseInt(minStr, 10);
            const inc = parseInt(incStr, 10) || 0;

            if (!isNaN(baseMinutes) && baseMinutes > 0) {
                const baseMs = baseMinutes * 60 * 1000;
                setWhiteTimeMs(baseMs);
                setBlackTimeMs(baseMs);
                incrementRef.current = inc;
                activeColorRef.current = "w";
                lastTickRef.current = Date.now();
                runningRef.current = true;
            }
        } catch (e) {
            console.warn("Failed to parse timeControl:", timeControl, e);
        }
    }, [timeControl]);

    // Load full move history when gameId changes
    useEffect(() => {
        if (!gameId) {
            setMoves([]);
            return;
        }

        async function loadHistory() {
            try {
                const res = await fetch(`http://${API_BASE}/api/games/${gameId}/moves`);
                const data = await res.json();
                if (!res.ok) {
                    console.warn('[Spectator] failed to load history:', data.error);
                    return;
                }
                setMoves(data.moves || []);
            } catch (e) {
                console.error('[Spectator] history load failed', e);
            }
        }

        loadHistory();
    }, [gameId]);


    // clock ticking effect (client-side only)
    useEffect(() => {
        if (whiteTimeMs == null || blackTimeMs == null) return;

        const id = setInterval(() => {
            if (!runningRef.current) return;

            const now = Date.now();
            const last = lastTickRef.current || now;
            const delta = now - last;
            lastTickRef.current = now;

            if (activeColorRef.current === "w") {
                setWhiteTimeMs((t) => Math.max(t - delta, 0));
            } else {
                setBlackTimeMs((t) => Math.max(t - delta, 0));
            }
        }, 200);

        return () => clearInterval(id);
    }, [whiteTimeMs, blackTimeMs]);

    // helper: format ms -> mm:ss
    function formatTime(ms) {
        if (ms == null) return "—";
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    // auto-scroll move list
    useEffect(() => {
        if (movesEndRef.current) {
            movesEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [moves]);

    // Reset local board & clocks whenever we switch to a different game
    useEffect(() => {
        if (!gameId) return;

        const g = new Chess();
        gameRef.current = g;
        setPosition(g.fen());
        setMoves([]);
        setResultText("");

        // reset clocks to "stopped / unknown"
        setWhiteTimeMs(null);
        setBlackTimeMs(null);
        activeColorRef.current = "w";
        runningRef.current = true;
        lastTickRef.current = null;
    }, [gameId]);


    // WebSocket connection
    useEffect(() => {
        if (!gameId) return;

        const wsUrl = `ws://${API_BASE}/${gameId}/spectator`;
        const socket = new WebSocket(wsUrl);

        setWsStatus("connecting");

        socket.onopen = () => {
            setWsStatus("open");
            // Ask backend for snapshot + recent moves
            socket.send(
                JSON.stringify({
                    type: "resync",
                    gameId,
                    lastId: "0-0"
                })
            );
        };



        socket.onerror = (err) => {
            console.error("[Spectator WS] error", err);
            setWsStatus("error");
        };

        socket.onclose = () => {
            console.log("[Spectator WS] closed");
            setWsStatus("closed");
        };

        socket.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            // console.log("[Spectator WS IN]", data);

            if (data.type === "snapshot" && data.fen) {
                // reset board to snapshot position
                const g = new Chess(data.fen);
                gameRef.current = g;
                setPosition(g.fen());
                // ❌ DO NOT clear moves here
                // setMoves([]);
                return;
            }


            if (data.type === "move") {
                const g = new Chess(gameRef.current.fen());
                const move = g.move(data.move);
                if (!move) {
                    console.warn("[Spectator] invalid move for current position", data.move);
                    return;
                }
                gameRef.current = g;
                setPosition(g.fen());

                // update move list (pair SAN as w/b)
                setMoves((prev) => {
                    const next = [...prev];
                    const san = move.san;
                    const color = move.color;

                    if (color === "w") {
                        next.push({
                            moveNumber: next.length + 1,
                            white: san,
                            black: ""
                        });
                    } else {
                        if (next.length === 0) {
                            next.push({
                                moveNumber: 1,
                                white: "...",
                                black: san
                            });
                        } else {
                            const last = next[next.length - 1];
                            next[next.length - 1] = {
                                ...last,
                                black: san
                            };
                        }
                    }

                    return next;
                });

                // update clocks: increment just-played side, then switch
                if (incrementRef.current && incrementRef.current > 0) {
                    if (move.color === "w") {
                        setWhiteTimeMs((t) => t + incrementRef.current * 1000);
                    } else {
                        setBlackTimeMs((t) => t + incrementRef.current * 1000);
                    }
                }

                // switch active side for ticking
                activeColorRef.current = move.color === "w" ? "b" : "w";
                lastTickRef.current = Date.now();

                // detect game end locally as a fallback
                if (g.isGameOver() || g.isDraw()) {
                    runningRef.current = false;
                }

                return;
            }

            // Server announced official result
            if (data.type === "game_result") {
                const { result, reason } = data;
                let txt = "";

                if (result === "1-0") txt = "1–0 (white wins)";
                else if (result === "0-1") txt = "0–1 (black wins)";
                else if (result === "1/2-1/2") txt = "½–½ (draw)";
                else txt = result || "Game finished";

                if (reason) txt += ` – ${reason}`;

                setResultText(txt);
                runningRef.current = false;
                return;
            }

            // backend telling us game was already finished
            if (data.type === "game_finished") {
                setResultText("Game already finished.");
                runningRef.current = false;
            }
        };

        return () => {
            try {
                socket.close();
            } catch (e) {
                // ignore
            }
        };
    }, [gameId]);

    if (!gameId) {
        return (
            <div style={{ padding: "0.5rem", fontStyle: "italic" }}>
                No game selected.
            </div>
        );
    }



    const wsColor =
        wsStatus === "open"
            ? "green"
            : wsStatus === "connecting"
                ? "orange"
                : wsStatus === "error"
                    ? "red"
                    : "#555";

    return (
        <div
            style={{
                display: "flex",
                gap: "1rem",
                alignItems: "flex-start",
                padding: "0.5rem",
                border: "1px solid #ccc",
                borderRadius: "4px",
                marginTop: "0.75rem"
            }}
        >
            {/* Left: board + clocks + status */}
            <div>
                <div
                    style={{
                        marginBottom: "0.25rem",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "0.85rem"
                    }}
                >
                    <span style={{ fontFamily: "monospace" }}>
                        Watching game: {gameId}
                    </span>
                    <span style={{ color: wsColor }}>
                        WS: {wsStatus}
                    </span>
                </div>

                {/* Clocks */}
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: "0.25rem",
                        fontFamily: "monospace",
                        fontSize: "0.9rem"
                    }}
                >
                    <div>
                        ♟ White&nbsp;
                        <span
                            style={{
                                fontWeight:
                                    activeColorRef.current === "w" && runningRef.current
                                        ? "bold"
                                        : "normal"
                            }}
                        >
                            {formatTime(whiteTimeMs)}
                        </span>
                    </div>
                    <div>
                        ♟ Black&nbsp;
                        <span
                            style={{
                                fontWeight:
                                    activeColorRef.current === "b" && runningRef.current
                                        ? "bold"
                                        : "normal"
                            }}
                        >
                            {formatTime(blackTimeMs)}
                        </span>
                    </div>
                </div>

                <Chessboard
                    boardWidth={400}
                    position={position}
                    arePiecesDraggable={false}
                    customBoardStyle={{
                        borderRadius: "4px",
                        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.5)"
                    }}
                />

                {resultText && (
                    <div
                        style={{
                            marginTop: "0.5rem",
                            padding: "0.25rem 0.5rem",
                            background: "#eee",
                            borderRadius: "4px",
                            fontSize: "0.9rem"
                        }}
                    >
                        <strong>Result:</strong> {resultText}
                    </div>
                )}
            </div>

            {/* Right: move list */}
            <div
                style={{
                    minWidth: "180px",
                    maxHeight: "400px",
                    overflowY: "auto",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    padding: "0.25rem"
                }}
            >
                <div
                    style={{
                        fontSize: "0.9rem",
                        marginBottom: "0.25rem",
                        fontWeight: "bold"
                    }}
                >
                    Moves
                </div>
                {moves.length === 0 ? (
                    <div style={{ fontStyle: "italic", fontSize: "0.85rem" }}>
                        No moves yet.
                    </div>
                ) : (
                    <table
                        style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: "0.85rem"
                        }}
                    >
                        <thead>
                            <tr>
                                <th style={{ textAlign: "left", width: "2.5rem" }}>#</th>
                                <th style={{ textAlign: "left" }}>White</th>
                                <th style={{ textAlign: "left" }}>Black</th>
                            </tr>
                        </thead>
                        <tbody>
                            {moves.map((m, idx) => (
                                <tr
                                    key={m.moveNumber + "-" + idx}
                                    style={
                                        idx === moves.length - 1
                                            ? { background: "#f0f8ff" }
                                            : {}
                                    }
                                >
                                    <td>{m.moveNumber}.</td>
                                    <td>{m.white}</td>
                                    <td>{m.black}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div ref={movesEndRef} />
            </div>
        </div>
    );
}
