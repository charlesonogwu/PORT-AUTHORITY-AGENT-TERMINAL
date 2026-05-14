import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui", background: "#0d1117", color: "#e6edf3", minHeight: "100vh" }}>
      <h1 style={{ marginTop: 0 }}>Port Authority Agent Terminal</h1>
      <p>Tauri shell loaded. React mounted. No localhost.</p>
      <p style={{ fontSize: "0.875rem", opacity: 0.6 }}>Phase 1–2 scaffold. The real dashboard ports in here in Phase 3.</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
