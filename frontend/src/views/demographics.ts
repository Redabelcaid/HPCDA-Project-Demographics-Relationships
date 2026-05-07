/**
 * Demographics view.
 *
 * Two modes:
 *   - No selection: shows population overview (age histogram + interest
 *     groups bar). Same charts as before, kept clickable.
 *   - With selection: shows a BI-style demographics card characterizing
 *     the selected participants — KPIs, age × education, household ×
 *     interest group, rent + spending profile, social fingerprint, and
 *     a bottom row with geographic centroid + top employers.
 *
 * The card adapts regardless of where the selection came from
 * (interest group click, building click, employer click, or — once
 * implemented — region lasso).
 */
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";

interface Participant {
  participantId: number;
  age: number;
  educationLevel: string;
  joviality: number;
  interestGroup: string;
  householdSize?: number;
  household_size?: number;
  haveKids: boolean;
}

interface InterestGroup {
  interestGroup: string;
  n: number;
  mean_joviality: number;
}

interface RentRow {
  participantId: number;
  rent: number;
}

interface SpendingRow {
  participantId: number;
  food: number | null;
  recreation: number | null;
  shelter: number | null;
  education: number | null;
}

interface ParticipantEconomicsRow {
  participantId: number;
  employerId: number;
  personal_wage: number;
}

interface SocialSummary {
  participantId: number;
  degree: number;
  total_interactions: number;
}

interface ResidencyRow {
  participantId: number;
  buildingId: number;
  centroidX: number;
  centroidY: number;
}

interface Baselines {
  mean_joviality: number;
  median_wage: number;
  median_rent: number;
  food: number;
  recreation: number;
  shelter: number;
  education: number;
}

const EDU_ORDER = ["Low", "HighSchoolOrCollege", "Bachelors", "Graduate"];
const EDU_LABEL: Record<string, string> = {
  Low: "Low",
  HighSchoolOrCollege: "HS/Coll",
  Bachelors: "Bachelor",
  Graduate: "Graduate",
};
const EDU_COLOR: Record<string, string> = {
  Low: "#a8dcc7",
  HighSchoolOrCollege: "#3aa28a",
  Bachelors: "#22c597",
  Graduate: "#0e3d33",
};

const HH_COLOR = {
  alone: "#5e7a8c",
  couple: "#3aa28a",
  family: "#0e3d33",
};

const SPEND_COLOR: Record<string, string> = {
  Food: "#3aa28a",
  Recreation: "#22c597",
  Shelter: "#0e3d33",
  Education: "#5e7a8c",
};

const AGE_BANDS: Array<{ label: string; lo: number; hi: number }> = [
  { label: "18-24", lo: 18, hi: 24 },
  { label: "25-34", lo: 25, hi: 34 },
  { label: "35-44", lo: 35, hi: 44 },
  { label: "45-54", lo: 45, hi: 54 },
  { label: "55+", lo: 55, hi: 200 },
];

interface ParticipantData {
  participants: Participant[];
  groups: InterestGroup[];
  rent: Map<number, number>;
  spending: Map<number, SpendingRow>;
  economics: Map<number, ParticipantEconomicsRow>;
  social: Map<number, SocialSummary>;
  residency: Map<number, ResidencyRow>;
  baselines: Baselines;
}

let cachedData: ParticipantData | null = null;

