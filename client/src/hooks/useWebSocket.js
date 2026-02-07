import { useEffect, useRef, useState, useCallback } from "react";
import { WS_BASE } from "../config";

export function useWebSocket(url, onMessage, autoConnect = true) {
    const wsRef = useRef(null);
    const [status, setStatus] = useState("closed");
    const messageHandlerRef = useRef(onMessage);

    // Keep handler in sync
    useEffect(() => {
        messageHandlerRef.current = onMessage;
    }, [onMessage]);

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        setStatus("connecting");
        const ws = new WebSocket(`${WS_BASE}${url}`);

        ws.onopen = () => {
            setStatus("open");
            console.log("[WS] Connected to", url);
        };

        ws.onerror = (err) => {
            setStatus("error");
            console.error("[WS] Error:", err);
        };

        ws.onclose = () => {
            setStatus("closed");
            console.log("[WS] Closed", url);
        };

        ws.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                messageHandlerRef.current?.(data);
            } catch (e) {
                console.warn("[WS] Bad message:", e);
            }
        };

        wsRef.current = ws;
    }, [url]);

    const disconnect = useCallback(() => {
        wsRef.current?.close();
    }, []);

    const send = useCallback((obj) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(obj));
        }
    }, []);

    useEffect(() => {
        if (autoConnect) connect();
        return () => disconnect();
    }, [url, autoConnect, connect, disconnect]);

    return { ws: wsRef.current, status, send, connect, disconnect };
}
