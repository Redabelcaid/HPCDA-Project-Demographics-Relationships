/**
 * Pre-aggregation: run SQL once, write JSON to data/derived/.
 * The frontend reads these via /api/derived/<name>.json.
 *
 * Run via: npm run derive
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");
const PROCESSED = resolve(DATA_DIR, "processed");
const DERIVED = resolve(DATA_DIR, "derived");

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

/**
 * Parse a WKT POLYGON or POLYGON-with-holes string into an array of rings.
 * Format: "POLYGON ((outer), (hole1), (hole2))"
 *
 * Returns [outerRing, ...holeRings] where each ring is [[x,y], ...].
 * Most polygons have just one ring (no holes); 23 of our 1042 have one
 * inner ring (a courtyard).
 */
function parsePolygon(wkt: string): [number, number][][] {
  const inner = wkt.match(/POLYGON\s*\((.*)\)$/);
  if (!inner) return [];
  const ringStrings = inner[1].split(/\)\s*,\s*\(/);
  return ringStrings.map((ringStr) => {
    const clean = ringStr.replace(/^\(/, "").replace(/\)$/, "");
    return clean.split(",").map((pair) => {
      const [x, y] = pair.trim().split(/\s+/).map(Number);
      return [x, y] as [number, number];
    });
  });
}

/** Parse a WKT POINT into [x, y]. */
function parsePoint(wkt: string): [number, number] | null {
  const match = wkt.match(/POINT\s*\(([^)]+)\)/);
  if (!match) return null;
  const [x, y] = match[1].trim().split(/\s+/).map(Number);
  return [x, y];
}

function coerce(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  });
}

