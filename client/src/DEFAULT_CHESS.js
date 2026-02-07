import { Chessboard } from "react-chessboard";
import { useChessGame } from "./hooks/useChessGame";

export default function DEFAULT_CHESS() {
    const { gamePosition, makeMove, undo, reset, isGameOver } = useChessGame();

    function onDrop(sourceSquare, targetSquare, piece) {
        const move = makeMove({
            from: sourceSquare,
            to: targetSquare,
            promotion: piece[1].toLowerCase() ?? "q"
        });

        if (!move) return false;

        if (isGameOver()) {
            alert("Game over");
        }

        return true;
    }

    return (
        <div>
            <Chessboard
                boardWidth={400}
                position={gamePosition}
                onPieceDrop={onDrop}
            />
            <button onClick={reset}>Reset</button>
            <button onClick={undo}>Undo</button>
        </div>
    );
}