export async function renderDemographics(container: HTMLElement) {
  // Fetch every dataset the card needs, plus the existing two for the
  // fallback overview charts. Tolerate failures in optional data so the
  // card still renders something even if e.g. residency JSON is missing.
  const [
    participants,
    groups,
    rentRows,
    spendingRows,
    economicsRows,
    socialRows,
    residencyRows,
    baselines,
  ] = await Promise.all([
    apiGet<Participant[]>("/derived/participants.json"),
    apiGet<InterestGroup[]>("/derived/interest_groups.json"),
    apiGet<RentRow[]>("/derived/rent_by_participant.json").catch(() => [] as RentRow[]),
    apiGet<SpendingRow[]>("/derived/spending_by_participant.json").catch(() => [] as SpendingRow[]),
    apiGet<ParticipantEconomicsRow[]>("/derived/participant_economics.json").catch(() => [] as ParticipantEconomicsRow[]),
    apiGet<SocialSummary[]>("/derived/social_summary.json").catch(() => [] as SocialSummary[]),
    apiGet<ResidencyRow[]>("/derived/residency.json").catch(() => [] as ResidencyRow[]),
    apiGet<Baselines>("/derived/demographics_baselines.json").catch(() => ({
      mean_joviality: 0.49,
      median_wage: 15,
      median_rent: 1200,
      food: 200, recreation: 100, shelter: 1000, education: 50,
    })),
  ]);

  cachedData = {
    participants,
    groups,
    rent: new Map(rentRows.map((r) => [r.participantId, r.rent])),
    spending: new Map(spendingRows.map((r) => [r.participantId, r])),
    economics: new Map(economicsRows.map((r) => [r.participantId, r])),
    social: new Map(socialRows.map((r) => [r.participantId, r])),
    residency: new Map(
      Array.isArray(residencyRows)
        ? residencyRows
            .filter((r: any) => r && Number.isFinite(r.participantId))
            .map((r: any) => [
              r.participantId,
              {
                participantId: r.participantId,
                buildingId: r.buildingId ?? 0,
                centroidX: Number.isFinite(r.centroidX) ? r.centroidX : (r.x ?? 0),
                centroidY: Number.isFinite(r.centroidY) ? r.centroidY : (r.y ?? 0),
              } as ResidencyRow,
            ])
        : [],
    ),
    baselines,
  };

  // The "host" element is wiped and rebuilt on every selection change.
  // It's separate from the section's <h2> header so the title stays.
  const host = document.createElement("div");
  host.id = "demographics-host";
  host.style.cssText = "display:flex;flex-direction:column;gap:12px;";
  container.appendChild(host);

  function rerender(sel: { isEmpty: boolean; participantIds: Set<number> }) {
    host.innerHTML = "";
    // Overview always visible at the top
    renderOverview(host, cachedData!);
    // Card appears below the overview only when there's an active selection
    if (!sel.isEmpty) {
      const divider = document.createElement("div");
      divider.style.cssText = "border-top: 1px solid var(--border-subtle); margin: 8px 0 4px 0;";
      host.appendChild(divider);
      const ids = Array.from(sel.participantIds);
      renderCard(host, cachedData!, ids);
    }
  }

  selection.subscribe(rerender);
}

// ---------------------------------------------------------------------
// Overview mode (no selection): age histogram + interest groups bar
// ---------------------------------------------------------------------

function renderOverview(host: HTMLElement, data: ParticipantData) {
  drawAgeHistogram(host, data.participants);
  drawInterestGroups(host, data.groups, data.participants);
}

function drawAgeHistogram(container: HTMLElement, participants: Participant[]) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Age distribution</div>`;
  container.appendChild(wrap);

  const w = 460, h = 140;
  const margin = { top: 10, right: 10, bottom: 24, left: 30 };

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto");

  const gradId = "age-bar-gradient";
  const grad = svg.append("defs").append("linearGradient")
    .attr("id", gradId).attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#3aa28a");
  grad.append("stop").attr("offset", "100%").attr("stop-color", "#0e3d33");

  const ages = participants.map((p) => p.age);
  const x = d3.scaleLinear()
    .domain(d3.extent(ages) as [number, number]).nice()
    .range([margin.left, w - margin.right]);

  const bins = d3.bin().domain(x.domain() as [number, number]).thresholds(20)(ages);

  const y = d3.scaleLinear()
    .domain([0, d3.max(bins, (b) => b.length) ?? 0]).nice()
    .range([h - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(6).tickSizeOuter(0));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSizeOuter(0));

  svg.append("g")
    .selectAll("rect")
    .data(bins)
    .join("rect")
    .attr("x", (d) => x(d.x0!) + 1)
    .attr("y", (d) => y(d.length))
    .attr("width", (d) => Math.max(0, x(d.x1!) - x(d.x0!) - 2))
    .attr("height", (d) => Math.max(0, h - margin.bottom - y(d.length)))
    .attr("rx", 2)
    .attr("fill", `url(#${gradId})`);
}

