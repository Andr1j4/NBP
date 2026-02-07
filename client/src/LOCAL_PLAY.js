import { Chessboard } from "react-chessboard";
import { useState, useEffect } from "react";
import { useChessGame } from "./hooks/useChessGame";
import { useWebSocket } from "./hooks/useWebSocket";

export default function LOCAL_PLAY() {
    const query = new URLSearchParams(window.location.search);
    const gameId = query.get("game_id");
    const colorFromURL = query.get("color");

    const { game, gamePosition, makeMove, undo, reset, isGameOver, isDraw } = useChessGame();
    const [playerColor, setPlayerColor] = useState("w");

    // ✅ FIX: Use proper hook for WS
    const { send: wsSend } = useWebSocket(
        `/${gameId}/${colorFromURL}`,
        (data) => handleWsMessage(data),
        !!gameId && !!colorFromURL
    );

    // Parse game_id and color from URL
    useEffect(() => {
        if (!gameId || !["w", "b"].includes(colorFromURL)) {
            console.error("Missing or invalid game_id/color in URL");
            return;
        }

        setPlayerColor(colorFromURL);

        return () => {
            // Cleanup not needed for WS, handled by useWebSocket hook
        };
    }, [gameId, colorFromURL]);


    function handleWsMessage(data) {
        if (data.type === "move") {
            const move = makeMove(data.move);
            if (move === null) return false;

            // ✅ FIX: Use game reference, not undefined 'g'
            if (isGameOver() || isDraw()) {
                let result = null;
                let reason = null;

                if (isGameOver()) {
                    result = (playerColor === 'w') ? '1-0' : '0-1';
                    reason = 'checkmate';
                } else if (isDraw()) {
                    result = '1/2-1/2';
                    reason = 'draw'; // later you can refine: stalemate, repetition, etc.
                }

                alert("Game over");

                // Optionally, send game over result to server
                if (wsSend && result) {
                    wsSend({
                        type: 'game_over',
                        gameId,      // from query
                        result,      // "1-0", "0-1", "1/2-1/2"
                        reason,      // 'checkmate' | 'draw' | etc.
                        fen: game.fen() // final FEN (optional but nice to store)
                    });
                }
            }
            return true;
        } else if (data.type === "reset") {
            reset();
        } else if (data.type === "undo") {
            undo();
        }
    }

    function onDrop(sourceSquare, targetSquare, piece) {
        if ((playerColor === "w" && piece[0] !== "w") ||
            (playerColor === "b" && piece[0] !== "b")) {
            return false;
        }

        try {
            const move = makeMove({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1].toLowerCase() ?? "q"
            });

            if (!move) return false;

            if (wsSend) {
                wsSend({ type: "move", move });
            }

            return true;
        } catch (error) {
            console.error("Error during move:", error);
            return false;
        }
    }

    function undoMove() {
        undo();
        if (wsSend) wsSend({ type: "undo" });
    }

    function resetGame() {
        reset();
        if (wsSend) wsSend({ type: "reset" });
    }

    return (
        <div>
            <h2>Game ID: {gameId}</h2>
            <h3>You are: {playerColor === "w" ? "White" : "Black"}</h3>
            <Chessboard
                boardWidth={400}
                position={gamePosition}
                onPieceDrop={onDrop}
                boardOrientation={playerColor === "w" ? "white" : "black"}
            />
            <button onClick={resetGame}>Reset</button>
            <button onClick={undoMove}>Undo</button>
        </div>
    );
}
