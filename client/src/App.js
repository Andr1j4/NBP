import React, { useState } from "react";
import REDIS_CHESS from "./REDIS_CHESS";
import TournamentStandings from "./TournamentStandings";

export default function App() {
  const [showBoard, setShowBoard] = useState(false);

  return (
    <div>
      Example Usage:
      <h1>Redis Chess Example</h1>
      You can try it locally using two web browsers.
      <br />
      <a href="http://127.0.0.1:3000/?game_id=abc123&color=w">
        player1: http://127.0.0.1:3000/?game_id=abc123&color=w
      </a>
      <br />
      <a href="http://127.0.0.1:3000/?game_id=abc123&color=b">
        player2: http://127.0.0.1:3000/?game_id=abc123&color=b
      </a>
      <br />
      NOTICE: The game_id must be the same for both players.
      <br />
      NOTICE: The color must be different for both players.
      <br />
      NOTICE: Change Redis server in server_redis if needed.
      <br />
      <REDIS_CHESS id="PlayableBoard" />

      {/* NEW: standings */}
      <TournamentStandings />
    </div>
  );
}
