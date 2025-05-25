import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useState, useRef } from "react";

export default function DEFAULT_CHESS() {
    const [game, setGame] = useState(new Chess());
    const [gamePosition, setGamePosition] = useState(game.fen());
    const [currentPlayer, setCurrentPlayer] = useState("w");

    const [stockfishLevel, setStockfishLevel] = useState(2);

    function safeGameMutate(modify) {
        setGame(g => {
            const update = {
                ...g
            };
            modify(update);
            return update;
        });
    }
    function UndoMove(g) {
        console.log(game.undo());
        setGamePosition(game.fen());
        console.log("Game after undo:");
        console.log(game);
    }
    function Resetgame(g) {
        game.reset();
        setGamePosition(game.fen());
        console.log("Game reset to initial position");
        console.log(game);
    }


    function onDrop(sourceSquare, targetSquare, piece) {
        try {
            const move = game.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: piece[1].toLowerCase() ?? "q"
            });
            // illegal move
            if (move === null) return false;

            setGamePosition(game.fen());


            // exit if the game is over
            if (game.isGameOver() || game.isDraw()) {
                alert("Game over");
            };
            return true;

        } catch (error) {
            console.error("Error during move:", error);
            return false;
        }
    }
    return (
        <div>
            <Chessboard
                boardWidth={400}
                customNotationStyle={{
                    color: "#000",
                    fontWeight: "bold"
                }}
                animationDuration={200}
                position={game.fen()}
                onPieceDrop={onDrop}
                customBoardStyle={{
                    borderRadius: "4px",
                    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.5)"
                }} />
            <button onClick={(g) => {
                Resetgame(g);
            }}>
                reset
            </button>
            <button onClick={(g) => {
                UndoMove(g);
            }}>
                undo
            </button>
        </div>
    );
}
