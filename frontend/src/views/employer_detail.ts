/**
 * Employer detail view — BI-style dashboard card, teal/emerald spine.
 *
 * KPI tiles for headline numbers, then a 2-column grid of small charts
 * showing job composition, wage distribution, workforce education and
 * household composition. Bottom row: schedule and commute.
 */
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";

interface EmployerProfile {
  employerId: number;
  n_jobs: number;
  n_low: number;
  n_hs: number;
  n_bachelors: number;
  n_graduate: number;
  min_wage: number;
  max_wage: number;
  mean_wage: number;
  median_wage: number;
  n_employees: number;
  n_vacant: number;
  mean_age: number;
  emp_low: number;
  emp_hs: number;
  emp_bachelors: number;
  emp_graduate: number;
  emp_alone: number;
  emp_couple: number;
  emp_family: number;
  days_pattern: string;
  start_time: string;
  end_time: string;
  cohesion_rate: number;
  coworker_pairs: number;
  coworker_friend_pairs: number;
  mean_commute: number;
}

interface Baselines {
  city_cohesion_rate: number;
  city_median_wage: number;
}

// Education ordinal — pale teal → vivid emerald → deep teal (matches business.ts)
const EDU_COLOR: Record<string, string> = {
  Low: "#a8dcc7",
  HighSchoolOrCollege: "#3aa28a",
  Bachelors: "#22c597",
  Graduate: "#0e3d33",
};

const EDU_LABEL: Record<string, string> = {
  Low: "Low",
  HighSchoolOrCollege: "HS/Coll",
  Bachelors: "Bachelor",
  Graduate: "Graduate",
};

// Household composition: three teal/sage tones
const HH_COLOR = {
  alone: "#5e7a8c",   // slate
  couple: "#3aa28a",  // mid teal
  family: "#0e3d33",  // deep teal
};

export async function renderEmployerDetail(container: HTMLElement) {
  const [profiles, baselines] = await Promise.all([
    apiGet<EmployerProfile[]>("/derived/employer_profiles.json"),
    apiGet<Baselines>("/derived/employer_baselines.json"),
  ]);

  const profileById = new Map(profiles.map((p) => [p.employerId, p]));

  const host = document.createElement("div");
  host.id = "employer-detail-host";
  container.appendChild(host);

  function renderPlaceholder() {
    host.innerHTML = `
      <div class="placeholder">
        Click an employer dot on the map to see its workforce structure.
      </div>
    `;
  }

  function renderCard(p: EmployerProfile) {
    host.innerHTML = "";

    const kpis = document.createElement("div");
    kpis.style.cssText = `
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    `;

    const wageGap = p.max_wage - p.min_wage;
    const cohesionDelta = p.cohesion_rate - baselines.city_cohesion_rate;
    const cohesionColor = cohesionDelta >= 0 ? "#1f6f5e" : "#a83232";
    const cohesionSign = cohesionDelta >= 0 ? "+" : "";

    kpis.appendChild(makeKPI("Jobs", String(p.n_jobs), `${p.n_employees} filled · ${p.n_vacant} open`));
    kpis.appendChild(makeKPI("Wage gap", `$${wageGap.toFixed(0)}`, `$${p.min_wage.toFixed(0)}–$${p.max_wage.toFixed(0)}/hr`));
    kpis.appendChild(makeKPI(
      "Coworker friendship",
      `${(p.cohesion_rate * 100).toFixed(0)}%`,
      `<span style="color:${cohesionColor}">${cohesionSign}${(cohesionDelta * 100).toFixed(0)}pp vs city</span>`,
    ));
    host.appendChild(kpis);

    const grid = document.createElement("div");
    grid.style.cssText = `
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    `;

    grid.appendChild(makeJobCompositionTile(p));
    grid.appendChild(makeWageDistributionTile(p, baselines));
    grid.appendChild(makeWorkforceEducationTile(p));
    grid.appendChild(makeHouseholdTile(p));

    host.appendChild(grid);

    const info = document.createElement("div");
    info.style.cssText = `
      margin-top: 10px;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border-radius: 5px;
      font-size: 11px;
      color: var(--text-secondary);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    `;
    info.innerHTML = `
      <div>
        <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">Schedule</div>
        ${formatSchedule(p.days_pattern, p.start_time, p.end_time)}
      </div>
      <div>
        <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">Commute</div>
        Avg ${(p.mean_commute / 1000).toFixed(2)} km · employees drawn from ${commuteRangeLabel(p.mean_commute)}
      </div>
    `;
    host.appendChild(info);
  }

  selection.subscribe((sel) => {
    if (sel.source && sel.source.kind === "employer") {
      const p = profileById.get(sel.source.employerId);
      if (p) {
        renderCard(p);
        return;
      }
    }
    renderPlaceholder();
  });

  renderPlaceholder();
}

