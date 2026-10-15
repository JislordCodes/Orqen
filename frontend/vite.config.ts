import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "url";

// The backend's CORS allows http://localhost:5173 and :3000, so keep the dev port at 5173.
export default defineConfig({
  // GitHub Pages serves the demo from /orqen/; set VITE_BASE=/orqen/ for that build.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, strictPort: true },
  // `npm run preview` can sit behind a tunnel and proxy /api to the local FastAPI server.
  preview: {
    port: 4173,
    allowedHosts: true,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