function drawInterestGroups(
  container: HTMLElement,
  groups: InterestGroup[],
  participants: Participant[],
) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Interest groups (size; color = mean joviality, click to filter)</div>`;
  container.appendChild(wrap);

  const w = 460, h = 200;
  const margin = { top: 10, right: 10, bottom: 24, left: 30 };

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto");

  const sorted = [...groups].sort((a, b) => b.n - a.n);
  const x = d3.scaleBand()
    .domain(sorted.map((g) => g.interestGroup))
    .range([margin.left, w - margin.right])
    .padding(0.18);

  const y = d3.scaleLinear()
    .domain([0, d3.max(sorted, (g) => g.n) ?? 0]).nice()
    .range([h - margin.bottom, margin.top]);

  const color = d3.scaleLinear<string>()
    .domain([0.42, 0.50, 0.56])
    .range(["#a83232", "#e8e2c8", "#22c597"])
    .clamp(true);

  svg.append("g")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));

  const idsByGroup = new Map<string, number[]>();
  for (const p of participants) {
    if (!idsByGroup.has(p.interestGroup)) idsByGroup.set(p.interestGroup, []);
    idsByGroup.get(p.interestGroup)!.push(p.participantId);
  }

  svg.append("g")
    .selectAll<SVGRectElement, InterestGroup>("rect")
    .data(sorted)
    .join("rect")
    .attr("x", (d) => x(d.interestGroup) ?? 0)
    .attr("y", (d) => y(d.n))
    .attr("width", x.bandwidth())
    .attr("height", (d) => h - margin.bottom - y(d.n))
    .attr("rx", 3)
    .attr("fill", (d) => color(d.mean_joviality))
    .style("cursor", "pointer")
    .on("click", (_event, d) => {
      const ids = idsByGroup.get(d.interestGroup) ?? [];
      if (ids.length > 0) selection.setIds(ids, { kind: "chart" });
    });
}

// ---------------------------------------------------------------------
// Card mode (selection active): BI-style demographics card
// ---------------------------------------------------------------------

function renderCard(host: HTMLElement, data: ParticipantData, ids: number[]) {
  const idSet = new Set(ids);
  const selected = data.participants.filter((p) => idSet.has(p.participantId));
  if (selected.length === 0) {
    renderOverview(host, data);
    return;
  }

  // ---- KPI tiles ----
  const meanJov = d3.mean(selected, (p) => p.joviality) ?? 0;
  const wages: number[] = [];
  for (const p of selected) {
    const e = data.economics.get(p.participantId);
    if (e) wages.push(e.personal_wage);
  }
  const medianWage = wages.length ? d3.median(wages)! : 0;

  const jovDelta = meanJov - data.baselines.mean_joviality;
  const wageDelta = medianWage - data.baselines.median_wage;

  const kpiRow = document.createElement("div");
  kpiRow.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;";
  kpiRow.appendChild(makeKPI("Selected", String(selected.length), "participants"));
  kpiRow.appendChild(makeKPI(
    "Mean joviality",
    meanJov.toFixed(2),
    deltaSpan(jovDelta, 2, "vs city"),
  ));
  kpiRow.appendChild(makeKPI(
    "Median wage",
    `$${medianWage.toFixed(0)}/hr`,
    deltaSpan(wageDelta, 1, "vs city"),
  ));
  host.appendChild(kpiRow);

  // ---- 2x2 chart grid ----
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:10px;";
  grid.appendChild(makeAgeEducationTile(selected));
  grid.appendChild(makeHouseholdGroupTile(selected));
  grid.appendChild(makeRentSpendingTile(selected, data));
  grid.appendChild(makeSocialFingerprintTile(selected, data));
  host.appendChild(grid);

  // ---- Bottom info row: geographic centroid + top employers ----
  const info = document.createElement("div");
  info.style.cssText = `
    margin-top: 4px;
    padding: 8px 10px;
    background: var(--bg-elevated);
    border-radius: 5px;
    font-size: 11px;
    color: var(--text-secondary);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `;

  // Geographic centroid + spread
  const points: Array<[number, number]> = [];
  for (const p of selected) {
    const r = data.residency.get(p.participantId);
    if (r && Number.isFinite(r.centroidX) && Number.isFinite(r.centroidY)) {
      points.push([r.centroidX, r.centroidY]);
    }
  }
  let geoLabel = "—";
  if (points.length > 0) {
    const cx = d3.mean(points, (d) => d[0])!;
    const cy = d3.mean(points, (d) => d[1])!;
    const dists = points.map(([x, y]) => Math.hypot(x - cx, y - cy));
    const meanRadius = d3.mean(dists) ?? 0;
    geoLabel = `centroid ≈ (${cx.toFixed(0)}, ${cy.toFixed(0)})<br>spread ≈ ${(meanRadius / 1000).toFixed(2)} km`;
  }

  // Top 3 employers
  const employerCounts = new Map<number, number>();
  for (const p of selected) {
    const e = data.economics.get(p.participantId);
    if (e) {
      employerCounts.set(e.employerId, (employerCounts.get(e.employerId) ?? 0) + 1);
    }
  }
  const topEmployers = Array.from(employerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const topEmployersLabel = topEmployers.length
    ? topEmployers.map(([id, n]) => `#${id} <span style="color:var(--text-tertiary)">(${n})</span>`).join(" · ")
    : "—";

  info.innerHTML = `
    <div>
      <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">Geographic spread</div>
      ${geoLabel}
    </div>
    <div>
      <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px;">Top employers</div>
      ${topEmployersLabel}
    </div>
  `;
  host.appendChild(info);
}

