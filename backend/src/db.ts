import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = resolve(__dirname, "../../data");

const PROCESSED = resolve(DATA_DIR, "processed");
const DB_FILE = resolve(DATA_DIR, "engagement.duckdb");

// view name → parquet file in data/processed/
const TABLE_MAP: Record<string, string> = {
  participants: "participants.parquet",
  apartments: "apartments.parquet",
  buildings: "buildings.parquet",
  employers: "employers.parquet",
  jobs: "jobs.parquet",
  pubs: "pubs.parquet",
  restaurants: "restaurants.parquet",
  schools: "schools.parquet",
  checkin_journal: "checkinjournal.parquet",
  financial_journal: "financialjournal.parquet",
  social_network: "socialnetwork.parquet",
  travel_journal: "traveljournal.parquet",
};

let _db: Awaited<ReturnType<typeof DuckDBInstance.create>> | null = null;
let _con: Awaited<ReturnType<NonNullable<typeof _db>["connect"]>> | null = null;

export async function getDb() {
  if (_con) return _con;

  _db = await DuckDBInstance.create(DB_FILE);
  _con = await _db.connect();

  await _con.run("PRAGMA threads=8");
  await _con.run("PRAGMA memory_limit='12GB'");

  await registerViews(_con);
  return _con;
}

async function registerViews(con: NonNullable<typeof _con>) {
  for (const [view, fname] of Object.entries(TABLE_MAP)) {
    const path = resolve(PROCESSED, fname);
    if (existsSync(path)) {
      await con.run(`
        CREATE OR REPLACE VIEW ${view} AS
        SELECT * FROM read_parquet('${path}')
      `);
    }
  }

  const statusRoot = resolve(PROCESSED, "fact_status_logs");
  if (existsSync(statusRoot)) {
    await con.run(`
      CREATE OR REPLACE VIEW status_logs AS
      SELECT * FROM read_parquet('${statusRoot}/**/*.parquet',
                                 hive_partitioning=true)
    `);
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const con = await getDb();
  const reader = await con.runAndReadAll(sql);
  const rows = reader.getRowObjects();
  // DuckDB returns counts/big ints as BigInt; coerce so JSON.stringify works
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  }) as T[];
}
