import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";

interface GroupCell {
  from_group: string;
  to_group: string;
  interactions: number;
  normalized: number;
}

interface SocialSummary {
  participantId: number;
  degree: number;
  total_interactions: number;
}

interface Participant {
  participantId: number;
  joviality: number;
  interestGroup: string;
  age: number;
}

// Categorical palette — mostly teals/greens with restrained warm accents
// for distinguishability across 10 groups. Sits coherently with the
// teal/emerald spine while remaining individually distinguishable.
const INTEREST_COLORS: Record<string, string> = {
  A: "#0e3d33", // deep teal
  B: "#3aa28a", // mid teal
  C: "#22c597", // vivid emerald
  D: "#7fc9b0", // light teal
  E: "#5a8a6a", // sage green
  F: "#a3b5a0", // pale sage
  G: "#c9a96a", // muted gold
  H: "#c08a5b", // muted amber
  I: "#9d8aa6", // muted mauve
  J: "#5e7a8c", // slate
};

export async function renderNetwork(container: HTMLElement) {
  const [matrix, summary, participants] = await Promise.all([
    apiGet<GroupCell[]>("/derived/group_matrix.json"),
    apiGet<SocialSummary[]>("/derived/social_summary.json"),
    apiGet<Participant[]>("/derived/participants.json"),
  ]);

  drawMatrix(container, matrix, participants);
  drawScatter(container, summary, participants);
}

function drawMatrix(container: HTMLElement, cells: GroupCell[], participants: Participant[]) {
  const groups = "ABCDEFGHIJ".split("");

  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Group → group interaction (click to select)</div>`;
  container.appendChild(wrap);

  const size = 380;
  const margin = { top: 30, right: 10, bottom: 10, left: 30 };
  const w = size - margin.left - margin.right;
  const cellSize = w / groups.length;

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${size} ${size}`)
    .style("width", "100%")
    .style("height", "auto");

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const maxNorm = d3.max(cells, (d) => d.normalized) ?? 1;
  // Single-hue teal sequential — pale teal → deep teal
  const color = d3.scaleSequential((t) =>
    d3.interpolateRgb("#e0f2ee", "#0e3d33")(t)
  ).domain([0, maxNorm]);

  const idsByGroup = new Map<string, number[]>();
  for (const p of participants) {
    if (!idsByGroup.has(p.interestGroup)) idsByGroup.set(p.interestGroup, []);
    idsByGroup.get(p.interestGroup)!.push(p.participantId);
  }

  const cellSel = g.selectAll<SVGRectElement, GroupCell>("rect")
    .data(cells)
    .join("rect")
    .attr("x", (d) => groups.indexOf(d.to_group) * cellSize)
    .attr("y", (d) => groups.indexOf(d.from_group) * cellSize)
    .attr("width", cellSize - 1)
    .attr("height", cellSize - 1)
    .attr("rx", 2)
    .attr("fill", (d) => color(d.normalized))
    .attr("fill-opacity", 1)
    .attr("stroke", "transparent")
    .attr("stroke-width", 0)
    .style("cursor", "pointer");

  cellSel
    .on("click", (_event, d) => {
      const fromIds = idsByGroup.get(d.from_group) ?? [];
      const toIds = idsByGroup.get(d.to_group) ?? [];
      const union = Array.from(new Set([...fromIds, ...toIds]));
      if (union.length > 0) selection.setIds(union, { kind: "chart" });
    })
    .on("mouseenter", function (_e, d) {
      // Hover stroke — only if not already a selected cell
      const inSel = (this as SVGRectElement).getAttribute("data-active") === "1";
      if (inSel) return;
      d3.select(this)
        .attr("stroke", "#1f6f5e")
        .attr("stroke-width", 2);
    })
    .on("mouseleave", function () {
      const inSel = (this as SVGRectElement).getAttribute("data-active") === "1";
      if (inSel) {
        d3.select(this).attr("stroke", "#0e3d33").attr("stroke-width", 2.5);
      } else {
        d3.select(this).attr("stroke", "transparent").attr("stroke-width", 0);
      }
    })
    .append("title")
    .text((d) =>
      `${d.from_group} → ${d.to_group}\n` +
      `${d.interactions.toLocaleString()} interactions\n` +
      `normalized: ${d.normalized.toFixed(3)}`,
    );

  const groupOfPid = new Map<number, string>();
  for (const p of participants) groupOfPid.set(p.participantId, p.interestGroup);

  selection.subscribe((sel) => {
    const groupsInSel = new Set<string>();
    if (!sel.isEmpty) {
      for (const pid of sel.participantIds) {
        const gp = groupOfPid.get(pid);
        if (gp) groupsInSel.add(gp);
      }
    }

    cellSel
      .attr("data-active", (d) =>
        (!sel.isEmpty && groupsInSel.has(d.from_group) && groupsInSel.has(d.to_group)) ? "1" : "0",
      );

    cellSel.transition().duration(180).ease(d3.easeCubicOut)
      .attr("fill-opacity", (d) => {
        if (sel.isEmpty) return 1;
        return (groupsInSel.has(d.from_group) || groupsInSel.has(d.to_group)) ? 1 : 0.2;
      })
      .attr("stroke", (d) => {
        if (sel.isEmpty) return "transparent";
        return (groupsInSel.has(d.from_group) && groupsInSel.has(d.to_group)) ? "#0e3d33" : "transparent";
      })
      .attr("stroke-width", (d) => {
        if (sel.isEmpty) return 0;
        return (groupsInSel.has(d.from_group) && groupsInSel.has(d.to_group)) ? 2.5 : 0;
      });
  });

  g.selectAll("text.col")
    .data(groups)
    .join("text")
    .attr("class", "col")
    .attr("x", (_, i) => i * cellSize + cellSize / 2)
    .attr("y", -8)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("font-weight", "500")
    .text((d) => d);

  g.selectAll("text.row")
    .data(groups)
    .join("text")
    .attr("class", "row")
    .attr("x", -8)
    .attr("y", (_, i) => i * cellSize + cellSize / 2 + 4)
    .attr("text-anchor", "end")
    .style("font-size", "10px")
    .style("font-weight", "500")
    .text((d) => d);
}