function makeKPI(label: string, value: string, subtext: string): HTMLElement {
  const tile = document.createElement("div");
  tile.style.cssText = `
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 8px 10px;
  `;
  tile.innerHTML = `
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary);font-weight:600;">${label}</div>
    <div style="font-size:22px;font-weight:600;color:var(--teal-deep);font-variant-numeric:tabular-nums;line-height:1.2;margin-top:2px;">${value}</div>
    <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px;font-variant-numeric:tabular-nums;">${subtext}</div>
  `;
  return tile;
}

function makeTile(title: string): HTMLElement {
  const tile = document.createElement("div");
  tile.style.cssText = `
    background: var(--bg-section);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 8px 10px;
  `;
  const h = document.createElement("div");
  h.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary);font-weight:600;margin-bottom:6px;";
  h.textContent = title;
  tile.appendChild(h);
  return tile;
}

function makeJobCompositionTile(p: EmployerProfile): HTMLElement {
  const tile = makeTile("Job composition");
  const composition = [
    { edu: "Low", n: p.n_low, color: EDU_COLOR.Low },
    { edu: "HighSchoolOrCollege", n: p.n_hs, color: EDU_COLOR.HighSchoolOrCollege },
    { edu: "Bachelors", n: p.n_bachelors, color: EDU_COLOR.Bachelors },
    { edu: "Graduate", n: p.n_graduate, color: EDU_COLOR.Graduate },
  ].filter((c) => c.n > 0);

  for (const c of composition) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px;color:var(--text-secondary);";
    row.innerHTML = `
      <div style="width:60px;font-size:10px;">${EDU_LABEL[c.edu]}</div>
      <div style="flex:1;background:var(--bg-elevated);border-radius:3px;height:14px;position:relative;overflow:hidden;">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${(c.n / p.n_jobs) * 100}%;background:${c.color};border-radius:3px;"></div>
      </div>
      <div style="width:18px;text-align:right;font-variant-numeric:tabular-nums;font-weight:500;color:var(--text-primary);">${c.n}</div>
    `;
    tile.appendChild(row);
  }
  return tile;
}

function makeWageDistributionTile(p: EmployerProfile, baselines: Baselines): HTMLElement {
  const tile = makeTile("Wage distribution");
  const w = 200, h = 60;
  const margin = { top: 4, right: 6, bottom: 18, left: 6 };

  const svg = d3.select(tile).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto")
    .style("display", "block");

  const x = d3.scaleLinear()
    .domain([Math.min(p.min_wage, baselines.city_median_wage) - 2, Math.max(p.max_wage, 30) + 2])
    .range([margin.left, w - margin.right]);

  // Range bar in mid teal
  svg.append("rect")
    .attr("x", x(p.min_wage))
    .attr("y", h / 2 - 8)
    .attr("width", x(p.max_wage) - x(p.min_wage))
    .attr("height", 8)
    .attr("rx", 2)
    .attr("fill", "#3aa28a")
    .attr("fill-opacity", 0.5);

  // Median marker (employer) — deep teal
  svg.append("line")
    .attr("x1", x(p.median_wage))
    .attr("x2", x(p.median_wage))
    .attr("y1", h / 2 - 12)
    .attr("y2", h / 2 + 4)
    .attr("stroke", "#0e3d33")
    .attr("stroke-width", 2);

  // City median marker — slate dashed
  svg.append("line")
    .attr("x1", x(baselines.city_median_wage))
    .attr("x2", x(baselines.city_median_wage))
    .attr("y1", h / 2 - 10)
    .attr("y2", h / 2 + 2)
    .attr("stroke", "#5e7a8c")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "2,2");

  svg.append("text")
    .attr("x", x(p.min_wage))
    .attr("y", h - 4)
    .attr("text-anchor", "middle")
    .style("font-size", "9px")
    .style("fill", "var(--text-tertiary)")
    .text(`$${p.min_wage.toFixed(0)}`);
  svg.append("text")
    .attr("x", x(p.max_wage))
    .attr("y", h - 4)
    .attr("text-anchor", "middle")
    .style("font-size", "9px")
    .style("fill", "var(--text-tertiary)")
    .text(`$${p.max_wage.toFixed(0)}`);

  const legend = document.createElement("div");
  legend.style.cssText = "font-size:10px;color:var(--text-tertiary);margin-top:2px;font-variant-numeric:tabular-nums;";
  legend.innerHTML = `
    Median <strong style="color:var(--text-primary)">$${p.median_wage.toFixed(1)}</strong>/hr
    · City: $${baselines.city_median_wage.toFixed(1)}
  `;
  tile.appendChild(legend);
  return tile;
}

