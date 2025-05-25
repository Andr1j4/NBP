import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useState, useEffect } from "react";

export default function LOCAL_PLAY() {
    const [game, setGame] = useState(new Chess());
    const [gamePosition, setGamePosition] = useState(game.fen());
    const [ws, setWs] = useState(null);
    const [playerColor, setPlayerColor] = useState("w");
    const [lastStreamId, setLastStreamId] = useState(null);

    const query = new URLSearchParams(window.location.search);
    const gameId = query.get("game_id");
    const colorFromURL = query.get("color");

    useEffect(() => {
        if (!gameId || !["w", "b"].includes(colorFromURL)) {
            console.error("Missing or invalid game_id/color in URL");
            return;
        }

        const socket = new WebSocket(`ws://192.168.0.3:8080/${gameId}/${colorFromURL}`);

        socket.onopen = () => {
            console.log("WebSocket connection established");
            socket.send(JSON.stringify({
                type: "resync",
                gameId,
                lastId: lastStreamId || '0-0'
            }));
        };

        socket.onmessage = (message) => {
            console.log("Player color:", playerColor);
            console.log("Received message:", message.data);
            const data = JSON.parse(message.data);
            if (data.streamId) setLastStreamId(data.streamId);

            if (data.type === "move") {
                const move = game.move(data.move);
                if (move === null) return false;

                setGamePosition(game.fen());

                if (game.isGameOver() || game.isDraw()) {
                    alert("Game over");
                }
            } else if (data.type === "reset") {
                game.reset();
                setGamePosition(game.fen());
            } else if (data.type === "undo") {
                game.undo();
                setGamePosition(game.fen());
            }
        };

        setWs(socket);
        setPlayerColor(colorFromURL);

        return () => {
            socket.close();
        };
    }, [gameId, colorFromURL, lastStreamId]);

    function onDrop(sourceSquare, targetSquare, piece) {
        try {
            if ((playerColor === "w" && piece[0] !== "w") ||
                (playerColor === "b" && piece[0] !== "b")) {
                return false;
            }

            const move = game.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1]?.toLowerCase() ?? "q"
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
            // give feedback to the user and notify that it's not severe
            if (error) {
                console.log("[INFO] Move not possible:", error);
            }
            console.log("An error occurred during the move. Please try again.");

        }
    }

    function undoMove() {
        game.undo();
        setGamePosition(game.fen());
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "undo" }));
        }
    }

    function resetGame() {
        game.reset();
        setGamePosition(game.fen());
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "reset" }));
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
