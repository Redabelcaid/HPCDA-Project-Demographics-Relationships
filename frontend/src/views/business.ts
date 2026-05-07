/**
 * Business view: wage scatter by education + employer-size histogram.
 * Education palette is a teal-emerald ordinal ramp (pale → vivid).
 */
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";

interface Job {
  jobId: number;
  employerId: number;
  hourlyRate: number;
  educationRequirement: string;
}

interface EmployerStat {
  employerId: number;
  n_jobs: number;
  avg_wage: number;
}

interface Participant {
  participantId: number;
  educationLevel: string;
}

const EDU_ORDER = ["Low", "HighSchoolOrCollege", "Bachelors", "Graduate"];
// Teal-emerald ordinal ramp — pale to vivid
const EDU_COLOR = d3.scaleOrdinal<string, string>()
  .domain(EDU_ORDER)
  .range(["#a8dcc7", "#3aa28a", "#22c597", "#0e3d33"]);

export async function renderBusiness(container: HTMLElement) {
  const [jobs, employers, participants] = await Promise.all([
    apiGet<Job[]>("/derived/jobs.json"),
    apiGet<EmployerStat[]>("/derived/employer_stats.json"),
    apiGet<Participant[]>("/derived/participants.json"),
  ]);

  drawWageScatter(container, jobs, participants);
  drawEmployerSizes(container, employers);
}

function drawWageScatter(container: HTMLElement, jobs: Job[], participants: Participant[]) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Wages by education requirement (click a column to select)</div>`;
  container.appendChild(wrap);

  const w = 460, h = 220;
  const margin = { top: 10, right: 10, bottom: 50, left: 35 };

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto");

  const x = d3.scaleBand()
    .domain(EDU_ORDER)
    .range([margin.left, w - margin.right])
    .padding(0.4);
  const y = d3.scaleLinear()
    .domain([0, 60]).nice()
    .range([h - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .selectAll("text")
    .style("font-size", "9px")
    .attr("transform", "rotate(-12)")
    .style("text-anchor", "end");
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));

  svg.append("text")
    .attr("transform", `rotate(-90)`)
    .attr("x", -h / 2)
    .attr("y", 12)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("fill", "var(--text-tertiary)")
    .text("$/hr");

  const idsByEdu = new Map<string, number[]>();
  for (const p of participants) {
    if (!idsByEdu.has(p.educationLevel)) idsByEdu.set(p.educationLevel, []);
    idsByEdu.get(p.educationLevel)!.push(p.participantId);
  }
  const eduOfPid = new Map<number, string>();
  for (const p of participants) eduOfPid.set(p.participantId, p.educationLevel);

  svg.append("g")
    .selectAll<SVGRectElement, string>("rect")
    .data(EDU_ORDER)
    .join("rect")
    .attr("x", (d) => (x(d) ?? 0) - x.bandwidth() * 0.15)
    .attr("y", margin.top)
    .attr("width", x.bandwidth() * 1.3)
    .attr("height", h - margin.bottom - margin.top)
    .attr("fill", "transparent")
    .style("cursor", "pointer")
    .on("click", (_event, edu) => {
      const ids = idsByEdu.get(edu) ?? [];
      if (ids.length > 0) selection.setIds(ids, { kind: "chart" });
    });

  const dots = svg.append("g")
    .selectAll<SVGCircleElement, Job>("circle")
    .data(jobs.filter((j) => j.hourlyRate <= 60))
    .join("circle")
    .attr("cx", (d) => (x(d.educationRequirement) ?? 0) + x.bandwidth() / 2 + (Math.random() - 0.5) * x.bandwidth() * 0.7)
    .attr("cy", (d) => y(d.hourlyRate))
    .attr("r", 2.2)
    .attr("fill", (d) => EDU_COLOR(d.educationRequirement) as string)
    .attr("fill-opacity", 0.65)
    .attr("stroke", "white")
    .attr("stroke-width", 0.3)
    .style("pointer-events", "none");

  const medians = EDU_ORDER.map((edu) => {
    const wages = jobs.filter((j) => j.educationRequirement === edu).map((j) => j.hourlyRate).sort(d3.ascending);
    return { edu, median: d3.quantileSorted(wages, 0.5) ?? 0 };
  });

  svg.append("g")
    .selectAll("rect.median")
    .data(medians)
    .join("rect")
    .attr("class", "median")
    .attr("x", (d) => (x(d.edu) ?? 0) + x.bandwidth() * 0.15)
    .attr("y", (d) => y(d.median) - 1.5)
    .attr("width", x.bandwidth() * 0.7)
    .attr("height", 3)
    .attr("rx", 1.5)
    .attr("fill", "#0e3d33")
    .style("pointer-events", "none");

  selection.subscribe((sel) => {
    const eduInSel = new Set<string>();
    if (!sel.isEmpty) {
      for (const pid of sel.participantIds) {
        const e = eduOfPid.get(pid);
        if (e) eduInSel.add(e);
      }
    }

    dots.transition().duration(180).ease(d3.easeCubicOut)
      .attr("fill-opacity", (d) => {
        if (sel.isEmpty) return 0.65;
        return eduInSel.has(d.educationRequirement) ? 0.85 : 0.12;
      });
  });
}

function drawEmployerSizes(container: HTMLElement, employers: EmployerStat[]) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;font-weight:500;">Employer size distribution (jobs per employer)</div>`;
  container.appendChild(wrap);

  const w = 460, h = 130;
  const margin = { top: 10, right: 10, bottom: 24, left: 30 };

  const svg = d3.select(wrap).append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .style("width", "100%")
    .style("height", "auto");

  // Vertical gradient — vivid emerald to deep teal
  const gradId = "biz-bar-gradient";
  const grad = svg.append("defs").append("linearGradient")
    .attr("id", gradId).attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#22c597");
  grad.append("stop").attr("offset", "100%").attr("stop-color", "#1f6f5e");

  const counts = d3.rollup(employers, (v) => v.length, (d) => d.n_jobs);
  const bars = Array.from(counts, ([n_jobs, count]) => ({ n_jobs, count }))
    .sort((a, b) => a.n_jobs - b.n_jobs);

  const x = d3.scaleBand()
    .domain(bars.map((b) => String(b.n_jobs)))
    .range([margin.left, w - margin.right])
    .padding(0.18);
  const y = d3.scaleLinear()
    .domain([0, d3.max(bars, (b) => b.count) ?? 0]).nice()
    .range([h - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSizeOuter(0));

  svg.append("g")
    .selectAll("rect")
    .data(bars)
    .join("rect")
    .attr("x", (d) => x(String(d.n_jobs)) ?? 0)
    .attr("y", (d) => y(d.count))
    .attr("width", x.bandwidth())
    .attr("height", (d) => h - margin.bottom - y(d.count))
    .attr("rx", 3)
    .attr("fill", `url(#${gradId})`);
}