function makeWorkforceEducationTile(p: EmployerProfile): HTMLElement {
  const tile = makeTile("Workforce education");
  if (p.n_employees === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:10px;color:var(--text-tertiary);font-style:italic;";
    empty.textContent = "No employees identified.";
    tile.appendChild(empty);
    return tile;
  }
  const composition = [
    { edu: "Low", n: p.emp_low, color: EDU_COLOR.Low },
    { edu: "HighSchoolOrCollege", n: p.emp_hs, color: EDU_COLOR.HighSchoolOrCollege },
    { edu: "Bachelors", n: p.emp_bachelors, color: EDU_COLOR.Bachelors },
    { edu: "Graduate", n: p.emp_graduate, color: EDU_COLOR.Graduate },
  ].filter((c) => c.n > 0);

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;height:18px;border-radius:4px;overflow:hidden;margin-bottom:6px;border:1px solid var(--border-subtle);";
  for (const c of composition) {
    const seg = document.createElement("div");
    seg.style.cssText = `flex:${c.n};background:${c.color};display:flex;align-items:center;justify-content:center;font-size:10px;color:white;font-weight:600;`;
    seg.textContent = c.n >= 2 ? String(c.n) : "";
    seg.title = `${EDU_LABEL[c.edu]}: ${c.n}`;
    bar.appendChild(seg);
  }
  tile.appendChild(bar);

  const ageLabel = document.createElement("div");
  ageLabel.style.cssText = "font-size:10px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;";
  ageLabel.innerHTML = `Mean age <strong style="color:var(--text-primary)">${p.mean_age.toFixed(0)}</strong> · ${p.n_employees} employees`;
  tile.appendChild(ageLabel);
  return tile;
}

function makeHouseholdTile(p: EmployerProfile): HTMLElement {
  const tile = makeTile("Household composition");
  if (p.n_employees === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:10px;color:var(--text-tertiary);font-style:italic;";
    empty.textContent = "No employees identified.";
    tile.appendChild(empty);
    return tile;
  }
  const segments = [
    { label: "Alone", n: p.emp_alone, color: HH_COLOR.alone },
    { label: "Couple", n: p.emp_couple, color: HH_COLOR.couple },
    { label: "Family", n: p.emp_family, color: HH_COLOR.family },
  ].filter((s) => s.n > 0);
  const total = segments.reduce((a, s) => a + s.n, 0) || 1;

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;height:18px;border-radius:4px;overflow:hidden;margin-bottom:6px;border:1px solid var(--border-subtle);";
  for (const s of segments) {
    const seg = document.createElement("div");
    seg.style.cssText = `flex:${s.n};background:${s.color};display:flex;align-items:center;justify-content:center;font-size:10px;color:white;font-weight:600;`;
    seg.textContent = s.n >= 2 ? String(s.n) : "";
    seg.title = `${s.label}: ${s.n}`;
    bar.appendChild(seg);
  }
  tile.appendChild(bar);

  const legend = document.createElement("div");
  legend.style.cssText = "font-size:10px;color:var(--text-tertiary);display:flex;gap:10px;font-variant-numeric:tabular-nums;";
  for (const s of segments) {
    const span = document.createElement("span");
    span.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${s.color};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>${s.label} ${((s.n / total) * 100).toFixed(0)}%`;
    legend.appendChild(span);
  }
  tile.appendChild(legend);
  return tile;
}

function formatSchedule(daysPattern: string, startTime: string, endTime: string): string {
  if (!daysPattern) return "—";
  const isStandard = daysPattern.includes("Monday") &&
                     daysPattern.includes("Tuesday") &&
                     daysPattern.includes("Wednesday") &&
                     daysPattern.includes("Thursday") &&
                     daysPattern.includes("Friday") &&
                     !daysPattern.includes("Saturday") &&
                     !daysPattern.includes("Sunday");
  const label = isStandard ? "Mon–Fri (standard)" : "Mixed/weekend (unusual)";
  return `${label}<br>${startTime || "—"} – ${endTime || "—"}`;
}

function commuteRangeLabel(meanCommute: number): string {
  if (meanCommute < 1000) return "nearby";
  if (meanCommute < 3000) return "across district";
  return "across city";
}
