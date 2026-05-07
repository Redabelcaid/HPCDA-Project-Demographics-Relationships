# Engagement, Ohio — Challenge 1 Visual Analytics Tool

A coordinated multi-view tool for exploring demographics, social networks, and the business base of Engagement, Ohio (VAST Challenge 2022, Mini-Challenge 1).

## What's inside

A two-pane visual analytics app:

- **Left pane** — togglable between three views:
  - **Geography** — interactive city map with selectable choropleth overlays (building type, mean joviality, dominant interest group, mean wage)
  - **Relations** — parallel-sets diagram (Education → Interest group → Wage tier)
  - **3D Heightmap** *(experimental)* — buildings extruded with height = mean wage, color = mean joviality. Reveals the wage-joviality inversion spatially.
- **Right pane** — coordinated charts: age histogram, interest-group bars, group-interaction matrix, friend count vs joviality scatter, wage-by-education scatter, employer-size histogram, employer-detail Sankey.

All views share a selection store: clicking anything propagates to every other view. Selection-driven highlighting and dimming throughout.

## Stack

- **Backend**: Node.js + TypeScript, DuckDB + Parquet, Hono HTTP server
- **Frontend**: Vite + TypeScript, D3.js, Three.js (for the 3D heightmap)
- **No database server required** — DuckDB is embedded, queries Parquet files directly

## Prerequisites

- **Node.js 18+** (`node --version` to check)
- **npm** (comes with Node)

That's it. No Python, no Docker, no PostgreSQL, no GIS tooling. Cross-platform (macOS, Linux, Windows with WSL).

## Quick start

From the project root:

```bash
# 1. Install backend dependencies
cd backend
npm install

# 2. Install frontend dependencies
cd ../frontend
npm install
```

Then in **two separate terminals**:

```bash
# Terminal 1 — backend (serves API on http://localhost:3000)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (serves UI on http://localhost:5173)
cd frontend
npm run dev
```

Open `http://localhost:5173` in a browser.

## Project layout

```
vast_mc1/
├── backend/                    # API server + data pipeline
│   ├── src/
│   │   ├── db.ts              # DuckDB connection helpers
│   │   ├── ingest.ts          # CSV → Parquet conversion (one-time)
│   │   ├── derive.ts          # Parquet → JSON aggregations
│   │   ├── inspect.ts         # Diagnostic SQL queries
│   │   └── server.ts          # HTTP API
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.ts            # Entry point
│   │   ├── layout.ts          # Pane shell + view toggle
│   │   ├── state.ts           # Selection store (pub/sub)
│   │   ├── api.ts             # Backend client
│   │   └── views/             # All visualization modules
│   ├── index.html
│   └── package.json
├── data/
│   ├── processed/             # Parquet files (committed, ~65MB)
│   ├── derived/               # JSON aggregations (committed, ~3MB)
│   └── engagement.duckdb      # DuckDB database (committed)
└── README.md
```

## Data pipeline (already run, included in tarball)

The processed Parquet files, DuckDB database, and derived JSON are all included in this tarball, so the app is runnable immediately after `npm install`. If you ever need to regenerate them from scratch:

```bash
cd backend

# 1. Convert raw CSVs → Parquet (requires data/raw/ to exist with original CSVs)
npm run ingest

# 2. Build derived JSON aggregations
npm run derive

# 3. (Optional) Run diagnostic queries
npm run inspect
```

The raw CSV files (~5.5 GB) are **not** included in this tarball. Get them from the VAST Challenge 2022 dataset.

## Architecture notes

- **All SQL aggregations run at build time** (`npm run derive`), producing JSON in `data/derived/`. The frontend never queries DuckDB directly — it loads cached JSON via the API.
- **Selection store** — hand-rolled pub/sub (`frontend/src/state.ts`). Every view subscribes; updates propagate.
- **Coordinated highlighting** — selecting via any view (map building, employer dot, matrix cell, interest-group bar, education column, scatter dot, parallel-sets ribbon) lights up the corresponding entities in every other view.
- **Source-aware styling** — when an employer or building is the source of selection, it gets a gold ring on the map.
- **Skeleton loaders** — every section shows a shimmer placeholder until data arrives.

## Findings the tool surfaces

- **Joviality has geography but not demography** — clear neighborhood clusters in the choropleth, but flat across education and household composition.
- **Wage-joviality inversion** — higher-wage residents are *less* jovial than lower-wage ones (visible in the 3D heightmap as red towers).
- **Group H paradox** — most socially active interest group is also the least happy.
- **Bimodal degree-joviality** — participants with 250+ friends are dramatically happier (joviality 0.75) than those with 50-149 friends (0.18).
- **Atomized labor market** — 253 employers, max 9 jobs each, 8.3% vacancy rate.

## Troubleshooting

- **Port 3000 or 5173 in use** → kill the process or change ports in `backend/src/server.ts` / `frontend/vite.config.ts`.
- **`npm install` fails on macOS with native deps** → DuckDB needs its native binary; if install fails, try `npm install --build-from-source` or `npm rebuild`.
- **Frontend shows ECONNREFUSED in console** → backend isn't running. Both terminals need to be active simultaneously.
- **3D Heightmap renders nothing** → click the toggle, the canvas needs to be visible to size correctly. If it stays blank, hard-refresh (Ctrl+Shift+R / Cmd+Shift+R).


