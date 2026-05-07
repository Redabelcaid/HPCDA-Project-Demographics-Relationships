import { defineConfig } from "vite";

/**
 * Why the proxy: during dev the frontend runs on 5173 and backend on 3000.
 * Without a proxy, every fetch('/api/...') would go to 5173 and 404.
 * With it, fetch('/api/foo') is transparently forwarded to localhost:3000.
 *
 * Bonus: it sidesteps CORS entirely in dev.
 */
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
