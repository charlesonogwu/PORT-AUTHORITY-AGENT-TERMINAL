import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

/**
 * Build configuration for the portpilot dashboard React app.
 *
 * `vite-plugin-singlefile` inlines all JS + CSS + assets into one HTML
 * file. portpilot's Node dashboard server then ships that single file as
 * the response to GET /, the same way it did with the hand-rolled HTML —
 * no static-asset routing on the server side, no second HTTP round-trip
 * for JS, no cache to bust. Just one file in, one file out.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Plugin turns these off, but be explicit so anyone reading the config
    // understands the intent: one self-contained HTML file, no /assets dir.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true, manualChunks: undefined } },
  },
})
