import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useState, useEffect, useRef } from "react";

export default function LOCAL_PLAY() {
    const [game, setGame] = useState(new Chess());
    const [gamePosition, setGamePosition] = useState(game.fen());
    const gameRef = useRef(game); // always-current Chess instance

    function updateGameInstance(newGame) {
        // normalize fen and trim whitespace
        const fen = (newGame && typeof newGame.fen === 'function') ? String(newGame.fen()).trim() : '';

        console.log('[DEBUG] updateGameInstance fen=', fen);

        // update ref immediately
        gameRef.current = newGame;

        // update state synchronously to avoid forced remounts / flicker
        setGame(newGame);        // optional: keep if other code reads `game` state
        setGamePosition(fen);
    }

    const [ws, setWs] = useState(null);
    const [playerColor, setPlayerColor] = useState("w");
    const [lastStreamId, setLastStreamId] = useState(null);
    const lastStreamIdRef = useRef(null); // do not use to re-create socket
    const optimisticResetRef = useRef(false);
    const optimisticResetFenRef = useRef(null);
    const pendingUndoRequestsRef = useRef(new Set());

    const query = new URLSearchParams(window.location.search);
    const gameId = query.get("game_id");
    const colorFromURL = query.get("color");

    useEffect(() => {
        if (!gameId || !["w", "b"].includes(colorFromURL)) {
            console.error("Missing or invalid game_id/color in URL");
            return;
        }

        const socket = new WebSocket(`ws://192.168.0.2:8080/${gameId}/${colorFromURL}`);

        socket.onopen = () => {
            // read persisted lastId only from localStorage to avoid recreating socket on updates
            const persisted = localStorage.getItem(`game:${gameId}:lastId`);
            const clientLastId = persisted || '0-0';
            console.log('[WS] open, sending resync lastId=', clientLastId);
            socket.send(JSON.stringify({ type: 'resync', gameId, lastId: clientLastId }));
        };

        socket.onclose = (ev) => {
            console.log('[WS] closed', ev);
        };
        socket.onerror = (err) => {
            console.error('[WS] error', err);
        };

        socket.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            console.log('[WS IN]', data);

            // log kicked messages so takeover is visible client-side
            if (data.type === 'kicked') {
                console.warn('[WS] received kicked:', data.reason);
            }

            // persist last seen id but DO NOT trigger socket recreation
            if (data.streamId) {
                try { localStorage.setItem(`game:${gameId}:lastId`, data.streamId); } catch (e) { }
                lastStreamIdRef.current = data.streamId;
                setLastStreamId(data.streamId);
            }

            // incoming undo request: only prompt for new/live requests, track pending ids
            if (data.type === 'undo_request') {
                console.log('[DEBUG] incoming undo_request', data);
                // skip non-pending states
                if (data.state && data.state !== 'pending') return;

                const requestId = data.streamId || '';
                // rely on server-provided state and server-side resync filtering.
                // only dedupe locally so we don't prompt twice for the same requestId.
                console.log('[DEBUG] undo_request received requestId=', requestId, 'state=', data.state, 'lastSeen=', lastStreamIdRef.current, 'pendingSet=', Array.from(pendingUndoRequestsRef.current));
                if (pendingUndoRequestsRef.current.has(requestId)) return;

                const from = data.from || 'opponent';
                const accept = window.confirm(`${from} requested an undo. Accept?`);
                if (!accept) {
                    console.log('[DEBUG] sending undo_reject requestId=', requestId);
                    pendingUndoRequestsRef.current.delete(requestId);
                    socket.send(JSON.stringify({ type: 'undo_reject', requestId }));
                    return; // handled
                }

                // Try non-mutating replay using SAN history (more robust)
                const sanHistory = gameRef.current.history(); // array of SAN strings
                console.log('[DEBUG] sanHistory length=', sanHistory.length, 'lastMoves=', sanHistory.slice(-6));
                if (sanHistory.length === 0) {
                    console.log('[DEBUG] no history to compute undo -> rejecting', requestId);
                    socket.send(JSON.stringify({ type: 'undo_reject', requestId }));
                    return;
                }

                const clone = new Chess();
                try {
                    // replay SAN moves in order
                    for (const san of sanHistory) {
                        const mv = clone.move(san);
                        if (mv === null) throw new Error(`replay failed on SAN="${san}"`);
                    }
                    // undo last ply (call twice if you want to undo a full move pair)
                    clone.undo();
                    const resultFen = clone.fen();
                    console.log('[DEBUG] replay succeeded resultFen=', resultFen);

                    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
                    // guard: if computed fen is the starting position but we had moves, don't trust it
                    if (resultFen === START_FEN && sanHistory.length > 0) {
                        console.warn('[WARN] computed START_FEN from replay despite moves — falling back to server-side lookup');
                        console.log('[DEBUG] sending undo_accept (no fen) requestId=', requestId);
                        socket.send(JSON.stringify({
                            type: 'undo_accept',
                            requestId: requestId
                        }));
                        return;
                    }

                    console.log('[DEBUG] sending undo_accept fen=', resultFen, 'requestId=', requestId);
                    pendingUndoRequestsRef.current.add(requestId);
                    socket.send(JSON.stringify({
                        type: 'undo_accept',
                        fen: resultFen,
                        requestId
                    }));
                } catch (err) {
                    console.warn('[DEBUG] replay failed, falling back to server-side previous-FEN lookup', err);
                    // send accept without fen; server will use recent-FEN list to compute
                    pendingUndoRequestsRef.current.add(requestId);
                    console.log('[DEBUG] sending undo_accept (no fen) requestId=', requestId);
                    socket.send(JSON.stringify({
                        type: 'undo_accept',
                        requestId
                    }));
                }
                return; // handled
            }

            // Apply a snapshot from server (fast resync)
            if (data.type === 'snapshot') {
                const snapshotFen = data.fen;
                if (snapshotFen) {
                    const g = new Chess(snapshotFen);
                    updateGameInstance(g);
                }
                return;
            }

            // debug logs
            console.log("Player color:", playerColor);
            console.log("Received message:", msg.data);

            if (data.type === "move") {
                // apply move on a fresh instance derived from current authoritative state
                const g = new Chess(gameRef.current.fen());
                const move = g.move(data.move);
                if (move === null) {
                    console.warn("Incoming move invalid for current position", data.move);
                    return;
                }
                updateGameInstance(g);

                // use the fresh instance (g) not the stale `game` state

                if (g.isGameOver() || g.isDraw()) {
                    let result = null;
                    let reason = null;

                    if (g.isCheckmate()) {
                        result = (move.color === 'w') ? '1-0' : '0-1';
                        reason = 'checkmate';
                    } else if (g.isDraw()) {
                        result = '1/2-1/2';
                        reason = 'draw';
                    }

                    if (socket.readyState === WebSocket.OPEN && result) {
                        socket.send(JSON.stringify({
                            type: 'game_over',
                            gameId,
                            result,
                            reason,
                            fen: g.fen()
                        }));
                    }

                    setTimeout(() => {
                        alert("Game over");
                    }, 500);
                }

                return;
            }

            if (data.type === "reset") {
                // prefer server-provided fen if present
                if (data.fen) {
                    // if we applied an optimistic reset locally and the server fen matches, skip re-applying
                    if (optimisticResetRef.current && optimisticResetFenRef.current === String(data.fen).trim()) {
                        optimisticResetRef.current = false;
                        optimisticResetFenRef.current = null;
                        return;
                    }
                    const g = new Chess(data.fen);
                    updateGameInstance(g);
                } else {
                    // fallback reset from server (no fen)
                    const g = new Chess();
                    updateGameInstance(g);
                }
                return;
            }

            if (data.type === "undo") {
                // apply accepted undo using FEN provided by server (preferred)
                if (data.fen) {
                    const g = new Chess(data.fen);
                    updateGameInstance(g);
                } else {
                    // fallback: undo on current instance ref
                    const g = new Chess(gameRef.current.fen());
                    g.undo();
                    updateGameInstance(g);
                }
                return;
            }

            // other message types handled here if needed
        };

        setWs(socket);
        setPlayerColor(colorFromURL);

        return () => {
            try { socket.close(); } catch (e) { }
        };
    }, [gameId, colorFromURL]); // removed lastStreamId to avoid reconnect races

    function onDrop(sourceSquare, targetSquare, piece) {
        try {
            if ((playerColor === "w" && piece[0] !== "w") ||
                (playerColor === "b" && piece[0] !== "b")) {
                return false;
            }

            // apply on a fresh instance from the latest ref
            const g = new Chess(gameRef.current.fen());
            const move = g.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1]?.toLowerCase() ?? "q"
            });
            if (move === null) return false;
            updateGameInstance(g);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "move",
                    move: move,
                    fen: g.fen() // send the authoritative FEN from the fresh instance
                }));
            }

            if (g.isGameOver() || g.isDraw()) {
                setTimeout(() => {
                    alert("Game over");
                }, 500);
            }

            return true;

        } catch (error) {
            if (error) {
                console.log("[INFO] Move not possible:", error);
            }
            console.log("An error occurred during the move. Please try again.");
        }
    }

    function undoMove() {
        console.log('[DEBUG] user clicked undo, sending undo_request');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'undo_request' }));
        } else {
            const g = new Chess(gameRef.current.fen());
            g.undo();
            updateGameInstance(g);
        }
    }

    function resetGame() {
        // send reset request and wait for server to broadcast authoritative reset (with fen)
        if (ws && ws.readyState === WebSocket.OPEN) {
            // apply optimistic reset locally so initiator sees immediate effect
            const g = new Chess();
            updateGameInstance(g);
            optimisticResetRef.current = true;
            optimisticResetFenRef.current = g.fen();
            ws.send(JSON.stringify({ type: "reset" }));
        } else {
            const g = new Chess();
            updateGameInstance(g);
        }
    }

    // debug: watch gamePosition updates
    useEffect(() => {
        console.log('[DEBUG] gamePosition updated =>', gamePosition);
    }, [gamePosition]);

    return (
        <div>
            <h2>Game ID: {gameId}</h2>
            <h3>You are playing as: {playerColor === "w" ? "White" : "Black"}</h3>
            <Chessboard
                boardWidth={400}
                customNotationStyle={{ color: "#000", fontWeight: "bold" }}
                animationDuration={200}
                position={gamePosition}
                onPieceDrop={onDrop}
                customBoardStyle={{
                    borderRadius: "4px",
                    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.5)"
                }}
                boardOrientation={playerColor === "w" ? "white" : "black"}
            />
            <button onClick={resetGame}>Reset</button>
            <button onClick={undoMove}>Undo</button>
        </div>
    );
}
