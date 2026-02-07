// LOCAL_PLAY.jsx
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEffect, useRef, useState } from "react";

const WS_BASE = "ws://10.121.107.106:8080";

/**
 * NOTE:
 * - We DO NOT verify signature client-side (server does).
 * - This is only to *extract gameId/color hint*.
 * - If token is tampered, server will reject it and you'll become spectator.
 */
function decodeB64UrlJsonPayload(token) {
    try {
        if (!token || !token.includes(".")) return null;

        const parts = token.split(".");
        // support:
        // - JWT (3 parts): payload is parts[1]
        // - your HMAC play token (2 parts): payload is parts[0]
        const payloadB64Url = parts.length === 3 ? parts[1] : parts[0];

        const padLen = (4 - (payloadB64Url.length % 4)) % 4;
        const b64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
        const json = atob(b64);
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function normalizeColor(c) {
    return c === "w" || c === "b" ? c : "spectator";
}

export default function LOCAL_PLAY() {
    // ===================== GAME STATE =====================
    const [game, setGame] = useState(() => new Chess());
    const [gamePosition, setGamePosition] = useState(() => game.fen());
    const gameRef = useRef(game);

    function updateGameInstance(newGame) {
        const fen = newGame && typeof newGame.fen === "function" ? String(newGame.fen()).trim() : "";
        gameRef.current = newGame;
        setGame(newGame); // optional
        setGamePosition(fen);
    }

    // ===================== URL PARAMS =====================
    const query = new URLSearchParams(window.location.search);

    // NEW: signed play token (HMAC from backend)
    const playToken = query.get("token"); // /play?token=...

    // LEGACY: /play?game_id=...&color=w|b
    const gameIdLegacy = query.get("game_id");
    const legacyColor = query.get("color"); // may be null

    const tokenPayload = playToken ? decodeB64UrlJsonPayload(playToken) : null;

    // Determine gameId:
    const derivedGameId =
        (tokenPayload?.gameId || tokenPayload?.game_id || null) ?? gameIdLegacy ?? null;

    // (Optional) a color hint from token payload
    const tokenColorHint = tokenPayload?.color; // you sign this in backend playlink
    const legacyColorHint = legacyColor === "w" || legacyColor === "b" ? legacyColor : null;

    const [gameId, setGameId] = useState(() => derivedGameId);

    // ===================== WS / PERMISSIONS =====================
    const [ws, setWs] = useState(null);

    // UI color (server welcome decides)
    const [playerColor, setPlayerColor] = useState("spectator");

    // refs to avoid stale state in websocket callbacks :contentReference[oaicite:2]{index=2}
    const playerColorRef = useRef("spectator");
    const hintColorRef = useRef(tokenColorHint || legacyColorHint || "spectator");

    function setPlayerColorAuthoritative(c) {
        const norm = normalizeColor(c);
        playerColorRef.current = norm;
        setPlayerColor(norm);
        // if server tells us w/b, that becomes the hint too
        if (norm === "w" || norm === "b") hintColorRef.current = norm;
    }

    const [lastStreamId, setLastStreamId] = useState(null);
    const lastStreamIdRef = useRef(null);

    const optimisticResetRef = useRef(false);
    const optimisticResetFenRef = useRef(null);
    const pendingUndoRequestsRef = useRef(new Set());

    const [finished, setFinished] = useState(false);

    // ===================== CLOCK =====================
    const [clock, setClock] = useState({
        whiteMs: null,
        blackMs: null,
        active: null, // "w" | "b"
        running: false,
        serverNow: null,
        timeControl: null,
        incMs: null,
    });

    const [displayClock, setDisplayClock] = useState({
        whiteMs: null,
        blackMs: null,
    });

    function formatMs(ms) {
        if (ms == null) return "--:--";
        const s = Math.floor(ms / 1000);
        const mm = String(Math.floor(s / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        return `${mm}:${ss}`;
    }

    function winnerColorFromResult(result) {
        if (result === "1-0") return "w";
        if (result === "0-1") return "b";
        return null; // draw/unknown
    }

    // Unified game-over alert
    function showGameEnd(data) {
        // Use ref (authoritative, avoids stale state)
        let myColor = playerColorRef.current;

        // If welcome hasn't arrived yet (common in incognito), use token/legacy hint
        if (myColor !== "w" && myColor !== "b") {
            const hint = hintColorRef.current;
            if (hint === "w" || hint === "b") myColor = hint;
        }

        const winner = winnerColorFromResult(data.result);
        let message = "Game over";

        if (data.result === "1/2-1/2") {
            message = "Draw. (½–½)";
        } else if (winner) {
            // If we know our color: "You won/lost"
            if (myColor === "w" || myColor === "b") {
                message = winner === myColor ? `You won! (${data.result})` : `You lost. (${data.result})`;
            } else {
                // If spectator/unknown: show neutral text
                message = winner === "w" ? `White won. (${data.result})` : `Black won. (${data.result})`;
            }

            if (data.reason) message += ` – ${data.reason}`;
        } else if (data.reason === "timeout") {
            message = "Time expired.";
        }

        setFinished(true);
        setClock((c) => ({ ...c, running: false }));

        setTimeout(() => alert(message), 50);
    }

    // ===================== CONNECT WS =====================
    useEffect(() => {
        if (!gameId) {
            console.error("Missing gameId. Use /play?token=... or legacy /play?game_id=...&color=w|b");
            return;
        }

        // reset per-game finished flag when switching games
        setFinished(false);

        // IMPORTANT:
        // Start as spectator for permissions, but keep a hint for messaging
        setPlayerColorAuthoritative("spectator");

        // Build WS params:
        const jwtToken = localStorage.getItem("authToken") || "";

        const params = new URLSearchParams();
        if (jwtToken) params.set("token", jwtToken); // JWT
        if (playToken) params.set("play", playToken); // PlayLink (HMAC)

        const socket = new WebSocket(`${WS_BASE}/ws/game/${gameId}?${params.toString()}`);

        socket.onopen = () => {
            const persisted = localStorage.getItem(`game:${gameId}:lastId`);
            const clientLastId = persisted || "0-0";
            socket.send(JSON.stringify({ type: "resync", gameId, lastId: clientLastId }));
        };

        socket.onclose = (ev) => console.log("[WS] closed", ev);
        socket.onerror = (err) => console.error("[WS] error", err);

        socket.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            console.log("[WS IN]", data);

            if (data.type === "welcome") {
                // server decides: "w" | "b" | "spectator"
                setPlayerColorAuthoritative(data.color || "spectator");
                return;
            }

            if (data.type === "clock_state") {
                setClock({
                    whiteMs: data.whiteMs,
                    blackMs: data.blackMs,
                    active: data.active,
                    running: !!data.running,
                    serverNow: data.serverNow,
                    timeControl: data.timeControl ?? null,
                    incMs: data.incMs ?? null,
                });
                return;
            }

            if (data.type === "game_result" || data.type === "game_finished") {
                showGameEnd(data);
                return;
            }

            if (data.streamId) {
                try {
                    localStorage.setItem(`game:${gameId}:lastId`, data.streamId);
                } catch { }
                lastStreamIdRef.current = data.streamId;
                setLastStreamId(data.streamId);
            }

            if (data.type === "undo_request") {
                if (data.state && data.state !== "pending") return;

                const requestId = data.streamId || "";
                if (pendingUndoRequestsRef.current.has(requestId)) return;

                const from = data.from || "opponent";
                const accept = window.confirm(`${from} requested an undo. Accept?`);
                if (!accept) {
                    pendingUndoRequestsRef.current.delete(requestId);
                    socket.send(JSON.stringify({ type: "undo_reject", requestId }));
                    return;
                }

                const sanHistory = gameRef.current.history();
                if (sanHistory.length === 0) {
                    socket.send(JSON.stringify({ type: "undo_reject", requestId }));
                    return;
                }

                const clone = new Chess();
                try {
                    for (const san of sanHistory) {
                        const mv = clone.move(san);
                        if (mv === null) throw new Error(`replay failed on SAN="${san}"`);
                    }
                    clone.undo();
                    const resultFen = clone.fen();

                    pendingUndoRequestsRef.current.add(requestId);

                    const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
                    if (resultFen === START_FEN && sanHistory.length > 0) {
                        socket.send(JSON.stringify({ type: "undo_accept", requestId }));
                        return;
                    }

                    socket.send(JSON.stringify({ type: "undo_accept", fen: resultFen, requestId }));
                } catch {
                    pendingUndoRequestsRef.current.add(requestId);
                    socket.send(JSON.stringify({ type: "undo_accept", requestId }));
                }
                return;
            }

            if (data.type === "snapshot") {
                const snapshotFen = data.fen;
                if (snapshotFen) updateGameInstance(new Chess(snapshotFen));
                return;
            }

            if (data.type === "move") {
                const g = new Chess(gameRef.current.fen());
                const move = g.move(data.move);
                if (move === null) {
                    console.warn("Incoming move invalid for current position", data.move);
                    return;
                }
                updateGameInstance(g);

                // client-side game over (optional; server will decide too)
                if (g.isGameOver() || g.isDraw()) {
                    let result = null;
                    let reason = null;

                    if (g.isCheckmate()) {
                        result = move.color === "w" ? "1-0" : "0-1";
                        reason = "checkmate";
                    } else if (g.isDraw()) {
                        result = "1/2-1/2";
                        reason = "draw";
                    }

                    if (socket.readyState === WebSocket.OPEN && result) {
                        socket.send(JSON.stringify({ type: "game_over", gameId, result, reason, fen: g.fen() }));
                    }
                }
                return;
            }

            if (data.type === "reset") {
                if (data.fen) {
                    if (optimisticResetRef.current && optimisticResetFenRef.current === String(data.fen).trim()) {
                        optimisticResetRef.current = false;
                        optimisticResetFenRef.current = null;
                        return;
                    }
                    updateGameInstance(new Chess(data.fen));
                } else {
                    updateGameInstance(new Chess());
                }
                return;
            }

            if (data.type === "undo") {
                if (data.fen) updateGameInstance(new Chess(data.fen));
                else {
                    const g = new Chess(gameRef.current.fen());
                    g.undo();
                    updateGameInstance(g);
                }
                return;
            }
        };

        setWs(socket);

        return () => {
            try {
                socket.close();
            } catch { }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameId, playToken, legacyColor]);

    // keep gameId in sync if token decode changes
    useEffect(() => {
        if (derivedGameId && derivedGameId !== gameId) setGameId(derivedGameId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [derivedGameId]);

    // ===================== CLOCK LOCAL TICKING =====================
    useEffect(() => {
        if (!clock.running || !clock.serverNow || finished) {
            setDisplayClock({ whiteMs: clock.whiteMs, blackMs: clock.blackMs });
            return;
        }

        const interval = setInterval(() => {
            const now = Date.now();
            const elapsed = now - clock.serverNow;

            let w = clock.whiteMs;
            let b = clock.blackMs;

            if (clock.active === "w") w = Math.max(0, clock.whiteMs - elapsed);
            if (clock.active === "b") b = Math.max(0, clock.blackMs - elapsed);

            setDisplayClock({ whiteMs: w, blackMs: b });
        }, 200);

        return () => clearInterval(interval);
    }, [clock, finished]);

    // ===================== ACTIONS =====================
    function onDrop(sourceSquare, targetSquare, piece) {
        try {
            if (playerColor !== "w" && playerColor !== "b") return false;
            if (finished) return false;

            // piece[0] is "w" or "b"
            if ((playerColor === "w" && piece[0] !== "w") || (playerColor === "b" && piece[0] !== "b")) {
                return false;
            }

            const g = new Chess(gameRef.current.fen());
            const move = g.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1]?.toLowerCase() ?? "q",
            });
            if (move === null) return false;

            updateGameInstance(g);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "move", move, fen: g.fen() }));
            }

            return true;
        } catch (error) {
            console.log("[INFO] Move not possible:", error);
            return false;
        }
    }

    function undoMove() {
        if (finished) return;
        if (playerColor !== "w" && playerColor !== "b") return;

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "undo_request" }));
        } else {
            const g = new Chess(gameRef.current.fen());
            g.undo();
            updateGameInstance(g);
        }
    }

    function resetGame() {
        if (finished) return;
        if (playerColor !== "w" && playerColor !== "b") return;

        if (ws && ws.readyState === WebSocket.OPEN) {
            const g = new Chess();
            updateGameInstance(g);
            optimisticResetRef.current = true;
            optimisticResetFenRef.current = g.fen();
            ws.send(JSON.stringify({ type: "reset" }));
        } else {
            updateGameInstance(new Chess());
        }
    }

    // ===================== UI =====================
    const canAct = playerColor === "w" || playerColor === "b";

    return (
        <div>
            <h2>Game ID: {gameId || "(missing)"}</h2>

            <h3>You are: {playerColor === "w" ? "White" : playerColor === "b" ? "Black" : "Spectator"}</h3>

            {/* CLOCK */}
            <div style={{ marginBottom: 12, fontFamily: "monospace" }}>
                <div style={{ fontWeight: clock.active === "w" && clock.running ? "bold" : "normal" }}>
                    ⏱ White: {formatMs(displayClock.whiteMs)} {clock.active === "w" && clock.running ? "⬅" : ""}
                </div>
                <div style={{ fontWeight: clock.active === "b" && clock.running ? "bold" : "normal" }}>
                    ⏱ Black: {formatMs(displayClock.blackMs)} {clock.active === "b" && clock.running ? "⬅" : ""}
                </div>
            </div>

            <Chessboard
                boardWidth={400}
                animationDuration={200}
                position={gamePosition}
                onPieceDrop={onDrop}
                customBoardStyle={{
                    borderRadius: "4px",
                    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.5)",
                }}
                boardOrientation={playerColor === "b" ? "black" : "white"}
                arePiecesDraggable={canAct}
            />

            <div style={{ marginTop: 10 }}>
                <button onClick={resetGame} disabled={!canAct}>
                    Reset
                </button>
                <button onClick={undoMove} disabled={!canAct} style={{ marginLeft: 8 }}>
                    Undo
                </button>
            </div>

            {lastStreamId ? <div style={{ marginTop: 8, fontSize: 12 }}>lastStreamId: {lastStreamId}</div> : null}
        </div>
    );
}
