import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build configuration for the Tauri-hosted dashboard. Notable differences
// from the old dashboard-ui/portpilot-dashboard config:
//
//   - No vite-plugin-singlefile. Tauri loads index.html from disk via the
//     `tauri://` protocol, so inlining everything into one file is no
//     longer needed.
//   - clearScreen: false + strict port — Tauri's beforeDevCommand expects
//     Vite on port 1420 specifically.
//   - envPrefix includes TAURI_ so build-time Tauri vars flow through.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
