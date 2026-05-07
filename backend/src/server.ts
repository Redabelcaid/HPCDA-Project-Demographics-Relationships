import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import demographics from "./routes/demographics.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DERIVED_DIR = resolve(__dirname, "../../data/derived");

const app = new Hono();

app.use("/api/*", cors());

app.get("/", (c) => c.json({ ok: true, service: "vast-mc1-backend" }));

/**
 * Static derived files. Precomputed JSON aggregates from `npm run derive`,
 * served with browser cache headers so reloads are instant.
 *
 * Two layers of defense against path traversal:
 *   1. Filename must match an allowlist regex (no slashes, no ..)
 *   2. Resolved path must stay inside DERIVED_DIR
 */
app.get("/api/derived/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) {
    return c.notFound();
  }
  const path = resolve(DERIVED_DIR, filename);
  if (!path.startsWith(DERIVED_DIR + "/")) {
    return c.notFound();
  }
  try {
    const content = await readFile(path, "utf-8");
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(content);
  } catch {
    return c.notFound();
  }
});

app.route("/api/demographics", demographics);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`backend listening on http://localhost:${port}`);
});
