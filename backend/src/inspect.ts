/**
 * One-off investigation script for ad-hoc data exploration.
 * Add new sections at the bottom of main() as questions come up.
 *
 * Run via: npm run inspect
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");
const PROCESSED = resolve(DATA_DIR, "processed");

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

  console.log("\n=== Social network edge structure ===");
  const edgeStats = await con.runAndReadAll(`
    SELECT
      count(*)                                              AS total_rows,
      count(DISTINCT participantIdFrom)                     AS distinct_sources,
      count(DISTINCT participantIdTo)                       AS distinct_targets,
      count(DISTINCT (participantIdFrom, participantIdTo))  AS distinct_edges
    FROM social_network
  `);
  console.table(coerce(edgeStats.getRowObjects()));

  console.log("\n=== Reciprocity check (is graph directed or symmetric?) ===");
  const reciprocity = await con.runAndReadAll(`
    WITH pairs AS (
      SELECT DISTINCT participantIdFrom AS a, participantIdTo AS b
      FROM social_network
    ),
    reciprocal AS (
      SELECT count(*) AS n
      FROM pairs p1
      WHERE EXISTS (
        SELECT 1 FROM pairs p2
        WHERE p2.a = p1.b AND p2.b = p1.a
      )
    ),
    total AS (SELECT count(*) AS n FROM pairs)
    SELECT
      total.n                                            AS total_directed_edges,
      reciprocal.n                                       AS reciprocal_edges,
      reciprocal.n * 1.0 / total.n                       AS reciprocity_rate
    FROM total, reciprocal
  `);
  console.table(coerce(reciprocity.getRowObjects()));

  console.log("\n=== Interaction count distribution per pair ===");
  const distribution = await con.runAndReadAll(`
    WITH pair_counts AS (
      SELECT participantIdFrom, participantIdTo, count(*) AS n
      FROM social_network
      GROUP BY participantIdFrom, participantIdTo
    )
    SELECT
      min(n)                       AS min_interactions,
      quantile_cont(n, 0.25)       AS p25,
      median(n)                    AS p50,
      quantile_cont(n, 0.75)       AS p75,
      quantile_cont(n, 0.95)       AS p95,
      quantile_cont(n, 0.99)       AS p99,
      max(n)                       AS max_interactions,
      avg(n)                       AS mean_interactions
    FROM pair_counts
  `);
  console.table(coerce(distribution.getRowObjects()));

  console.log("\n=== Interactions by hour of day (sanity check) ===");
  const temporal = await con.runAndReadAll(`
    SELECT
      EXTRACT(hour FROM timestamp) AS hour,
      count(*) AS n
    FROM social_network
    GROUP BY hour
    ORDER BY hour
  `);
  console.table(coerce(temporal.getRowObjects()));


  console.log("\n=== Q3: Employers and jobs ===");

  console.log("\n--- Employer counts ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT count(*) AS n_employers FROM employers
  `)).getRowObjects()));

  console.log("\n--- Jobs schema and sample ---");
  console.table(coerce((await con.runAndReadAll("DESCRIBE jobs")).getRowObjects()));
  const jobSample = (await con.runAndReadAll("SELECT * FROM jobs LIMIT 3")).getRowObjects();
  for (const row of coerce(jobSample)) {
    console.log(JSON.stringify(row));
  }

  console.log("\n--- Wage distribution by education requirement ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      educationRequirement,
      count(*) AS n_jobs,
      CAST(min(hourlyRate)    AS DOUBLE) AS min_wage,
      CAST(median(hourlyRate) AS DOUBLE) AS median_wage,
      CAST(avg(hourlyRate)    AS DOUBLE) AS mean_wage,
      CAST(max(hourlyRate)    AS DOUBLE) AS max_wage
    FROM jobs
    GROUP BY educationRequirement
    ORDER BY median_wage DESC
  `)).getRowObjects()));

  console.log("\n--- Employer concentration: top 15 by job count ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      employerId,
      count(*)                          AS n_jobs,
      CAST(avg(hourlyRate)  AS DOUBLE)  AS avg_wage,
      CAST(min(hourlyRate)  AS DOUBLE)  AS min_wage,
      CAST(max(hourlyRate)  AS DOUBLE)  AS max_wage
    FROM jobs
    GROUP BY employerId
    ORDER BY n_jobs DESC
    LIMIT 15
  `)).getRowObjects()));

  console.log("\n--- Total employment vs total jobs ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      count(*) AS total_jobs,
      count(DISTINCT employerId) AS total_employers,
      CAST(avg(jobs_per_emp) AS DOUBLE) AS mean_jobs_per_employer,
      max(jobs_per_emp) AS max_jobs_per_employer
    FROM (
      SELECT employerId, count(*) AS jobs_per_emp FROM jobs GROUP BY employerId
    )
  `)).getRowObjects()));

  console.log("\n--- Days-of-week patterns (any unusual schedules?) ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT daysToWork, count(*) AS n
    FROM jobs
    GROUP BY daysToWork
    ORDER BY n DESC
    LIMIT 10
  `)).getRowObjects()));

  console.log("\n--- Wage in FinancialJournal vs hourlyRate listings ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      CAST(min(amount)    AS DOUBLE) AS min_wage_paid,
      CAST(median(amount) AS DOUBLE) AS median_wage_paid,
      CAST(avg(amount)    AS DOUBLE) AS mean_wage_paid,
      CAST(max(amount)    AS DOUBLE) AS max_wage_paid,
      count(*)                       AS n_payments
    FROM financial_journal
    WHERE category = 'Wage'
  `)).getRowObjects()));



  console.log("\n=== Workplace checkin venueId investigation ===");

  console.log("\n--- Sample workplace checkin venueIds ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT participantId, venueId, count(*) AS n
    FROM checkin_journal
    WHERE venueType = 'Workplace'
    GROUP BY participantId, venueId
    ORDER BY n DESC
    LIMIT 5
  `)).getRowObjects()));

  console.log("\n--- Range of venueIds in workplace checkins ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      CAST(min(venueId) AS INTEGER) AS min_id,
      CAST(max(venueId) AS INTEGER) AS max_id,
      count(DISTINCT venueId)       AS n_distinct
    FROM checkin_journal
    WHERE venueType = 'Workplace'
  `)).getRowObjects()));

  console.log("\n--- Are these venueIds buildingIds, employerIds, or jobIds? ---");
  console.log("\n  matches against buildings (residential vs commercial):");
  console.table(coerce((await con.runAndReadAll(`
    WITH workplace_ids AS (
      SELECT DISTINCT venueId AS id FROM checkin_journal WHERE venueType = 'Workplace'
    )
    SELECT b.buildingType, count(*) AS matches
    FROM workplace_ids w
    JOIN buildings b ON b.buildingId = w.id
    GROUP BY b.buildingType
  `)).getRowObjects()));

  console.log("\n  matches against employerIds:");
  console.table(coerce((await con.runAndReadAll(`
    WITH workplace_ids AS (
      SELECT DISTINCT venueId AS id FROM checkin_journal WHERE venueType = 'Workplace'
    )
    SELECT count(*) AS matches
    FROM workplace_ids w
    JOIN employers e ON e.employerId = w.id
  `)).getRowObjects()));

  console.log("\n  matches against jobIds:");
  console.table(coerce((await con.runAndReadAll(`
    WITH workplace_ids AS (
      SELECT DISTINCT venueId AS id FROM checkin_journal WHERE venueType = 'Workplace'
    )
    SELECT count(*) AS matches
    FROM workplace_ids w
    JOIN jobs j ON j.jobId = w.id
  `)).getRowObjects()));

  

  console.log("\n=== Job vacancy rate (estimated) ===");
  console.table(coerce((await con.runAndReadAll(`
    WITH workplace_employees AS (
      SELECT venueId AS employerId, count(DISTINCT participantId) AS n_employees
      FROM checkin_journal
      WHERE venueType = 'Workplace'
      GROUP BY venueId
    ),
    job_counts AS (
      SELECT employerId, count(*) AS n_jobs FROM jobs GROUP BY employerId
    )
    SELECT
      sum(j.n_jobs)                              AS total_jobs,
      sum(COALESCE(w.n_employees, 0))            AS total_filled,
      sum(j.n_jobs - COALESCE(w.n_employees, 0)) AS total_vacant,
      CAST(100.0 * sum(j.n_jobs - COALESCE(w.n_employees, 0)) / sum(j.n_jobs) AS DOUBLE) AS pct_vacant
    FROM job_counts j
    LEFT JOIN workplace_employees w ON w.employerId = j.employerId
  `)).getRowObjects()));




  console.log("\n=== Household composition × joviality check ===");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      CASE
        WHEN householdSize = 1 THEN 'alone'
        WHEN householdSize = 2 AND haveKids = false THEN 'couple'
        WHEN haveKids = true THEN 'family'
        ELSE 'other'
      END AS hh_type,
      count(*) AS n_participants,
      CAST(avg(joviality) AS DOUBLE) AS mean_joviality,
      CAST(stddev(joviality) AS DOUBLE) AS sd_joviality
    FROM participants
    GROUP BY hh_type
    ORDER BY mean_joviality DESC
  `)).getRowObjects()));

  console.log("\n=== Household structure breakdown ===");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      householdSize,
      haveKids,
      count(*) AS n,
      CAST(avg(joviality) AS DOUBLE) AS mean_joviality
    FROM participants
    GROUP BY householdSize, haveKids
    ORDER BY householdSize, haveKids
  `)).getRowObjects()));

  console.log("\n=== Joviality by has-kids ===");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      haveKids,
      count(*) AS n,
      CAST(avg(joviality) AS DOUBLE) AS mean_joviality,
      CAST(stddev(joviality) AS DOUBLE) AS sd_joviality
    FROM participants
    GROUP BY haveKids
  `)).getRowObjects()));

  console.log("\n=== Joviality vs household size (continuous) ===");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      householdSize,
      count(*) AS n,
      CAST(avg(joviality) AS DOUBLE) AS mean_joviality
    FROM participants
    GROUP BY householdSize
    ORDER BY householdSize
  `)).getRowObjects()));

  console.log("\n=== Joviality predictors check (all candidate pairs) ===");

  console.log("\n--- Joviality by education ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT educationLevel, count(*) AS n,
           CAST(avg(joviality) AS DOUBLE) AS mean_jov,
           CAST(stddev(joviality) AS DOUBLE) AS sd_jov
    FROM participants GROUP BY educationLevel
    ORDER BY mean_jov DESC
  `)).getRowObjects()));

  console.log("\n--- Joviality by interest group ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT interestGroup, count(*) AS n,
           CAST(avg(joviality) AS DOUBLE) AS mean_jov,
           CAST(stddev(joviality) AS DOUBLE) AS sd_jov
    FROM participants GROUP BY interestGroup
    ORDER BY mean_jov DESC
  `)).getRowObjects()));

  console.log("\n--- Joviality by age band ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      CASE
        WHEN age < 25 THEN '18-24'
        WHEN age < 35 THEN '25-34'
        WHEN age < 45 THEN '35-44'
        WHEN age < 55 THEN '45-54'
        ELSE '55-60'
      END AS age_band,
      count(*) AS n,
      CAST(avg(joviality) AS DOUBLE) AS mean_jov,
      CAST(stddev(joviality) AS DOUBLE) AS sd_jov
    FROM participants
    GROUP BY age_band
    ORDER BY age_band
  `)).getRowObjects()));

  console.log("\n--- Joviality by wage tier ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH employer_wage AS (
      SELECT employerId, CAST(avg(hourlyRate) AS DOUBLE) AS avg_wage
      FROM jobs GROUP BY employerId
    ),
    workplace_freq AS (
      SELECT participantId, venueId AS employerId, count(*) AS n
      FROM checkin_journal WHERE venueType = 'Workplace'
      GROUP BY participantId, venueId
    ),
    most_freq AS (
      SELECT participantId, employerId,
             ROW_NUMBER() OVER (PARTITION BY participantId ORDER BY n DESC) AS rn
      FROM workplace_freq
    )
    SELECT
      CASE
        WHEN ew.avg_wage IS NULL THEN 'unknown'
        WHEN ew.avg_wage < 15 THEN '$10-15'
        WHEN ew.avg_wage < 25 THEN '$15-25'
        WHEN ew.avg_wage < 40 THEN '$25-40'
        ELSE '$40+'
      END AS wage_tier,
      count(*) AS n,
      CAST(avg(p.joviality) AS DOUBLE) AS mean_jov,
      CAST(stddev(p.joviality) AS DOUBLE) AS sd_jov
    FROM participants p
    LEFT JOIN most_freq mf ON mf.participantId = p.participantId AND mf.rn = 1
    LEFT JOIN employer_wage ew ON ew.employerId = mf.employerId
    GROUP BY wage_tier
    ORDER BY mean_jov DESC
  `)).getRowObjects()));

  console.log("\n--- Joviality by social degree (number of friends) ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH degrees AS (
      SELECT participantId, count(DISTINCT partner) AS degree
      FROM (
        SELECT participantIdFrom AS participantId, participantIdTo AS partner
        FROM social_network
      )
      GROUP BY participantId
    )
    SELECT
      CASE
        WHEN degree < 50 THEN 'low (<50)'
        WHEN degree < 150 THEN 'mid (50-149)'
        WHEN degree < 250 THEN 'high (150-249)'
        ELSE 'very high (250+)'
      END AS degree_band,
      count(*) AS n,
      CAST(avg(p.joviality) AS DOUBLE) AS mean_jov,
      CAST(stddev(p.joviality) AS DOUBLE) AS sd_jov
    FROM participants p
    JOIN degrees d ON d.participantId = p.participantId
    GROUP BY degree_band
    ORDER BY mean_jov DESC
  `)).getRowObjects()));

  console.log("\n=== Item 1: Vanishing participants check ===");
  console.log("\n--- Last activity per participant (range) ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH last_seen AS (
      SELECT participantId, MAX(timestamp) AS last_ts
      FROM checkin_journal
      GROUP BY participantId
    ),
    bounds AS (
      SELECT MIN(timestamp) AS data_start, MAX(timestamp) AS data_end FROM checkin_journal
    )
    SELECT
      DATE_TRUNC('month', last_ts) AS last_month,
      COUNT(*) AS n_participants
    FROM last_seen
    GROUP BY last_month
    ORDER BY last_month
  `)).getRowObjects()));

  console.log("\n--- Demographic profile of vanished participants (last activity in first 60 days) ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH last_seen AS (
      SELECT participantId, MAX(timestamp) AS last_ts FROM checkin_journal
      GROUP BY participantId
    ),
    bounds AS (
      SELECT MIN(timestamp) AS data_start FROM checkin_journal
    ),
    classified AS (
      SELECT
        p.participantId,
        p.age,
        p.educationLevel,
        p.householdSize,
        p.haveKids,
        p.joviality,
        p.interestGroup,
        CASE WHEN ls.last_ts < (b.data_start + INTERVAL '60 days')
             THEN 'vanished' ELSE 'retained' END AS cohort
      FROM participants p
      LEFT JOIN last_seen ls ON ls.participantId = p.participantId
      CROSS JOIN bounds b
    )
    SELECT
      cohort,
      COUNT(*) AS n,
      CAST(AVG(age) AS DOUBLE) AS mean_age,
      CAST(AVG(joviality) AS DOUBLE) AS mean_jov,
      CAST(AVG(CASE WHEN haveKids THEN 1.0 ELSE 0.0 END) AS DOUBLE) AS pct_with_kids,
      CAST(AVG(CASE WHEN householdSize = 1 THEN 1.0 ELSE 0.0 END) AS DOUBLE) AS pct_living_alone
    FROM classified
    GROUP BY cohort
  `)).getRowObjects()));

  console.log("\n--- Vanished participants by education level ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH last_seen AS (
      SELECT participantId, MAX(timestamp) AS last_ts FROM checkin_journal
      GROUP BY participantId
    ),
    bounds AS (
      SELECT MIN(timestamp) AS data_start FROM checkin_journal
    ),
    vanished AS (
      SELECT p.participantId, p.educationLevel
      FROM participants p
      LEFT JOIN last_seen ls ON ls.participantId = p.participantId
      CROSS JOIN bounds b
      WHERE ls.last_ts IS NULL OR ls.last_ts < (b.data_start + INTERVAL '60 days')
    )
    SELECT educationLevel, COUNT(*) AS n_vanished
    FROM vanished
    GROUP BY educationLevel
    ORDER BY n_vanished DESC
  `)).getRowObjects()));

  console.log("\n=== Item 3: Pub vs Restaurant patterns ===");

  console.log("\n--- Visits by venue type and day of week ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      venueType,
      DAYNAME(timestamp) AS dow,
      COUNT(*) AS n_visits,
      COUNT(DISTINCT participantId) AS n_unique_visitors
    FROM checkin_journal
    WHERE venueType IN ('Pub', 'Restaurant')
    GROUP BY venueType, dow
    ORDER BY venueType, n_visits DESC
  `)).getRowObjects()));

  console.log("\n--- Weekend vs weekday concentration per venue type ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      venueType,
      CAST(SUM(CASE WHEN DAYOFWEEK(timestamp) IN (0, 6) THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS DOUBLE) AS weekend_share,
      COUNT(*) AS total_visits
    FROM checkin_journal
    WHERE venueType IN ('Pub', 'Restaurant')
    GROUP BY venueType
  `)).getRowObjects()));

  console.log("\n--- Top 5 most-visited pubs and restaurants ---");
  console.table(coerce((await con.runAndReadAll(`
    SELECT
      venueType,
      venueId,
      COUNT(*) AS n_visits,
      COUNT(DISTINCT participantId) AS n_unique_visitors,
      CAST(COUNT(*) * 1.0 / COUNT(DISTINCT participantId) AS DOUBLE) AS visits_per_visitor
    FROM checkin_journal
    WHERE venueType IN ('Pub', 'Restaurant')
    GROUP BY venueType, venueId
    ORDER BY venueType, n_visits DESC
    LIMIT 10
  `)).getRowObjects()));

  console.log("\n=== Item 4: Workplace social density ===");

  console.log("\n--- Coworker friendship rate vs random expectation ---");
  console.table(coerce((await con.runAndReadAll(`
    WITH employees AS (
      -- Each participant's most-frequent workplace
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
      SELECT e1.participantId AS p1, e2.participantId AS p2, e1.employerId
      FROM employees e1
      JOIN employees e2
        ON e1.employerId = e2.employerId
       AND e1.participantId < e2.participantId
    ),
    -- Edges symmetric: SocialNetwork has both (a,b) and (b,a)
    -- We only count unique pairs
    unique_edges AS (
      SELECT LEAST(participantIdFrom, participantIdTo) AS a,
             GREATEST(participantIdFrom, participantIdTo) AS b
      FROM social_network
      GROUP BY a, b
    ),
    coworker_friends AS (
      SELECT cp.*, CASE WHEN ue.a IS NOT NULL THEN 1 ELSE 0 END AS is_friend
      FROM coworker_pairs cp
      LEFT JOIN unique_edges ue
        ON ue.a = cp.p1 AND ue.b = cp.p2
    ),
    total_pairs AS (
      SELECT COUNT(*) * (COUNT(*) - 1) / 2 AS n_possible_pairs
      FROM employees
    ),
    total_edges AS (
      SELECT COUNT(*) AS n_edges FROM unique_edges
    )
    SELECT
      (SELECT COUNT(*) FROM coworker_pairs) AS coworker_pairs,
      (SELECT SUM(is_friend) FROM coworker_friends) AS coworker_friends,
      CAST((SELECT SUM(is_friend) FROM coworker_friends) * 1.0 /
           NULLIF((SELECT COUNT(*) FROM coworker_pairs), 0) AS DOUBLE) AS coworker_friendship_rate,
      CAST((SELECT n_edges FROM total_edges) * 1.0 /
           NULLIF((SELECT n_possible_pairs FROM total_pairs), 0) AS DOUBLE) AS overall_friendship_rate
  `)).getRowObjects()));

  console.log("\n--- Per-employer workplace social cohesion (top 10 most cohesive) ---");
  console.table(coerce((await con.runAndReadAll(`
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
    employer_size AS (
      SELECT employerId, COUNT(*) AS n_employees
      FROM employees
      GROUP BY employerId
    ),
    coworker_pairs AS (
      SELECT e1.participantId AS p1, e2.participantId AS p2, e1.employerId
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
      SELECT cp.employerId,
             COUNT(*) AS pairs,
             SUM(CASE WHEN ue.a IS NOT NULL THEN 1 ELSE 0 END) AS friend_pairs
      FROM coworker_pairs cp
      LEFT JOIN unique_edges ue ON ue.a = cp.p1 AND ue.b = cp.p2
      GROUP BY cp.employerId
    )
    SELECT
      c.employerId,
      es.n_employees,
      c.pairs,
      c.friend_pairs,
      CAST(c.friend_pairs * 1.0 / c.pairs AS DOUBLE) AS cohesion_rate
    FROM cohesion c
    JOIN employer_size es ON es.employerId = c.employerId
    WHERE c.pairs >= 3
    ORDER BY cohesion_rate DESC
    LIMIT 10
  `)).getRowObjects()));

  console.log("\n[inspect] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
