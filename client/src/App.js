import React, { useState } from "react";
// import LOCAL_PLAY from "./LOCAL_PLAY";
import REDIS_CHESS from "./REDIS_CHESS";

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
      {/* Uncomment the line below to use LOCAL_PLAY component */}
      {/* Local play goes with server_local from backend}
      {/* <LOCAL_PLAY id="LocalPlayBoard" /> */}

      {/* Uncomment the line below to use REDIS_CHESS component */}
      {/* {/* REDIS_CHESS goes with server_redis from backend} */}
      {<REDIS_CHESS id="PlayableBoard" />}

    </div>
  );
}