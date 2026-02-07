import { useState, useRef, useCallback } from "react";
import { Chess } from "chess.js";

export function useChessGame(initialFen = null) {
    const gameRef = useRef(new Chess(initialFen || undefined));
    const [gamePosition, setGamePosition] = useState(() => gameRef.current.fen());

    const updateGame = useCallback((newGame) => {
        gameRef.current = newGame;
        const fen = newGame && typeof newGame.fen === "function" ? String(newGame.fen()).trim() : "";
        setGamePosition(fen);
    }, []);

    const loadFen = useCallback((fen) => {
        const g = new Chess(fen);
        updateGame(g);
    }, [updateGame]);

    const makeMove = useCallback((move) => {
        const g = new Chess(gameRef.current.fen());
        const result = g.move(move);
        if (result) updateGame(g);
        return result;
    }, [updateGame]);

    const undo = useCallback(() => {
        const g = new Chess(gameRef.current.fen());
        g.undo();
        updateGame(g);
    }, [updateGame]);

    const reset = useCallback(() => {
        updateGame(new Chess());
    }, [updateGame]);

    return {
        game: gameRef.current,
        gamePosition,
        updateGame,
        loadFen,
        makeMove,
        undo,
        reset,
        isGameOver: () => gameRef.current.isGameOver(),
        isDraw: () => gameRef.current.isDraw(),
        isCheckmate: () => gameRef.current.isCheckmate(),
        fen: () => gameRef.current.fen(),
        history: () => gameRef.current.history(),
    };
}
