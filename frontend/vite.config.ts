import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.MARTHOUSE_API ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": { target: api, ws: true, changeOrigin: false },
      "/launch": { target: api, changeOrigin: false },
    },
  },
  build: { outDir: "../backend/marthouse/static", emptyOutDir: true },
});
