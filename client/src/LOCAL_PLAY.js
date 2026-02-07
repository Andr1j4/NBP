import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useState, useEffect } from "react";

export default function LOCAL_PLAY() {
    const [game, setGame] = useState(new Chess());
    const [gamePosition, setGamePosition] = useState(game.fen());
    const [ws, setWs] = useState(null);
    const [playerColor, setPlayerColor] = useState("w");

    // Parse game_id and color from URL
    const query = new URLSearchParams(window.location.search);
    const gameId = query.get("game_id");
    const colorFromURL = query.get("color");

    useEffect(() => {
        if (!gameId || !["w", "b"].includes(colorFromURL)) {
            console.error("Missing or invalid game_id/color in URL");
            return;
        }

        const socket = new WebSocket(`ws://10.121.107.106:8080/${gameId}/${colorFromURL}`);

        socket.onopen = () => {
            console.log("WebSocket connection established");
        };

        socket.onmessage = (message) => {
            const data = JSON.parse(message.data);
            console.log("Received message:", data);

            if (data.type === "move") {
                const move = game.move(data.move);
                if (move === null) return false;

                setGamePosition(game.fen());

                if (g.isGameOver() || g.isDraw()) {
                    let result = null;
                    let reason = null;

                    if (g.isCheckmate()) {
                        result = (playerColor === 'w') ? '1-0' : '0-1';
                        reason = 'checkmate';
                    } else if (g.isDraw()) {
                        result = '1/2-1/2';
                        reason = 'draw'; // later you can refine: stalemate, repetition, etc.
                    }

                    if (ws && ws.readyState === WebSocket.OPEN && result) {
                        ws.send(JSON.stringify({
                            type: 'game_over',
                            gameId,      // from query
                            result,      // "1-0", "0-1", "1/2-1/2"
                            reason,      // 'checkmate' | 'draw' | etc.
                            fen: g.fen() // final FEN (optional but nice to store)
                        }));
                    }

                    alert("Game over");
                }


                return true;
            } else if (data.type === "reset") {
                game.reset();
                setGamePosition(game.fen());
            } else if (data.type === "undo") {
                game.undo();
                setGamePosition(game.fen());
            }
            console.log("Game after message:", game);
        };

        setWs(socket);
        setPlayerColor(colorFromURL);

        return () => {
            socket.close();
        };
    }, [gameId, colorFromURL]);


    function undoMove() {
        game.undo();
        setGamePosition(game.fen());
        console.log("ws status:", ws ? ws : "No WebSocket");
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "undo" }));
        }
        console.log("Game after undo:", game);
    }

    function resetGame() {
        game.reset();
        setGamePosition(game.fen());
        console.log("ws status:", ws ? ws : "No WebSocket");

        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "reset" }));
        }
        console.log("Game after reset:", game);
    }

    function onDrop(sourceSquare, targetSquare, piece) {
        if ((playerColor === "w" && piece[0] !== "w") ||
            (playerColor === "b" && piece[0] !== "b")) {
            return false;
        }

        try {
            const move = game.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1].toLowerCase() ?? "q"
            });

            if (move === null) return false;

            setGamePosition(game.fen());

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "move",
                    move: move
                }));
            }

            if (game.isGameOver() || game.isDraw()) {
                alert("Game over");
            }

            return true;
        } catch (error) {
            console.error("Error during move:", error);
            return false;
        }
    }

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
