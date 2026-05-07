/**
 * Q1 demographics endpoints.
 *
 * One file per challenge question keeps the API surface aligned with the
 * deliverable structure. Each route returns JSON shaped for direct D3
 * consumption — no client-side reshaping.
 */
import { Hono } from "hono";
import { query } from "../db.ts";

const app = new Hono();

/** Univariate distributions for the demographic columns. */
app.get("/distribution", async (c) => {
  const rows = await query(`
    SELECT participantId, age, educationLevel, householdSize,
           haveKids, joviality, interestGroup
    FROM participants
  `);
  return c.json(rows);
});

/** Mean joviality by education level — a starter cross-tab. */
app.get("/joviality-by-education", async (c) => {
  const rows = await query(`
    SELECT educationLevel,
           count(*)        AS n,
           avg(joviality)  AS mean_joviality,
           avg(age)        AS mean_age
    FROM participants
    GROUP BY educationLevel
    ORDER BY mean_joviality DESC
  `);
  return c.json(rows);
});

export default app;
