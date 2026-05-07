/**
 * Relations view — parallel sets / multipartite flow.
 *
 * Three columns: Education → Interest group → Wage tier.
 * Each column = stacked categorical bars sized by participant count.
 * Bands between columns = participants flowing between categories,
 * thickness proportional to count.
 *
 * Subscribes to the selection store. Clicking a category bar selects
 * all participants in it. Selection from elsewhere dims bands not
 * touching selection.
 */
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";
import type { Selection } from "../state.ts";

interface CategoricalRow {
  participantId: number;
  educationLevel: string;
  interestGroup: string;
  avg_wage: number | null;
  wage_tier: string;
}

// Column ordering — matters for visual flow. Education is ordered low→high,
// wage_tier is ordered ascending, interestGroup alphabetical.
const EDUCATION_ORDER = ["Low", "HighSchoolOrCollege", "Bachelors", "Graduate"];
const EDUCATION_LABEL: Record<string, string> = {
  Low: "Low",
  HighSchoolOrCollege: "HS / College",
  Bachelors: "Bachelors",
  Graduate: "Graduate",
};
const WAGE_ORDER = ["$10–$15", "$15–$25", "$25–$40", "$40+", "unknown"];
const INTEREST_COLORS: Record<string, string> = {
  A: "#1f77b4", B: "#ff7f0e", C: "#2ca02c", D: "#d62728", E: "#9467bd",
  F: "#8c564b", G: "#e377c2", H: "#7f7f7f", I: "#bcbd22", J: "#17becf",
};

export async function renderRelations(container: HTMLElement) {
  const data = await apiGet<CategoricalRow[]>("/derived/participant_categorical.json");

  // Empty container, build fresh
  container.innerHTML = "";
  container.style.position = "relative";

  const interestOrder = Array.from(new Set(data.map((d) => d.interestGroup))).sort();

  drawParallelSets(container, data, [
    { key: "educationLevel", title: "Education", order: EDUCATION_ORDER, label: (k) => EDUCATION_LABEL[k] ?? k },
    { key: "interestGroup", title: "Interest group", order: interestOrder, label: (k) => `Group ${k}` },
    { key: "wage_tier", title: "Wage tier", order: WAGE_ORDER, label: (k) => k },
  ]);
}

interface ColumnSpec {
  key: keyof CategoricalRow;
  title: string;
  order: string[];
  label: (k: string) => string;
}