function drawScatter(
  container: HTMLElement,
  summary: SocialSummary[],
  participants: Participant[],
) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Friend count vs joviality (click a dot to select)</div>`;
  container.appendChild(wrap);

  const pById = new Map(participants.map((p) => [p.participantId, p]));
  const data = summary
    .map((s) => {
      const p = pById.get(s.participantId);
      return p ? { ...s, joviality: p.joviality, group: p.interestGroup } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const w = 460, h = 240;
  const margin = { top: 10, right: 10, bottom: 30, left: 35 };

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto");

  const x = d3.scaleLinear()
    .domain([0, d3.max(data, (d) => d.degree) ?? 100]).nice()
    .range([margin.left, w - margin.right]);
  const y = d3.scaleLinear()
    .domain([0, 1])
    .range([h - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickSizeOuter(0));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));

  svg.append("text").attr("x", w / 2).attr("y", h - 5).attr("text-anchor", "middle")
    .style("font-size", "10px").style("fill", "var(--text-tertiary)")
    .text("degree (number of friends)");

  svg.append("text").attr("transform", "rotate(-90)").attr("x", -h / 2).attr("y", 12)
    .attr("text-anchor", "middle").style("font-size", "10px").style("fill", "var(--text-tertiary)")
    .text("joviality");

  const dots = svg.append("g")
    .selectAll<SVGCircleElement, typeof data[number]>("circle")
    .data(data)
    .join("circle")
    .attr("cx", (d) => x(d.degree))
    .attr("cy", (d) => y(d.joviality))
    .attr("r", 2.8)
    .attr("fill", (d) => INTEREST_COLORS[d.group] ?? "#888")
    .attr("fill-opacity", 0.7)
    .attr("stroke", "white")
    .attr("stroke-width", 0.4)
    .style("cursor", "pointer");

  dots.on("click", (_event, d) => {
    selection.setIds([d.participantId], { kind: "chart" });
  });

  selection.subscribe((sel) => {
    dots.transition().duration(180).ease(d3.easeCubicOut)
      .attr("fill-opacity", (d) => sel.isEmpty ? 0.7 : (sel.participantIds.has(d.participantId) ? 0.9 : 0.08))
      .attr("r", (d) => sel.isEmpty ? 2.8 : (sel.participantIds.has(d.participantId) ? 4 : 2.5));
  });
}