function deltaSpan(delta: number, digits: number, suffix: string): string {
  const color = delta >= 0 ? "#1f6f5e" : "#a83232";
  const sign = delta >= 0 ? "+" : "";
  return `<span style="color:${color}">${sign}${delta.toFixed(digits)}</span> <span style="color:var(--text-tertiary)">${suffix}</span>`;
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

// Tile: Age × Education (stacked horizontal bar per age band)
function makeAgeEducationTile(selected: Participant[]): HTMLElement {
  const tile = makeTile("Age × education");

  // Tally each (age band, education) bucket
  const counts = new Map<string, Map<string, number>>();
  for (const band of AGE_BANDS) counts.set(band.label, new Map());
  for (const p of selected) {
    const band = AGE_BANDS.find((b) => p.age >= b.lo && p.age <= b.hi);
    if (!band) continue;
    const m = counts.get(band.label)!;
    m.set(p.educationLevel, (m.get(p.educationLevel) ?? 0) + 1);
  }

  for (const band of AGE_BANDS) {
    const m = counts.get(band.label)!;
    const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:3px;color:var(--text-secondary);";
    const label = document.createElement("div");
    label.style.cssText = "width:38px;font-variant-numeric:tabular-nums;";
    label.textContent = band.label;
    row.appendChild(label);
    const bar = document.createElement("div");
    bar.style.cssText = "flex:1;background:var(--bg-elevated);border-radius:3px;height:12px;display:flex;overflow:hidden;";
    if (total > 0) {
      for (const edu of EDU_ORDER) {
        const n = m.get(edu) ?? 0;
        if (n === 0) continue;
        const seg = document.createElement("div");
        seg.style.cssText = `flex:${n};background:${EDU_COLOR[edu]};`;
        seg.title = `${band.label}, ${EDU_LABEL[edu]}: ${n}`;
        bar.appendChild(seg);
      }
    }
    row.appendChild(bar);
    const totalLabel = document.createElement("div");
    totalLabel.style.cssText = "width:22px;text-align:right;color:var(--text-primary);font-variant-numeric:tabular-nums;";
    totalLabel.textContent = String(total);
    row.appendChild(totalLabel);
    tile.appendChild(row);
  }
  return tile;
}

// Tile: Household composition (alone/couple/family) + interest group spread
function makeHouseholdGroupTile(selected: Participant[]): HTMLElement {
  const tile = makeTile("Household × interest group");

  // Household composition stacked bar
  const hh = { alone: 0, couple: 0, family: 0 };
  for (const p of selected) {
    const size = p.household_size ?? p.householdSize ?? 1;
    if (p.haveKids) hh.family++;
    else if (size === 1) hh.alone++;
    else hh.couple++;
  }
  const hhTotal = hh.alone + hh.couple + hh.family || 1;
  const hhBar = document.createElement("div");
  hhBar.style.cssText = "display:flex;height:14px;border-radius:3px;overflow:hidden;border:1px solid var(--border-subtle);margin-bottom:6px;";
  for (const [k, v, c] of [["Alone", hh.alone, HH_COLOR.alone], ["Couple", hh.couple, HH_COLOR.couple], ["Family", hh.family, HH_COLOR.family]] as const) {
    if (v === 0) continue;
    const seg = document.createElement("div");
    seg.style.cssText = `flex:${v};background:${c};`;
    seg.title = `${k}: ${v}`;
    hhBar.appendChild(seg);
  }
  tile.appendChild(hhBar);

  const hhLegend = document.createElement("div");
  hhLegend.style.cssText = "font-size:10px;color:var(--text-tertiary);display:flex;gap:8px;margin-bottom:8px;";
  hhLegend.innerHTML = `
    <span><span style="display:inline-block;width:8px;height:8px;background:${HH_COLOR.alone};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>Alone ${((hh.alone / hhTotal) * 100).toFixed(0)}%</span>
    <span><span style="display:inline-block;width:8px;height:8px;background:${HH_COLOR.couple};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>Couple ${((hh.couple / hhTotal) * 100).toFixed(0)}%</span>
    <span><span style="display:inline-block;width:8px;height:8px;background:${HH_COLOR.family};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>Family ${((hh.family / hhTotal) * 100).toFixed(0)}%</span>
  `;
  tile.appendChild(hhLegend);

  // Interest group mini-bars (top 3 groups in selection)
  const groupCounts = new Map<string, number>();
  for (const p of selected) {
    groupCounts.set(p.interestGroup, (groupCounts.get(p.interestGroup) ?? 0) + 1);
  }
  const sortedGroups = Array.from(groupCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topGroups = sortedGroups.slice(0, 5);
  const maxCount = topGroups.length ? topGroups[0][1] : 1;

  const ghLabel = document.createElement("div");
  ghLabel.style.cssText = "font-size:10px;color:var(--text-tertiary);margin-bottom:3px;";
  ghLabel.textContent = "Top interest groups";
  tile.appendChild(ghLabel);

  for (const [group, n] of topGroups) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;margin-bottom:2px;";
    row.innerHTML = `
      <div style="width:14px;font-weight:600;color:var(--text-primary);">${group}</div>
      <div style="flex:1;background:var(--bg-elevated);border-radius:2px;height:8px;position:relative;overflow:hidden;">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${(n / maxCount) * 100}%;background:#3aa28a;"></div>
      </div>
      <div style="width:24px;text-align:right;color:var(--text-secondary);font-variant-numeric:tabular-nums;">${n}</div>
    `;
    tile.appendChild(row);
  }
  return tile;
}

// Tile: Rent paid + spending profile
function makeRentSpendingTile(selected: Participant[], data: ParticipantData): HTMLElement {
  const tile = makeTile("Rent + monthly spending");

  // Median rent paid by selected
  const rents = selected.map((p) => data.rent.get(p.participantId)).filter((r): r is number => Number.isFinite(r as number));
  const medianRent = rents.length ? d3.median(rents)! : 0;
  const rentDelta = medianRent - data.baselines.median_rent;

  const rentRow = document.createElement("div");
  rentRow.style.cssText = "display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px;";
  rentRow.innerHTML = `
    <span style="color:var(--text-secondary);">Median rent</span>
    <span style="font-variant-numeric:tabular-nums;color:var(--text-primary);font-weight:600;">
      $${medianRent.toFixed(0)} <span style="font-weight:400;font-size:10px;">${deltaSpan(rentDelta, 0, "")}</span>
    </span>
  `;
  tile.appendChild(rentRow);

  // Average spending across categories for the selection
  const cats = ["Food", "Recreation", "Shelter", "Education"] as const;
  const spendingMeans: Record<string, number> = {};
  for (const cat of cats) {
    const key = cat.toLowerCase() as "food" | "recreation" | "shelter" | "education";
    const vals = selected
      .map((p) => data.spending.get(p.participantId)?.[key])
      .filter((v): v is number => Number.isFinite(v as number));
    spendingMeans[cat] = vals.length ? d3.mean(vals)! : 0;
  }

  // Stacked horizontal bar showing spending mix
  const total = Object.values(spendingMeans).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const label = document.createElement("div");
    label.style.cssText = "font-size:10px;color:var(--text-tertiary);margin-bottom:3px;";
    label.textContent = "Avg monthly spending";
    tile.appendChild(label);

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;height:12px;border-radius:3px;overflow:hidden;border:1px solid var(--border-subtle);margin-bottom:5px;";
    for (const cat of cats) {
      const v = spendingMeans[cat];
      if (v === 0) continue;
      const seg = document.createElement("div");
      seg.style.cssText = `flex:${v};background:${SPEND_COLOR[cat]};`;
      seg.title = `${cat}: $${v.toFixed(0)}/mo`;
      bar.appendChild(seg);
    }
    tile.appendChild(bar);

    const legend = document.createElement("div");
    legend.style.cssText = "font-size:9px;color:var(--text-tertiary);display:flex;flex-wrap:wrap;gap:6px;";
    for (const cat of cats) {
      const v = spendingMeans[cat];
      if (v === 0) continue;
      const sp = document.createElement("span");
      sp.innerHTML = `<span style="display:inline-block;width:6px;height:6px;background:${SPEND_COLOR[cat]};border-radius:1px;margin-right:2px;vertical-align:middle;"></span>${cat} $${v.toFixed(0)}`;
      legend.appendChild(sp);
    }
    tile.appendChild(legend);
  } else {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:10px;color:var(--text-tertiary);font-style:italic;";
    empty.textContent = "No spending data for this selection.";
    tile.appendChild(empty);
  }
  return tile;
}