async function main() {
  const db = await DuckDBInstance.create(":memory:");
  const con = await db.connect();

  for (const [view, fname] of Object.entries(TABLE_MAP)) {
    const path = resolve(PROCESSED, fname);
    if (existsSync(path)) {
      await con.run(
        `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_parquet('${path}')`,
      );
    }
  }

  console.log("[derive] building aggregate JSON files");

  const targets: Record<string, string> = {
    participants: `
      SELECT participantId, age, educationLevel, householdSize,
             haveKids, joviality, interestGroup
      FROM participants
    `,
    joviality_by_education: `
      SELECT educationLevel,
             count(*)        AS n,
             avg(joviality)  AS mean_joviality,
             avg(age)        AS mean_age
      FROM participants
      GROUP BY educationLevel
      ORDER BY mean_joviality DESC
    `,
    interest_groups: `
      SELECT interestGroup,
             count(*)            AS n,
             avg(age)            AS mean_age,
             avg(joviality)      AS mean_joviality,
             avg(householdSize)  AS mean_household_size,
             sum(CAST(haveKids AS INTEGER)) * 1.0 / count(*) AS pct_with_kids
      FROM participants
      GROUP BY interestGroup
      ORDER BY interestGroup
    `,
  };

  for (const [name, sql] of Object.entries(targets)) {
    const reader = await con.runAndReadAll(sql);
    const rows = coerce(reader.getRowObjects());
    const path = resolve(DERIVED, `${name}.json`);
    await writeFile(path, JSON.stringify(rows));
    console.log(`  wrote ${name}.json (${rows.length} rows)`);
  }

  // Buildings need polygon parsing — handled separately from the simple
  // SQL-to-JSON targets above.
  console.log("  parsing building polygons...");
  const buildingsRaw = await con.runAndReadAll(`
    SELECT buildingId, location, buildingType, maxOccupancy, units
    FROM buildings
  `);
  const buildings = coerce(buildingsRaw.getRowObjects()).map((row) => ({
    buildingId: row.buildingId,
    buildingType: row.buildingType,
    maxOccupancy: row.maxOccupancy,
    units: row.units,
    rings: parsePolygon(row.location as string),
  }));
  await writeFile(
    resolve(DERIVED, "buildings.json"),
    JSON.stringify(buildings),
  );
  console.log(`  wrote buildings.json (${buildings.length} polygons)`);

  // Schools and pubs as point landmarks (useful for Q3).
  const schoolsRaw = await con.runAndReadAll("SELECT * FROM schools");
  const schools = coerce(schoolsRaw.getRowObjects()).map((row) => ({
    ...row,
    point: parsePoint(row.location as string),
  }));
  await writeFile(resolve(DERIVED, "schools.json"), JSON.stringify(schools));
  console.log(`  wrote schools.json (${schools.length} rows)`);

  const pubsRaw = await con.runAndReadAll("SELECT * FROM pubs");
  const pubs = coerce(pubsRaw.getRowObjects()).map((row) => ({
    ...row,
    point: parsePoint(row.location as string),
  }));
  await writeFile(resolve(DERIVED, "pubs.json"), JSON.stringify(pubs));
  console.log(`  wrote pubs.json (${pubs.length} rows)`);

  // Residency: participantId → apartment's buildingId.
  // Used by the map view to translate "clicked building" → "select these residents".
  // We use the most recent Apartment check-in per participant as their residence.
  console.log("  computing residency...");
  const residencyRows = await con.runAndReadAll(`
    SELECT
      latest.participantId,
      a.buildingId
    FROM (
      SELECT participantId, venueId,
             ROW_NUMBER() OVER (PARTITION BY participantId
                                ORDER BY timestamp DESC) AS rn
      FROM checkin_journal
      WHERE venueType = 'Apartment'
    ) latest
    JOIN apartments a ON a.apartmentId = latest.venueId
    WHERE latest.rn = 1
  `);
  const residency: Record<number, number> = {};
  for (const row of coerce(residencyRows.getRowObjects())) {
    residency[row.participantId as number] = row.buildingId as number;
  }
  await writeFile(
    resolve(DERIVED, "residency.json"),
    JSON.stringify(residency),
  );
  console.log(
    `  wrote residency.json (${Object.keys(residency).length} participants)`,
  );


  // === Q2: social network derived data ===
  // The graph is symmetric (reciprocity = 1.0), so we collapse each
  // pair to a canonical (a, b) with a < b and store the count once.
  console.log("  computing social edges...");
  const edgesRows = await con.runAndReadAll(`
    SELECT
      LEAST(participantIdFrom, participantIdTo)    AS a,
      GREATEST(participantIdFrom, participantIdTo) AS b,
      count(*) / 2                                 AS n
    FROM social_network
    GROUP BY a, b
  `);
  const edges = coerce(edgesRows.getRowObjects()).map((row) => ({
    a: row.a as number,
    b: row.b as number,
    n: row.n as number,
  }));
  await writeFile(
    resolve(DERIVED, "social_edges.json"),
    JSON.stringify(edges),
  );
  console.log(`  wrote social_edges.json (${edges.length} unique pairs)`);

  // Top-N strongest pairs for the map's arc overlay.
  // 80k arcs would unreadable; 500 highlights the strongest social ties.
  const topN = 500;
  const topEdges = [...edges]
    .sort((x, y) => y.n - x.n)
    .slice(0, topN);
  await writeFile(
    resolve(DERIVED, "social_edges_top.json"),
    JSON.stringify(topEdges),
  );
  console.log(`  wrote social_edges_top.json (top ${topN})`);



  console.log("  computing social summary per participant...");
  const summaryRows = await con.runAndReadAll(`
    SELECT
      pid                                         AS participantId,
      CAST(count(DISTINCT partner) AS INTEGER)    AS degree,
      CAST(sum(n) AS DOUBLE)                      AS total_interactions
    FROM (
      SELECT participantIdFrom AS pid,
             participantIdTo   AS partner,
             1.0                AS n
      FROM social_network
    )
    GROUP BY pid
    ORDER BY degree DESC
  `);

  const summary = coerce(summaryRows.getRowObjects());
  await writeFile(
    resolve(DERIVED, "social_summary.json"),
    JSON.stringify(summary),
  );
  console.log(`  wrote social_summary.json (${summary.length} rows)`);

  // === Q2: group-level interaction matrix ===
  // Aggregate interactions by interest group of source and target.
  // Reciprocity = 1.0 means we can divide by 2 to get unique pair counts.
  // Normalized by group sizes to remove "bigger groups have more interactions" effect.
  console.log("  computing group-level interaction matrix...");
  const groupMatrixRows = await con.runAndReadAll(`
    WITH counts AS (
      SELECT
        pf.interestGroup AS from_group,
        pt.interestGroup AS to_group,
        CAST(count(*) / 2 AS INTEGER) AS interactions
      FROM social_network sn
      JOIN participants pf ON pf.participantId = sn.participantIdFrom
      JOIN participants pt ON pt.participantId = sn.participantIdTo
      GROUP BY from_group, to_group
    ),
    sizes AS (
      SELECT interestGroup, count(*) AS n FROM participants GROUP BY interestGroup
    )
    SELECT
      c.from_group,
      c.to_group,
      c.interactions,
      sf.n AS from_size,
      st.n AS to_size,
      CAST(c.interactions AS DOUBLE) / (sf.n * st.n) AS normalized
    FROM counts c
    JOIN sizes sf ON sf.interestGroup = c.from_group
    JOIN sizes st ON st.interestGroup = c.to_group
  `);
  await writeFile(
    resolve(DERIVED, "group_matrix.json"),
    JSON.stringify(coerce(groupMatrixRows.getRowObjects())),
  );
  console.log("  wrote group_matrix.json");


  // === Q3: Business / employer / job data ===

  console.log("  computing job data...");
  const jobsRows = await con.runAndReadAll(`
    SELECT
      jobId,
      employerId,
      CAST(hourlyRate AS DOUBLE) AS hourlyRate,
      educationRequirement,
      startTime,
      endTime
    FROM jobs
  `);
  await writeFile(
    resolve(DERIVED, "jobs.json"),
    JSON.stringify(coerce(jobsRows.getRowObjects())),
  );
  console.log(`  wrote jobs.json`);

  // Per-employer stats with location parsed from WKT.
  // Used for map dots (size = n_jobs, color = avg_wage).
  console.log("  computing employer stats...");
  const employerRaw = await con.runAndReadAll(`
    SELECT
      e.employerId,
      e.location,
      e.buildingId,
      CAST(count(j.jobId)             AS INTEGER) AS n_jobs,
      CAST(avg(j.hourlyRate)          AS DOUBLE)  AS avg_wage,
      CAST(min(j.hourlyRate)          AS DOUBLE)  AS min_wage,
      CAST(max(j.hourlyRate)          AS DOUBLE)  AS max_wage
    FROM employers e
    LEFT JOIN jobs j ON j.employerId = e.employerId
    GROUP BY e.employerId, e.location, e.buildingId
  `);
  const employerStats = coerce(employerRaw.getRowObjects()).map((row) => ({
    employerId: row.employerId,
    buildingId: row.buildingId,
    point: parsePoint(row.location as string),
    n_jobs: row.n_jobs,
    avg_wage: row.avg_wage,
    min_wage: row.min_wage,
    max_wage: row.max_wage,
  }));
  await writeFile(
    resolve(DERIVED, "employer_stats.json"),
    JSON.stringify(employerStats),
  );
  console.log(`  wrote employer_stats.json (${employerStats.length} rows)`);



  // === Q1↔Q3 join: participant → employer ===
  // Source: most-frequent Workplace checkin per participant.
  // Workplace venueId is a buildingId; we join through the employers
  // table to get an employerId.

  console.log("  computing participant employment...");
  const employmentRows = await con.runAndReadAll(`
    WITH workplace_checkins AS (
      SELECT participantId, venueId AS employerId, count(*) AS n
      FROM checkin_journal
      WHERE venueType = 'Workplace'
      GROUP BY participantId, venueId
    ),
    most_frequent AS (
      SELECT participantId, employerId,
             ROW_NUMBER() OVER (PARTITION BY participantId
                                ORDER BY n DESC, employerId ASC) AS rn
      FROM workplace_checkins
    )
    SELECT
      mf.participantId,
      mf.employerId,
      e.buildingId
    FROM most_frequent mf
    JOIN employers e ON e.employerId = mf.employerId
    WHERE mf.rn = 1
  `);
  const employment: Record<number, { buildingId: number; employerId: number | null }> = {};
  for (const row of coerce(employmentRows.getRowObjects())) {
    employment[row.participantId as number] = {
      buildingId: row.buildingId as number,
      employerId: row.employerId as number,
    };
  }


  await writeFile(
    resolve(DERIVED, "participant_employment.json"),
    JSON.stringify(employment),
  );
  console.log(
    `  wrote participant_employment.json (${Object.keys(employment).length} participants)`,
  );


  // Top friends per participant — pre-sorted, capped at 20.
  // Used by the Sankey diagram and map arc overlay; with this lookup
  // table we can render at any "top N friends" cutoff in O(1) per
  // participant.
  console.log("  computing top friends per participant...");
  const topFriendsRows = await con.runAndReadAll(`
    WITH directed AS (
      -- Re-expand the symmetric edges so each participant sees their friends.
      SELECT a AS pid, b AS friend, n FROM read_parquet('${resolve(DERIVED, "social_edges.json")}')
      UNION ALL
      SELECT b AS pid, a AS friend, n FROM read_parquet('${resolve(DERIVED, "social_edges.json")}')
    )
    SELECT pid, friend, n,
           ROW_NUMBER() OVER (PARTITION BY pid ORDER BY n DESC, friend ASC) AS rk
    FROM directed
    QUALIFY rk <= 20
    ORDER BY pid, rk
  `).catch(async () => {
    // Fallback: read from social_network directly. The direct read above
    // depends on the json file being readable as parquet, which it isn't.
    // Easier to just go to the source.
    return con.runAndReadAll(`
      WITH counts AS (
        SELECT
          LEAST(participantIdFrom, participantIdTo)    AS a,
          GREATEST(participantIdFrom, participantIdTo) AS b,
          count(*) / 2                                 AS n
        FROM social_network
        GROUP BY a, b
      ),
      directed AS (
        SELECT a AS pid, b AS friend, n FROM counts
        UNION ALL
        SELECT b AS pid, a AS friend, n FROM counts
      )
      SELECT pid, friend, CAST(n AS INTEGER) AS n,
             CAST(ROW_NUMBER() OVER (PARTITION BY pid ORDER BY n DESC, friend ASC) AS INTEGER) AS rk
      FROM directed
      QUALIFY rk <= 20
      ORDER BY pid, rk
    `);
  });

  // Reshape into pid → [{friend, n}, ...] in rank order
  const topFriends: Record<number, { friend: number; n: number }[]> = {};
  for (const row of coerce(topFriendsRows.getRowObjects())) {
    const pid = row.pid as number;
    if (!topFriends[pid]) topFriends[pid] = [];
    topFriends[pid].push({
      friend: row.friend as number,
      n: row.n as number,
    });
  }
  await writeFile(
    resolve(DERIVED, "top_friends_by_participant.json"),
    JSON.stringify(topFriends),
  );
  console.log(
    `  wrote top_friends_by_participant.json (${Object.keys(topFriends).length} participants)`,
  );



  // Per-participant categorical tuple: education / interest group / wage tier.
  // Used by the Relations parallel-sets view.
  console.log("  computing participant categorical tuple...");
  const categoricalRows = await con.runAndReadAll(`
    WITH employer_wage AS (
      SELECT employerId, CAST(avg(hourlyRate) AS DOUBLE) AS avg_wage
      FROM jobs GROUP BY employerId
    ),
    -- Per-participant employer (most-frequent workplace checkin)
    workplace_freq AS (
      SELECT participantId, venueId AS employerId, count(*) AS n
      FROM checkin_journal
      WHERE venueType = 'Workplace'
      GROUP BY participantId, venueId
    ),
    most_freq AS (
      SELECT participantId, employerId,
             ROW_NUMBER() OVER (PARTITION BY participantId
                                ORDER BY n DESC, employerId ASC) AS rn
      FROM workplace_freq
    )
    SELECT
      p.participantId,
      p.educationLevel,
      p.interestGroup,
      ew.avg_wage,
      CASE
        WHEN ew.avg_wage IS NULL                  THEN 'unknown'
        WHEN ew.avg_wage <  15                    THEN '$10–$15'
        WHEN ew.avg_wage <  25                    THEN '$15–$25'
        WHEN ew.avg_wage <  40                    THEN '$25–$40'
        ELSE                                            '$40+'
      END AS wage_tier
    FROM participants p
    LEFT JOIN most_freq mf ON mf.participantId = p.participantId AND mf.rn = 1
    LEFT JOIN employer_wage ew ON ew.employerId = mf.employerId
  `);
  await writeFile(
    resolve(DERIVED, "participant_categorical.json"),
    JSON.stringify(coerce(categoricalRows.getRowObjects())),
  );
  console.log(`  wrote participant_categorical.json`);


  // Per-building demographic aggregates for choropleth overlays.
  // Means are computed across each building's known residents.
  // Dominant interest group = the modal group (ties broken alphabetically).
  console.log("  computing building demographic aggregates...");
  const buildingDemoRows = await con.runAndReadAll(`
    WITH residents AS (
      SELECT
        a.buildingId,
        p.participantId,
        p.age,
        p.joviality,
        p.interestGroup,
        p.educationLevel
      FROM participants p
      JOIN (
        SELECT participantId, venueId,
               ROW_NUMBER() OVER (PARTITION BY participantId
                                  ORDER BY timestamp DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Apartment'
      ) latest ON latest.participantId = p.participantId AND latest.rn = 1
      JOIN apartments a ON a.apartmentId = latest.venueId
    ),
    employer_wage AS (
      SELECT employerId, CAST(avg(hourlyRate) AS DOUBLE) AS avg_wage
      FROM jobs GROUP BY employerId
    ),
    workplace_freq AS (
      SELECT participantId, venueId AS employerId, count(*) AS n
      FROM checkin_journal
      WHERE venueType = 'Workplace'
      GROUP BY participantId, venueId
    ),
    most_freq_workplace AS (
      SELECT participantId, employerId,
             ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY n DESC, employerId ASC) AS rn
      FROM workplace_freq
    ),
    resident_wages AS (
      SELECT r.buildingId, r.participantId, ew.avg_wage
      FROM residents r
      LEFT JOIN most_freq_workplace mw ON mw.participantId = r.participantId AND mw.rn = 1
      LEFT JOIN employer_wage ew ON ew.employerId = mw.employerId
    ),
    grouped AS (
      SELECT r.buildingId,
             CAST(count(*) AS INTEGER) AS n_residents,
             CAST(avg(r.age) AS DOUBLE) AS mean_age,
             CAST(avg(r.joviality) AS DOUBLE) AS mean_joviality,
             CAST(avg(rw.avg_wage) AS DOUBLE) AS mean_wage,
             ARRAY_AGG(r.interestGroup ORDER BY r.interestGroup) AS groups
      FROM residents r
      LEFT JOIN resident_wages rw ON rw.participantId = r.participantId
      GROUP BY r.buildingId
    )
    SELECT
      buildingId, n_residents, mean_age, mean_joviality, mean_wage,
      -- Dominant group: the most-frequent value in the array. DuckDB doesn't
      -- have a clean MODE aggregator, so we sort+pick. The array is already
      -- sorted alphabetically, ties go to the first letter, which is fine.
      (SELECT groups[1]) AS dominant_group
    FROM grouped
  `);
  await writeFile(
    resolve(DERIVED, "building_demographics.json"),
    JSON.stringify(coerce(buildingDemoRows.getRowObjects())),
  );
  console.log(`  wrote building_demographics.json`);


  // === Hierarchical edge bundling for Q2 social corridors ===
  // Force-directed edge bundling (Holten & van Wijk 2009) computed offline.
  // Frontend renders the precomputed curves on Canvas.
  console.log("  computing edge bundles (this takes ~30-60s)...");

  // We need participant residence coordinates and the top edges to bundle.
  // Top 5000 by interaction count is the cap — bundling 80k is intractable
  // and most weak ties don't form corridors anyway.
  const bundleEdgeRows = await con.runAndReadAll(`
    WITH top_edges AS (
      SELECT
        LEAST(participantIdFrom, participantIdTo)    AS a,
        GREATEST(participantIdFrom, participantIdTo) AS b,
        CAST(count(*) / 2 AS INTEGER)                AS n
      FROM social_network
      GROUP BY a, b
      ORDER BY n DESC
      LIMIT 5000
    ),
    -- Resolve to residence coordinates via apartments
    resolved AS (
      SELECT
        e.a, e.b, e.n,
        CAST(ax.x AS DOUBLE) AS ax, CAST(ax.y AS DOUBLE) AS ay,
        CAST(bx.x AS DOUBLE) AS bx, CAST(bx.y AS DOUBLE) AS by
      FROM top_edges e
      JOIN (
        SELECT participantId, venueId, ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY timestamp DESC) AS rn
        FROM checkin_journal WHERE venueType = 'Apartment'
      ) ca ON ca.participantId = e.a AND ca.rn = 1
      JOIN (
        SELECT apartmentId, regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 1) AS x_str,
               regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 2) AS y_str
        FROM apartments
      ) aa ON aa.apartmentId = ca.venueId
      JOIN (SELECT CAST(aa.x_str AS DOUBLE) AS x, CAST(aa.y_str AS DOUBLE) AS y, aa.apartmentId
            FROM (SELECT apartmentId,
                         regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 1) AS x_str,
                         regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 2) AS y_str
                  FROM apartments) aa) ax ON ax.apartmentId = ca.venueId
      JOIN (
        SELECT participantId, venueId, ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY timestamp DESC) AS rn
        FROM checkin_journal WHERE venueType = 'Apartment'
      ) cb ON cb.participantId = e.b AND cb.rn = 1
      JOIN (SELECT CAST(aa.x_str AS DOUBLE) AS x, CAST(aa.y_str AS DOUBLE) AS y, aa.apartmentId
            FROM (SELECT apartmentId,
                         regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 1) AS x_str,
                         regexp_extract(location, '\\(([0-9.-]+) ([0-9.-]+)\\)', 2) AS y_str
                  FROM apartments) aa) bx ON bx.apartmentId = cb.venueId
    )
    SELECT * FROM resolved
  `);

  type BEdge = { a: number; b: number; n: number; ax: number; ay: number; bx: number; by: number };
  const bedges: BEdge[] = coerce(bundleEdgeRows.getRowObjects()).map((r) => ({
    a: r.a as number,
    b: r.b as number,
    n: r.n as number,
    ax: r.ax as number,
    ay: r.ay as number,
    bx: r.bx as number,
    by: r.by as number,
  }));
  console.log(`  bundling ${bedges.length} edges...`);

  // Force-Directed Edge Bundling — simplified Holten/van Wijk
  const SUBDIVISIONS = 10;        // points per edge interior
  const ITERATIONS = 30;
  const STIFFNESS = 0.1;
  const COMPAT_THRESHOLD = 0.6;
  const STEP_SIZE = 0.05;

  // Initialize each edge with subdivision points along straight line
  type Curve = { ax: number; ay: number; bx: number; by: number; n: number; points: number[][]; len: number; angle: number };
  const curves: Curve[] = bedges.map((e) => {
    const points: number[][] = [];
    for (let i = 1; i <= SUBDIVISIONS; i++) {
      const t = i / (SUBDIVISIONS + 1);
      points.push([e.ax + (e.bx - e.ax) * t, e.ay + (e.by - e.ay) * t]);
    }
    const dx = e.bx - e.ax, dy = e.by - e.ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    return { ax: e.ax, ay: e.ay, bx: e.bx, by: e.by, n: e.n, points, len, angle };
  });

  // Compatibility: edges are compatible if angle, length, and proximity all align.
  // We precompute compat pairs to avoid O(n²) per iteration.
  console.log("  building compatibility matrix...");
  const compatPairs: number[][] = curves.map(() => []);
  for (let i = 0; i < curves.length; i++) {
    const ci = curves[i];
    for (let j = i + 1; j < curves.length; j++) {
      const cj = curves[j];
      // Angle compatibility
      const angleDiff = Math.abs(Math.cos(ci.angle - cj.angle));
      // Length compatibility (geometric mean ratio)
      const lenAvg = (ci.len + cj.len) / 2;
      const lenComp = Math.min(ci.len, cj.len) / Math.max(ci.len, cj.len);
      // Position compatibility (midpoint distance)
      const mxi = (ci.ax + ci.bx) / 2, myi = (ci.ay + ci.by) / 2;
      const mxj = (cj.ax + cj.bx) / 2, myj = (cj.ay + cj.by) / 2;
      const midDist = Math.sqrt((mxi - mxj) ** 2 + (myi - myj) ** 2);
      const posComp = lenAvg / (lenAvg + midDist);
      const compat = angleDiff * lenComp * posComp;
      if (compat >= COMPAT_THRESHOLD) {
        compatPairs[i].push(j);
        compatPairs[j].push(i);
      }
    }
    if (i % 500 === 0 && i > 0) console.log(`    compat ${i}/${curves.length}`);
  }
  const compatTotal = compatPairs.reduce((s, a) => s + a.length, 0) / 2;
  console.log(`  ${compatTotal} compatible edge pairs (avg ${(compatTotal * 2 / curves.length).toFixed(1)} per edge)`);

  // Iterative bundling
  console.log("  iterating bundling forces...");
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newPoints: number[][][] = curves.map((c) => c.points.map((p) => [p[0], p[1]]));
    for (let i = 0; i < curves.length; i++) {
      const ci = curves[i];
      const peers = compatPairs[i];
      if (peers.length === 0) continue;
      for (let s = 0; s < SUBDIVISIONS; s++) {
        let fx = 0, fy = 0;
        for (const j of peers) {
          const cj = curves[j];
          // Each compatible edge pulls toward its corresponding subdivision point
          const dx = cj.points[s][0] - ci.points[s][0];
          const dy = cj.points[s][1] - ci.points[s][1];
          fx += dx;
          fy += dy;
        }
        // Spring-back force toward straight-line position
        const t = (s + 1) / (SUBDIVISIONS + 1);
        const straightX = ci.ax + (ci.bx - ci.ax) * t;
        const straightY = ci.ay + (ci.by - ci.ay) * t;
        const sx = (straightX - ci.points[s][0]) * STIFFNESS * peers.length;
        const sy = (straightY - ci.points[s][1]) * STIFFNESS * peers.length;
        newPoints[i][s][0] = ci.points[s][0] + (fx + sx) * STEP_SIZE / peers.length;
        newPoints[i][s][1] = ci.points[s][1] + (fy + sy) * STEP_SIZE / peers.length;
      }
    }
    // Apply
    for (let i = 0; i < curves.length; i++) {
      curves[i].points = newPoints[i];
    }
    if (iter % 5 === 0) console.log(`    iter ${iter}/${ITERATIONS}`);
  }

  // Serialize: array of [ax, ay, ...controlPts..., bx, by, n]
  const serialized = curves.map((c) => ({
    a: [c.ax, c.ay],
    b: [c.bx, c.by],
    pts: c.points,
    n: c.n,
  }));
  await writeFile(
    resolve(DERIVED, "social_bundles.json"),
    JSON.stringify(serialized),
  );
  console.log(`  wrote social_bundles.json (${serialized.length} bundled curves)`);

  // === Employer profiles for the BI-style detail dashboard ===
  // Per employer: job composition, wage stats, vacancy, demographics,
  // commute distance, social cohesion, schedule.
  console.log("computing employer profiles...");

  const employerProfiles = coerce((await con.runAndReadAll(`
    WITH employees AS (
      -- Most-frequent workplace per participant
      SELECT participantId, venueId AS employerId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Workplace'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    ),
    participant_residence AS (
      -- Residence point per participant (from their most-frequent apartment)
      SELECT
        p.participantId,
        ap.location AS res_location
      FROM participants p
      JOIN (
        SELECT participantId, venueId AS apartmentId
        FROM (
          SELECT participantId, venueId, COUNT(*) AS n,
                 ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
          FROM checkin_journal
          WHERE venueType = 'Apartment'
          GROUP BY participantId, venueId
        )
        WHERE rn = 1
      ) ar ON ar.participantId = p.participantId
      JOIN apartments ap ON ap.apartmentId = ar.apartmentId
    ),
    employer_locations AS (
      SELECT employerId, location AS emp_location
      FROM employers
    ),
    job_composition AS (
      SELECT
        employerId,
        COUNT(*) AS n_jobs,
        SUM(CASE WHEN educationRequirement = 'Low' THEN 1 ELSE 0 END) AS n_low,
        SUM(CASE WHEN educationRequirement = 'HighSchoolOrCollege' THEN 1 ELSE 0 END) AS n_hs,
        SUM(CASE WHEN educationRequirement = 'Bachelors' THEN 1 ELSE 0 END) AS n_bachelors,
        SUM(CASE WHEN educationRequirement = 'Graduate' THEN 1 ELSE 0 END) AS n_graduate,
        CAST(MIN(hourlyRate) AS DOUBLE) AS min_wage,
        CAST(MAX(hourlyRate) AS DOUBLE) AS max_wage,
        CAST(AVG(hourlyRate) AS DOUBLE) AS mean_wage,
        CAST(MEDIAN(hourlyRate) AS DOUBLE) AS median_wage
      FROM jobs
      GROUP BY employerId
    ),
    workforce_demo AS (
      SELECT
        e.employerId,
        COUNT(*) AS n_employees,
        CAST(AVG(p.age) AS DOUBLE) AS mean_age,
        SUM(CASE WHEN p.educationLevel = 'Low' THEN 1 ELSE 0 END) AS emp_low,
        SUM(CASE WHEN p.educationLevel = 'HighSchoolOrCollege' THEN 1 ELSE 0 END) AS emp_hs,
        SUM(CASE WHEN p.educationLevel = 'Bachelors' THEN 1 ELSE 0 END) AS emp_bachelors,
        SUM(CASE WHEN p.educationLevel = 'Graduate' THEN 1 ELSE 0 END) AS emp_graduate,
        SUM(CASE WHEN p.householdSize = 1 THEN 1 ELSE 0 END) AS emp_alone,
        SUM(CASE WHEN p.householdSize = 2 AND p.haveKids = false THEN 1 ELSE 0 END) AS emp_couple,
        SUM(CASE WHEN p.haveKids = true THEN 1 ELSE 0 END) AS emp_family
      FROM employees e
      JOIN participants p ON p.participantId = e.participantId
      GROUP BY e.employerId
    ),
    schedule AS (
      SELECT
        employerId,
        ANY_VALUE(daysToWork) AS days_pattern,
        ANY_VALUE(startTime) AS start_time,
        ANY_VALUE(endTime) AS end_time
      FROM jobs
      GROUP BY employerId
    ),
    commute AS (
      -- Mean Euclidean commute distance per employer.
      -- Locations are stored as WKT 'POINT (x y)' strings; we parse them
      -- with regex extraction (portable, no spatial extension needed).
      SELECT
        e.employerId,
        CAST(AVG(
          SQRT(
            POWER(
              CAST(REGEXP_EXTRACT(pr.res_location, 'POINT \\(([-0-9.]+) ', 1) AS DOUBLE) -
              CAST(REGEXP_EXTRACT(el.emp_location, 'POINT \\(([-0-9.]+) ', 1) AS DOUBLE)
            , 2) +
            POWER(
              CAST(REGEXP_EXTRACT(pr.res_location, ' ([-0-9.]+)\\)', 1) AS DOUBLE) -
              CAST(REGEXP_EXTRACT(el.emp_location, ' ([-0-9.]+)\\)', 1) AS DOUBLE)
            , 2)
          )
        ) AS DOUBLE) AS mean_commute
      FROM employees e
      JOIN participant_residence pr ON pr.participantId = e.participantId
      JOIN employer_locations el ON el.employerId = e.employerId
      GROUP BY e.employerId
    ),
    coworker_pairs AS (
      SELECT e1.employerId,
             e1.participantId AS p1,
             e2.participantId AS p2
      FROM employees e1
      JOIN employees e2
        ON e1.employerId = e2.employerId
       AND e1.participantId < e2.participantId
    ),
    unique_edges AS (
      SELECT LEAST(participantIdFrom, participantIdTo) AS a,
             GREATEST(participantIdFrom, participantIdTo) AS b
      FROM social_network
      GROUP BY a, b
    ),
    cohesion AS (
      SELECT
        cp.employerId,
        COUNT(*) AS n_pairs,
        SUM(CASE WHEN ue.a IS NOT NULL THEN 1 ELSE 0 END) AS n_friend_pairs,
        CAST(SUM(CASE WHEN ue.a IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS DOUBLE) AS cohesion_rate
      FROM coworker_pairs cp
      LEFT JOIN unique_edges ue ON ue.a = cp.p1 AND ue.b = cp.p2
      GROUP BY cp.employerId
    )
    SELECT
      jc.employerId,
      jc.n_jobs,
      jc.n_low, jc.n_hs, jc.n_bachelors, jc.n_graduate,
      jc.min_wage, jc.max_wage, jc.mean_wage, jc.median_wage,
      COALESCE(wd.n_employees, 0) AS n_employees,
      jc.n_jobs - COALESCE(wd.n_employees, 0) AS n_vacant,
      COALESCE(wd.mean_age, 0) AS mean_age,
      COALESCE(wd.emp_low, 0) AS emp_low,
      COALESCE(wd.emp_hs, 0) AS emp_hs,
      COALESCE(wd.emp_bachelors, 0) AS emp_bachelors,
      COALESCE(wd.emp_graduate, 0) AS emp_graduate,
      COALESCE(wd.emp_alone, 0) AS emp_alone,
      COALESCE(wd.emp_couple, 0) AS emp_couple,
      COALESCE(wd.emp_family, 0) AS emp_family,
      sc.days_pattern,
      sc.start_time,
      sc.end_time,
      COALESCE(c.cohesion_rate, 0) AS cohesion_rate,
      COALESCE(c.n_pairs, 0) AS coworker_pairs,
      COALESCE(c.n_friend_pairs, 0) AS coworker_friend_pairs,
      COALESCE(cm.mean_commute, 0) AS mean_commute
    FROM job_composition jc
    LEFT JOIN workforce_demo wd ON wd.employerId = jc.employerId
    LEFT JOIN schedule sc ON sc.employerId = jc.employerId
    LEFT JOIN commute cm ON cm.employerId = jc.employerId
    LEFT JOIN cohesion c ON c.employerId = jc.employerId
    ORDER BY jc.employerId
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "employer_profiles.json"),
    JSON.stringify(employerProfiles),
  );
  console.log(`  wrote employer_profiles.json (${employerProfiles.length} rows)`);

  // City-wide baselines for comparison in the detail card
  const baselines = coerce((await con.runAndReadAll(`
    WITH employees AS (
      SELECT participantId, venueId AS employerId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Workplace'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    ),
    coworker_pairs AS (
      SELECT e1.participantId AS p1, e2.participantId AS p2
      FROM employees e1
      JOIN employees e2
        ON e1.employerId = e2.employerId
       AND e1.participantId < e2.participantId
    ),
    unique_edges AS (
      SELECT LEAST(participantIdFrom, participantIdTo) AS a,
             GREATEST(participantIdFrom, participantIdTo) AS b
      FROM social_network
      GROUP BY a, b
    ),
    rate_calc AS (
      SELECT
        CAST(SUM(CASE WHEN ue.a IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS DOUBLE) AS city_cohesion_rate
      FROM coworker_pairs cp
      LEFT JOIN unique_edges ue ON ue.a = cp.p1 AND ue.b = cp.p2
    ),
    median_calc AS (
      SELECT CAST(MEDIAN(hourlyRate) AS DOUBLE) AS city_median_wage FROM jobs
    )
    SELECT rate_calc.city_cohesion_rate, median_calc.city_median_wage
    FROM rate_calc, median_calc
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "employer_baselines.json"),
    JSON.stringify(baselines[0] ?? { city_cohesion_rate: 0.65, city_median_wage: 12.5 }),
  );
  console.log("  wrote employer_baselines.json");

 // === Demographics: per-participant rent + spending + employer aggregates ===
  // Used by the demographics BI card to characterize selections by their
  // economic position (wage, rent, spending) and by which employers they
  // most often work at.
  console.log("computing demographics aggregates...");

  // Rent per participant: derived from their most-frequent apartment
  const rentByParticipant = coerce((await con.runAndReadAll(`
    WITH residence AS (
      SELECT participantId, venueId AS apartmentId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Apartment'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    )
    SELECT
      r.participantId,
      CAST(a.rentalCost AS DOUBLE) AS rent
    FROM residence r
    JOIN apartments a ON a.apartmentId = r.apartmentId
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "rent_by_participant.json"),
    JSON.stringify(rentByParticipant),
  );
  console.log(`  wrote rent_by_participant.json (${rentByParticipant.length} rows)`);

  // Spending per participant: average monthly amount per category from FinancialJournal.
  // Categories present in the journal: Food, Recreation, Shelter, Education, RentAdjustment, Wage
  // We summarize the four behavioral categories (Food/Recreation/Shelter/Education) as monthly avg.
  const spendingByParticipant = coerce((await con.runAndReadAll(`
    WITH monthly AS (
      SELECT
        participantId,
        category,
        DATE_TRUNC('month', timestamp) AS month,
        SUM(amount) AS total_amount
      FROM financial_journal
      WHERE category IN ('Food', 'Recreation', 'Shelter', 'Education')
      GROUP BY participantId, category, month
    ),
    avg_monthly AS (
      SELECT
        participantId,
        category,
        CAST(AVG(ABS(total_amount)) AS DOUBLE) AS avg_monthly_spend
      FROM monthly
      GROUP BY participantId, category
    )
    SELECT
      participantId,
      MAX(CASE WHEN category = 'Food' THEN avg_monthly_spend ELSE NULL END) AS food,
      MAX(CASE WHEN category = 'Recreation' THEN avg_monthly_spend ELSE NULL END) AS recreation,
      MAX(CASE WHEN category = 'Shelter' THEN avg_monthly_spend ELSE NULL END) AS shelter,
      MAX(CASE WHEN category = 'Education' THEN avg_monthly_spend ELSE NULL END) AS education
    FROM avg_monthly
    GROUP BY participantId
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "spending_by_participant.json"),
    JSON.stringify(spendingByParticipant),
  );
  console.log(`  wrote spending_by_participant.json (${spendingByParticipant.length} rows)`);

  // City-wide demographic baselines for KPI deltas
  const demoBaselines = coerce((await con.runAndReadAll(`
    WITH wage_per_participant AS (
      SELECT participantId, venueId AS employerId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Workplace'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    ),
    pid_to_wage AS (
      SELECT
        wp.participantId,
        CAST(MEDIAN(j.hourlyRate) AS DOUBLE) AS personal_wage
      FROM wage_per_participant wp
      JOIN jobs j ON j.employerId = wp.employerId
      GROUP BY wp.participantId
    ),
    rent_lookup AS (
      SELECT participantId, venueId AS apartmentId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Apartment'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    ),
    pid_to_rent AS (
      SELECT rl.participantId, CAST(a.rentalCost AS DOUBLE) AS rent
      FROM rent_lookup rl
      JOIN apartments a ON a.apartmentId = rl.apartmentId
    ),
    monthly_spend AS (
      SELECT
        category,
        DATE_TRUNC('month', timestamp) AS month,
        participantId,
        SUM(ABS(amount)) AS total
      FROM financial_journal
      WHERE category IN ('Food', 'Recreation', 'Shelter', 'Education')
      GROUP BY category, month, participantId
    ),
    spend_avg AS (
      SELECT
        category,
        CAST(AVG(total) AS DOUBLE) AS avg_monthly
      FROM monthly_spend
      GROUP BY category
    )
    SELECT
      (SELECT CAST(AVG(joviality) AS DOUBLE) FROM participants) AS mean_joviality,
      (SELECT CAST(MEDIAN(personal_wage) AS DOUBLE) FROM pid_to_wage) AS median_wage,
      (SELECT CAST(MEDIAN(rent) AS DOUBLE) FROM pid_to_rent) AS median_rent,
      (SELECT avg_monthly FROM spend_avg WHERE category = 'Food') AS food,
      (SELECT avg_monthly FROM spend_avg WHERE category = 'Recreation') AS recreation,
      (SELECT avg_monthly FROM spend_avg WHERE category = 'Shelter') AS shelter,
      (SELECT avg_monthly FROM spend_avg WHERE category = 'Education') AS education
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "demographics_baselines.json"),
    JSON.stringify(demoBaselines[0] ?? {}),
  );
  console.log("  wrote demographics_baselines.json");

  // Per-participant wage (median across the jobs at their workplace)
  // and the workplace's location for centroid math.
  const participantEconomics = coerce((await con.runAndReadAll(`
    WITH wp AS (
      SELECT participantId, venueId AS employerId
      FROM (
        SELECT participantId, venueId, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY COUNT(*) DESC) AS rn
        FROM checkin_journal
        WHERE venueType = 'Workplace'
        GROUP BY participantId, venueId
      )
      WHERE rn = 1
    )
    SELECT
      wp.participantId,
      wp.employerId,
      CAST(MEDIAN(j.hourlyRate) AS DOUBLE) AS personal_wage
    FROM wp
    JOIN jobs j ON j.employerId = wp.employerId
    GROUP BY wp.participantId, wp.employerId
  `)).getRowObjects());

  await writeFile(
    resolve(DERIVED, "participant_economics.json"),
    JSON.stringify(participantEconomics),
  );
  console.log(`  wrote participant_economics.json (${participantEconomics.length} rows)`);

  console.log("[derive] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