function drawParallelSets(
  target: HTMLElement,
  data: CategoricalRow[],
  columns: ColumnSpec[],
) {
  const width = 900;
  const height = 720;
  const margin = { top: 50, right: 140, bottom: 30, left: 140 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const colX = columns.map((_, i) => margin.left + (i * innerW) / (columns.length - 1));
  const colWidth = 18;

  // Build per-column ordered category sizes (number of participants in each).
  type CatPos = {
    col: number;
    key: string;
    count: number;
    y0: number;  // top in pixels
    y1: number;  // bottom in pixels
    pids: Set<number>;
  };

  const columnCategories: CatPos[][] = columns.map((spec, ci) => {
    const counts = new Map<string, { count: number; pids: Set<number> }>();
    for (const k of spec.order) counts.set(k, { count: 0, pids: new Set() });
    for (const row of data) {
      const k = String(row[spec.key]);
      if (!counts.has(k)) continue;  // unknowns ignored if not in order
      const bucket = counts.get(k)!;
      bucket.count++;
      bucket.pids.add(row.participantId);
    }

    const total = [...counts.values()].reduce((s, b) => s + b.count, 0) || 1;
    const cats: CatPos[] = [];
    let y = 0;
    const padding = 4; // px between stacked bars
    const totalPadding = padding * (spec.order.length - 1);
    const usableH = innerH - totalPadding;
    for (const k of spec.order) {
      const b = counts.get(k)!;
      if (b.count === 0) continue;
      const h = (b.count / total) * usableH;
      cats.push({
        col: ci,
        key: k,
        count: b.count,
        y0: margin.top + y,
        y1: margin.top + y + h,
        pids: b.pids,
      });
      y += h + padding;
    }
    return cats;
  });

  // Build flows between adjacent columns.
  type Flow = {
    fromCol: number;
    fromKey: string;
    toKey: string;
    count: number;
    pids: Set<number>;
  };
  const flows: Flow[] = [];
  for (let ci = 0; ci < columns.length - 1; ci++) {
    const fromKey = columns[ci].key;
    const toKey = columns[ci + 1].key;
    const counts = new Map<string, { count: number; pids: Set<number> }>();
    for (const row of data) {
      const f = String(row[fromKey]);
      const t = String(row[toKey]);
      const compoundKey = `${f}||${t}`;
      if (!counts.has(compoundKey)) {
        counts.set(compoundKey, { count: 0, pids: new Set() });
      }
      const b = counts.get(compoundKey)!;
      b.count++;
      b.pids.add(row.participantId);
    }
    for (const [compound, b] of counts) {
      const [f, t] = compound.split("||");
      flows.push({ fromCol: ci, fromKey: f, toKey: t, count: b.count, pids: b.pids });
    }
  }

  // For each flow, figure out where on the source/target bars it attaches.
  // Sort flows within each source bar by target column ordering for clean ribbons.
  type Ribbon = Flow & {
    sourceY0: number;
    sourceY1: number;
    targetY0: number;
    targetY1: number;
  };
  const ribbons: Ribbon[] = [];

  for (let ci = 0; ci < columns.length - 1; ci++) {
    const flowsHere = flows.filter((f) => f.fromCol === ci);
    const fromCats = columnCategories[ci];
    const toCats = columnCategories[ci + 1];

    // Group by source category, then sort by target order
    const fromOrder = new Map(columns[ci].order.map((k, i) => [k, i]));
    const toOrder = new Map(columns[ci + 1].order.map((k, i) => [k, i]));

    const sourceCursor = new Map<string, number>();
    const targetCursor = new Map<string, number>();

    // Initialize cursors at each bar's top
    for (const cat of fromCats) sourceCursor.set(cat.key, cat.y0);
    for (const cat of toCats) targetCursor.set(cat.key, cat.y0);

    // Sort flows: by source order, then target order — so ribbons stack neatly
    const sortedFlows = [...flowsHere].sort((p, q) => {
      const ps = fromOrder.get(p.fromKey) ?? 0;
      const qs = fromOrder.get(q.fromKey) ?? 0;
      if (ps !== qs) return ps - qs;
      return (toOrder.get(p.toKey) ?? 0) - (toOrder.get(q.toKey) ?? 0);
    });

    // Need: per source bar, total height; thickness of each flow = count/total * barHeight
    const sourceTotals = new Map<string, number>();
    for (const f of flowsHere) {
      sourceTotals.set(f.fromKey, (sourceTotals.get(f.fromKey) ?? 0) + f.count);
    }
    const targetTotals = new Map<string, number>();
    for (const f of flowsHere) {
      targetTotals.set(f.toKey, (targetTotals.get(f.toKey) ?? 0) + f.count);
    }

    for (const flow of sortedFlows) {
      const fromCat = fromCats.find((c) => c.key === flow.fromKey)!;
      const toCat = toCats.find((c) => c.key === flow.toKey)!;
      if (!fromCat || !toCat) continue;

      const fromBarH = fromCat.y1 - fromCat.y0;
      const toBarH = toCat.y1 - toCat.y0;
      const fromTotal = sourceTotals.get(flow.fromKey) ?? 1;
      const toTotal = targetTotals.get(flow.toKey) ?? 1;

      const fromThickness = (flow.count / fromTotal) * fromBarH;
      const toThickness = (flow.count / toTotal) * toBarH;

      const sy0 = sourceCursor.get(flow.fromKey)!;
      const sy1 = sy0 + fromThickness;
      const ty0 = targetCursor.get(flow.toKey)!;
      const ty1 = ty0 + toThickness;

      sourceCursor.set(flow.fromKey, sy1);
      targetCursor.set(flow.toKey, ty1);

      ribbons.push({
        ...flow,
        sourceY0: sy0,
        sourceY1: sy1,
        targetY0: ty0,
        targetY1: ty1,
      });
    }
  }

  // Render -------------------------------------------------------------

  const svg = d3.select(target).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .style("display", "block");

  // Column titles
  for (let ci = 0; ci < columns.length; ci++) {
    svg.append("text")
      .attr("x", colX[ci])
      .attr("y", margin.top - 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("fill", "#444")
      .text(columns[ci].title);
  }

  // Tooltip
  const tooltip = d3.select(target).append("div")
    .style("position", "absolute")
    .style("padding", "6px 10px")
    .style("background", "rgba(0,0,0,0.85)")
    .style("color", "white")
    .style("font-size", "12px")
    .style("border-radius", "3px")
    .style("pointer-events", "none")
    .style("opacity", 0);

  // Ribbons (drawn first so bars render on top)
  const ribbonG = svg.append("g").attr("class", "ribbons");
  const ribbonSel = ribbonG.selectAll<SVGPathElement, Ribbon>("path")
    .data(ribbons)
    .join("path")
    .attr("d", (r) => ribbonPath(colX[r.fromCol] + colWidth / 2, r.sourceY0, r.sourceY1,
                                  colX[r.fromCol + 1] - colWidth / 2, r.targetY0, r.targetY1))
    .attr("fill", (r) => {
      // Color ribbons by interest group when interest is one of the endpoints.
      if (columns[r.fromCol].key === "interestGroup") return INTEREST_COLORS[r.fromKey] ?? "#999";
      if (columns[r.fromCol + 1].key === "interestGroup") return INTEREST_COLORS[r.toKey] ?? "#999";
      return "#888";
    })
    .attr("fill-opacity", 0.35)
    .attr("stroke", "none")
    .style("cursor", "pointer")
    .on("mouseenter", function (_e, r) {
      d3.select(this).attr("fill-opacity", 0.7);
      const fromKey = columns[r.fromCol].key;
      const toKey = columns[r.fromCol + 1].key;
      tooltip.html(
        `<strong>${columns[r.fromCol].label(r.fromKey)} → ${columns[r.fromCol + 1].label(r.toKey)}</strong><br>` +
        `${r.count} participants`,
      ).style("opacity", 1);
    })
    .on("mousemove", (event) => {
      const rect = target.getBoundingClientRect();
      tooltip.style("left", `${event.clientX - rect.left + 12}px`)
        .style("top", `${event.clientY - rect.top + 12}px`);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("fill-opacity", 0.35);
      tooltip.style("opacity", 0);
    })
    .on("click", (_e, r) => {
      selection.setIds(r.pids, { kind: "chart", label: "relations-flow" });
    });

  // Bars
  const allCats = columnCategories.flat();
  const barG = svg.append("g").attr("class", "bars");
  const barSel = barG.selectAll<SVGGElement, CatPos>("g")
    .data(allCats)
    .join("g")
    .style("cursor", "pointer")
    .on("click", (_e, d) => {
      selection.setIds(d.pids, { kind: "chart", label: `relations-bar-${d.key}` });
    })
    .on("mouseenter", function (_e, d) {
      d3.select(this).select("rect").attr("stroke", "#000").attr("stroke-width", 2);
      tooltip.html(
        `<strong>${columns[d.col].label(d.key)}</strong><br>` +
        `${d.count} participants`,
      ).style("opacity", 1);
    })
    .on("mousemove", (event) => {
      const rect = target.getBoundingClientRect();
      tooltip.style("left", `${event.clientX - rect.left + 12}px`)
        .style("top", `${event.clientY - rect.top + 12}px`);
    })
    .on("mouseleave", function () {
      d3.select(this).select("rect").attr("stroke", "#222").attr("stroke-width", 0.5);
      tooltip.style("opacity", 0);
    });

  barSel.append("rect")
    .attr("x", (d) => colX[d.col] - colWidth / 2)
    .attr("y", (d) => d.y0)
    .attr("width", colWidth)
    .attr("height", (d) => d.y1 - d.y0)
    .attr("fill", (d) => {
      if (columns[d.col].key === "interestGroup") return INTEREST_COLORS[d.key] ?? "#999";
      if (columns[d.col].key === "educationLevel") return "#4a7baf";
      return "#a85a3a";
    })
    .attr("stroke", "#222")
    .attr("stroke-width", 0.5);

  // Labels next to bars
  barSel.append("text")
    .attr("x", (d) => d.col === 0 ? colX[d.col] - colWidth / 2 - 6 : colX[d.col] + colWidth / 2 + 6)
    .attr("y", (d) => (d.y0 + d.y1) / 2)
    .attr("text-anchor", (d) => d.col === 0 ? "end" : "start")
    .attr("dominant-baseline", "middle")
    .attr("font-size", 10)
    .attr("fill", "#333")
    .text((d) => `${columns[d.col].label(d.key)} (${d.count})`);

  // Selection-driven dimming
  function applySelection(sel: Selection) {
    const sids = sel.participantIds;
    const isEmpty = sel.isEmpty;

    ribbonSel.attr("fill-opacity", (r) => {
      if (isEmpty) return 0.35;
      // A ribbon is "in selection" if any of its participants are selected
      let any = false;
      for (const pid of r.pids) {
        if (sids.has(pid)) { any = true; break; }
      }
      return any ? 0.55 : 0.06;
    });

    barSel.select("rect").attr("fill-opacity", (d) => {
      if (isEmpty) return 1;
      let any = false;
      for (const pid of d.pids) {
        if (sids.has(pid)) { any = true; break; }
      }
      return any ? 1 : 0.25;
    });
  }

  selection.subscribe(applySelection);
  applySelection(selection.get());
}

/**
 * Build a parallel-sets "ribbon" path: a closed quadrilateral whose
 * vertical edges are at x1 (source) and x2 (target), with smooth
 * curves between them.
 */
function ribbonPath(
  x1: number, y1Top: number, y1Bot: number,
  x2: number, y2Top: number, y2Bot: number,
): string {
  const cpx = (x1 + x2) / 2;
  return [
    `M ${x1},${y1Top}`,
    `C ${cpx},${y1Top} ${cpx},${y2Top} ${x2},${y2Top}`,
    `L ${x2},${y2Bot}`,
    `C ${cpx},${y2Bot} ${cpx},${y1Bot} ${x1},${y1Bot}`,
    `Z`,
  ].join(" ");
}