// Tile: Social fingerprint — mean degree + total interactions
function makeSocialFingerprintTile(selected: Participant[], data: ParticipantData): HTMLElement {
  const tile = makeTile("Social fingerprint");

  const degrees = selected.map((p) => data.social.get(p.participantId)?.degree).filter((d): d is number => Number.isFinite(d as number));
  const interactions = selected.map((p) => data.social.get(p.participantId)?.total_interactions).filter((d): d is number => Number.isFinite(d as number));

  const meanDegree = degrees.length ? d3.mean(degrees)! : 0;
  const meanInter = interactions.length ? d3.mean(interactions)! : 0;

  const row1 = document.createElement("div");
  row1.style.cssText = "display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;";
  row1.innerHTML = `
    <span style="color:var(--text-secondary);">Mean degree</span>
    <span style="font-variant-numeric:tabular-nums;color:var(--text-primary);font-weight:600;">${meanDegree.toFixed(0)}</span>
  `;
  tile.appendChild(row1);

  const row2 = document.createElement("div");
  row2.style.cssText = "display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px;";
  row2.innerHTML = `
    <span style="color:var(--text-secondary);">Mean interactions</span>
    <span style="font-variant-numeric:tabular-nums;color:var(--text-primary);font-weight:600;">${meanInter.toFixed(0)}</span>
  `;
  tile.appendChild(row2);

  // Mini distribution of degree as a sparkline-ish bar strip
  if (degrees.length > 0) {
    const w = 180, h = 28;
    const margin = { top: 2, right: 2, bottom: 2, left: 2 };
    const svg = d3.select(tile).append("svg")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .style("width", "100%")
      .style("height", "auto");
    const x = d3.scaleLinear()
      .domain([0, d3.max(degrees) ?? 1])
      .range([margin.left, w - margin.right]);
    const bins = d3.bin().domain(x.domain() as [number, number]).thresholds(15)(degrees);
    const y = d3.scaleLinear()
      .domain([0, d3.max(bins, (b) => b.length) ?? 1])
      .range([h - margin.bottom, margin.top]);

    svg.append("g")
      .selectAll("rect")
      .data(bins)
      .join("rect")
      .attr("x", (d) => x(d.x0!))
      .attr("y", (d) => y(d.length))
      .attr("width", (d) => Math.max(0, x(d.x1!) - x(d.x0!) - 1))
      .attr("height", (d) => Math.max(0, h - margin.bottom - y(d.length)))
      .attr("fill", "#3aa28a");
    const label = document.createElement("div");
    label.style.cssText = "font-size:9px;color:var(--text-tertiary);text-align:center;margin-top:2px;";
    label.textContent = "Degree distribution";
    tile.appendChild(label);
  }

  return tile;
}
