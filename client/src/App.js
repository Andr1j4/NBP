import React, { useState } from "react";
import REDIS_CHESS from "./REDIS_CHESS";
import TournamentAdmin from "./TournamentAdmin";

export default function App() {
  const [view, setView] = useState("play"); // "play" | "admin"

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
      <h1>Chess Platform</h1>

      <div style={{ marginBottom: "1rem" }}>
        <button
          onClick={() => setView("play")}
          disabled={view === "play"}
        >
          ♟ Play
        </button>
        &nbsp;
        <button
          onClick={() => setView("admin")}
          disabled={view === "admin"}
        >
          🛠 Admin
        </button>
      </div>

      {view === "play" && (
        <div>
          <h2>Redis Chess Example</h2>
          <p>You can try it locally using two web browsers.</p>
          <a href="http://127.0.0.1:3000/?game_id=abc123&color=w">
            player1: http://127.0.0.1:3000/?game_id=abc123&color=w
          </a>
          <br />
          <a href="http://127.0.0.1:3000/?game_id=abc123&color=b">
            player2: http://127.0.0.1:3000/?game_id=abc123&color=b
          </a>
          <br />
          <br />
          <REDIS_CHESS id="PlayableBoard" />
        </div>
      )}

      {view === "admin" && <TournamentAdmin />}
    </div>
  );
}
