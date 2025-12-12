import React, { useState } from "react";
import REDIS_CHESS from "./REDIS_CHESS";
import TournamentAdmin from "./TournamentAdmin";
import TournamentViewer from "./TournamentViewer";
import SpectatorBoard from "./SpectatorBoard";

export default function App() {
  const [view, setView] = useState("play"); // "play" | "admin" | "viewer"

  const path = window.location.pathname;
  const isWatch = path === "/watch";

  if (isWatch) {
    // dedicated spectator page
    return <SpectatorBoard />;
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h1>Redis Chess</h1>

      <div style={{ marginBottom: "1rem" }}>
        <button onClick={() => setView("play")}>Play</button>
        <button onClick={() => setView("admin")}>Admin</button>
        <button onClick={() => setView("viewer")}>Viewer</button>
      </div>

      {view === "play" && <REDIS_CHESS id="PlayableBoard" />}
      {view === "admin" && <TournamentAdmin />}
      {view === "viewer" && <TournamentViewer />}
    </div>
  );
}
