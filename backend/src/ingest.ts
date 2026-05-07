import { DuckDBInstance } from "@duckdb/node-api";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");
const RAW = resolve(DATA_DIR, "raw");
const PROCESSED = resolve(DATA_DIR, "processed");

const DIMENSION_TABLES = [
  "Participants.csv",
  "Apartments.csv",
  "Buildings.csv",
  "Employers.csv",
  "Jobs.csv",
  "Pubs.csv",
  "Restaurants.csv",
  "Schools.csv",
  "CheckinJournal.csv",
  "FinancialJournal.csv",
  "SocialNetwork.csv",
  "TravelJournal.csv",
];

async function main() {
  const db = await DuckDBInstance.create(":memory:");
  const con = await db.connect();

  console.log("[ingest] dimension tables");
  for (const name of DIMENSION_TABLES) {
    const src = resolve(RAW, name);
    if (!existsSync(src)) {
      console.log(`  [skip] ${name} not in ${RAW}`);
      continue;
    }
    const dst = resolve(PROCESSED, name.replace(".csv", ".parquet").toLowerCase());
    console.log(`  ${name} → ${dst.split("/").slice(-1)[0]}`);
    await con.run(`
      COPY (SELECT * FROM read_csv_auto('${src}', header=true))
      TO '${dst}' (FORMAT 'parquet', COMPRESSION 'zstd');
    `);
  }

  // Big one: partition by year-month
  const statusFiles = readdirSync(RAW).filter((f) =>
    f.startsWith("ParticipantStatusLogs") && f.endsWith(".csv"),
  );
  if (statusFiles.length === 0) {
    console.log("[ingest] no ParticipantStatusLogs*.csv found, skipping");
  } else {
    console.log(`[ingest] status logs (${statusFiles.length} files)`);
    const glob = resolve(RAW, "ParticipantStatusLogs*.csv");
    const outRoot = resolve(PROCESSED, "fact_status_logs");
    await con.run(`
      COPY (
        SELECT *, strftime(timestamp, '%Y-%m') AS year_month
        FROM read_csv_auto('${glob}', header=true, union_by_name=true)
      ) TO '${outRoot}'
      (FORMAT 'parquet',
       PARTITION_BY (year_month),
       COMPRESSION 'zstd',
       OVERWRITE_OR_IGNORE);
    `);
  }

  console.log("[ingest] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
