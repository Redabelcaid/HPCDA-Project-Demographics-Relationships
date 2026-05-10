/**
 * City map view with selectable color overlays for residential buildings.
 *
 * Overlays:
 *   - "type": Residential / Commercial / School coloring
 *   - "joviality": sequential plasma on empirical data range
 *   - "group": dominant interest group (categorical)
 *   - "wage": sequential, mean wage of residents' employers
 *
 * Buildings with < 3 residents are de-emphasized via reduced saturation
 * and diagonal hatch fill, signaling that the per-resident mean is
 * unreliable.
 *
 * Selection-driven arcs (top 80) are rendered with a directional gradient
 * and cubic easing for a refined visual feel.
 *
 * Lasso: holding Shift and dragging the cursor draws a rectangle. On
 * release, all residential buildings whose centroid falls inside the
 * rectangle contribute their residents to a new selection (source kind
 * "region"). Pan/zoom is bypassed while shift is held so the gesture
 * reads cleanly.
 */
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection, topN } from "../state.ts";
import type { Selection, SelectionSource } from "../state.ts";

interface Building {
  buildingId: number;
  buildingType: string;
  maxOccupancy: number | null;
  units: string | null;
  rings: [number, number][][];
}

interface Edge { a: number; b: number; n: number; }

interface EmployerStat {
  employerId: number;
  buildingId: number | null;
  point: [number, number] | null;
  n_jobs: number;
  avg_wage: number;
  min_wage: number;
  max_wage: number;
}

interface BuildingDemo {
  buildingId: number;
  n_residents: number;
  mean_age: number;
  mean_joviality: number;
  mean_wage: number | null;
  dominant_group: string;
}

type ResidencyMap = Record<number, number>;
type EmploymentMap = Record<number, { buildingId: number; employerId: number | null }>;
type TopFriendsMap = Record<number, { friend: number; n: number }[]>;

type Overlay = "type" | "joviality" | "group" | "wage";

const TYPE_COLORS: Record<string, string> = {
  Residental: "#7fb069",
  Commercial: "#bdbdbd",
  School: "#e08e45",
};

const INTEREST_COLORS: Record<string, string> = {
  A: "#1f77b4", B: "#ff7f0e", C: "#2ca02c", D: "#d62728", E: "#9467bd",
  F: "#8c564b", G: "#e377c2", H: "#7f7f7f", I: "#bcbd22", J: "#17becf",
};

const ARC_COLOR = "#ff3366";
const ARC_COLOR_FADE = "#ff8c42";
const ARC_BOW_FACTOR = 0.25;
const MIN_RESIDENTS_FOR_CONFIDENCE = 3;

export async function renderMap(container: HTMLElement) {
  const [buildings, residency, edges, employers, employment, topFriends, buildingDemo] = await Promise.all([
    apiGet<Building[]>("/derived/buildings.json"),
    apiGet<ResidencyMap>("/derived/residency.json"),
    apiGet<Edge[]>("/derived/social_edges.json"),
    apiGet<EmployerStat[]>("/derived/employer_stats.json"),
    apiGet<EmploymentMap>("/derived/participant_employment.json"),
    apiGet<TopFriendsMap>("/derived/top_friends_by_participant.json"),
    apiGet<BuildingDemo[]>("/derived/building_demographics.json"),
  ]);

  const residentsByBuilding = new Map<number, number[]>();
  for (const [pidStr, bid] of Object.entries(residency)) {
    const pid = Number(pidStr);
    if (!residentsByBuilding.has(bid)) residentsByBuilding.set(bid, []);
    residentsByBuilding.get(bid)!.push(pid);
  }

  const demoByBuilding = new Map<number, BuildingDemo>();
  for (const d of buildingDemo) demoByBuilding.set(d.buildingId, d);

  drawMap(container, buildings, residentsByBuilding, residency, edges, employers, employment, topFriends, demoByBuilding);
}

function drawMap(
  target: HTMLElement,
  buildings: Building[],
  residentsByBuilding: Map<number, number[]>,
  residency: ResidencyMap,
  edges: Edge[],
  employers: EmployerStat[],
  employment: EmploymentMap,
  topFriends: TopFriendsMap,
  demoByBuilding: Map<number, BuildingDemo>,
) {
  // World extent
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of buildings) {
    for (const ring of b.rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const padding = 50;
  const viewMinX = minX - padding;
  const viewMinY = -(maxY + padding);
  const viewW = (maxX - minX) + 2 * padding;
  const viewH = (maxY - minY) + 2 * padding;

  let currentOverlay: Overlay = "type";

  // Overlay control toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "overlay-toolbar";
  toolbar.style.cssText =
    "position:absolute;top:8px;left:8px;z-index:10;";
  toolbar.innerHTML = `
    <div style="font-weight:600;color:#444;margin-bottom:4px;">Color residences by</div>
    <label><input type="radio" name="overlay" value="type" checked> Building type</label>
    <label><input type="radio" name="overlay" value="joviality"> Mean joviality</label>
    <label><input type="radio" name="overlay" value="group"> Dominant interest group</label>
    <label><input type="radio" name="overlay" value="wage"> Mean wage</label>
    <div style="border-top:1px solid #eee;margin-top:6px;padding-top:6px;">
      <label style="display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="vacancy-toggle">
        <span>Highlight unoccupied residences</span>
      </label>
      <div style="font-size:9px;color:#888;margin-top:2px;line-height:1.3;">
        Residential buildings with no participants in our sample.
      </div>
    </div>
    <div style="font-size:10px;color:#888;margin-top:6px;font-style:italic;">Tip: Shift+drag to lasso a region</div>
    <div id="overlay-legend" style="margin-top:6px;border-top:1px solid #eee;padding-top:6px;min-height:30px;"></div>
  `;
  target.style.position = "relative";
  target.appendChild(toolbar);

  const svg = d3.select(target)
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `${viewMinX} ${viewMinY} ${viewW} ${viewH}`)
    .style("display", "block")
    .style("cursor", "grab");

  const defs = svg.append("defs");

  // Animated dashed stroke for the directional arcs. Defined inline in
  // the SVG so the animation runs only while this map is mounted.
  // The "flow" is achieved by translating stroke-dashoffset across one
  // full dash+gap cycle (16 units) over 1.4s, looped indefinitely.
  defs.append("style").text(`
    .animated-arc {
      stroke-dasharray: 6 10;
      animation: arc-flow 1.4s linear infinite;
    }
    @keyframes arc-flow {
      from { stroke-dashoffset: 0; }
      to   { stroke-dashoffset: -16; }
    }
  `);

  // Glow filter for hovered arcs
  const glow = defs.append("filter").attr("id", "arc-glow")
    .attr("x", "-50%").attr("y", "-50%")
    .attr("width", "200%").attr("height", "200%");
  glow.append("feGaussianBlur").attr("stdDeviation", 2).attr("result", "blur");
  const glowMerge = glow.append("feMerge");
  glowMerge.append("feMergeNode").attr("in", "blur");
  glowMerge.append("feMergeNode").attr("in", "SourceGraphic");

  // Directional gradient for arcs
  const arcGradient = defs.append("linearGradient")
    .attr("id", "arc-gradient")
    .attr("gradientUnits", "objectBoundingBox")
    .attr("x1", "0%").attr("y1", "0%")
    .attr("x2", "100%").attr("y2", "0%");
  arcGradient.append("stop").attr("offset", "0%").attr("stop-color", ARC_COLOR);
  arcGradient.append("stop").attr("offset", "100%").attr("stop-color", ARC_COLOR_FADE);

  // Hatch pattern for low-confidence buildings
  const hatch = defs.append("pattern")
    .attr("id", "low-confidence-hatch")
    .attr("patternUnits", "userSpaceOnUse")
    .attr("width", 8).attr("height", 8)
    .attr("patternTransform", "rotate(45)");
  hatch.append("rect").attr("width", 8).attr("height", 8).attr("fill", "transparent");
  hatch.append("line")
    .attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 8)
    .attr("stroke", "rgba(0,0,0,0.18)").attr("stroke-width", 2);

  const root = svg.append("g");
  const buildingsLayer = root.append("g").attr("class", "buildings");
  const buildingsHatchLayer = root.append("g").attr("class", "buildings-hatch");
  const arcsLayer = root.append("g").attr("class", "arcs").attr("fill", "none");
  const endpointsLayer = root.append("g").attr("class", "endpoints");
  // Vacancy layer for animated highlight overlays on data-empty
  // residential buildings. Each entry renders the building's polygon
  // path tinted bright red and pulses via CSS. Lives inside root so
  // overlays stay anchored to their buildings under pan/zoom. Hidden
  // by default; toggled by the toolbar checkbox.
  const vacancyLayer = root.append("g")
    .attr("class", "vacancy-highlights")
    .style("pointer-events", "none")
    .style("display", "none");
  // Lasso rectangle is added INTO `root` (the zoomable group) so it
  // moves with the map under pan/zoom — i.e. it stays anchored to the
  // physical city region the user selected, not to the screen.
  const lassoLayer = root.append("g").attr("class", "lasso").style("pointer-events", "none");

  // Inject the pulse keyframe + class — scoped via class name so it
  // only affects vacancy highlights inside this map.
  const pulseStyle = document.createElement("style");
  pulseStyle.textContent = `
    @keyframes vacancy-pulse {
      0%, 100% { opacity: 0.35; }
      50%      { opacity: 0.85; }
    }
    .vacancy-highlight {
      animation: vacancy-pulse 2s ease-in-out infinite;
      pointer-events: none;
    }
  `;
  target.appendChild(pulseStyle);

  const pathFor = (rings: [number, number][][]) =>
    rings.map((ring) => {
      if (!ring.length) return "";
      return "M " + ring.map(([x, y]) => `${x},${-y}`).join(" L ") + " Z";
    }).filter(Boolean).join(" ");

  // ---- Color resolvers per overlay ----

  // Sequential plasma colormap on the empirical joviality range. We
  // deliberately avoid divergent palettes (RdBu) here: 0.5 has no
  // semantic meaning for joviality, and the white midpoint of RdBu
  // collides with the "no data" cartographic convention. Plasma
  // ranges magenta → orange → yellow without the near-black low end
  // of magma/inferno, so buildings stay readable on a light map.
  const jovialityScale = d3.scaleSequential(d3.interpolatePlasma)
    .domain([0.42, 0.56]);

  const wageScale = d3.scaleSequential(d3.interpolateGreens).domain([10, 35]);

  function fillForBuilding(b: Building): string {
    if (currentOverlay === "type" || b.buildingType !== "Residental") {
      return TYPE_COLORS[b.buildingType] ?? "#ccc";
    }
    const demo = demoByBuilding.get(b.buildingId);
    if (!demo) return "#e8e8e8";
    if (currentOverlay === "joviality") return jovialityScale(demo.mean_joviality);
    if (currentOverlay === "group") return INTEREST_COLORS[demo.dominant_group] ?? "#999";
    if (currentOverlay === "wage") {
      if (demo.mean_wage == null) return "#e8e8e8";
      return wageScale(demo.mean_wage);
    }
    return "#ccc";
  }

  function isLowConfidence(b: Building): boolean {
    if (currentOverlay === "type" || b.buildingType !== "Residental") return false;
    const demo = demoByBuilding.get(b.buildingId);
    if (!demo) return true;
    return demo.n_residents < MIN_RESIDENTS_FOR_CONFIDENCE;
  }

  // Buildings ----------------------------------------------------
  const paths = buildingsLayer
    .selectAll("path")
    .data(buildings)
    .join("path")
    .attr("d", (d) => pathFor(d.rings))
    .attr("fill-rule", "evenodd")
    .attr("fill", (d) => fillForBuilding(d))
    .attr("fill-opacity", (d) => isLowConfidence(d) ? 0.55 : 1)
    .attr("stroke", "#666")
    .attr("stroke-width", 0.6)
    .attr("vector-effect", "non-scaling-stroke")
    .style("cursor", "pointer");

  const hatchPaths = buildingsHatchLayer
    .selectAll("path")
    .data(buildings)
    .join("path")
    .attr("d", (d) => pathFor(d.rings))
    .attr("fill-rule", "evenodd")
    .attr("fill", (d) => isLowConfidence(d) ? "url(#low-confidence-hatch)" : "none")
    .attr("stroke", "none")
    .style("pointer-events", "none");

  // Tooltip
  const tooltip = d3.select(target)
    .append("div")
    .style("position", "absolute")
    .style("padding", "6px 10px")
    .style("background", "rgba(0,0,0,0.85)")
    .style("color", "white")
    .style("font-size", "12px")
    .style("border-radius", "3px")
    .style("pointer-events", "none")
    .style("opacity", 0);

  paths
    .on("mouseenter", function (_e, d) {
      d3.select(this).attr("stroke", "#000").attr("stroke-width", 1.5);
      const residents = residentsByBuilding.get(d.buildingId) ?? [];
      const demo = demoByBuilding.get(d.buildingId);
      let extra = "";
      if (d.buildingType === "Residental" && demo && currentOverlay !== "type") {
        if (currentOverlay === "joviality") extra = `<br>Mean joviality: ${demo.mean_joviality.toFixed(2)}`;
        if (currentOverlay === "group") extra = `<br>Dominant group: ${demo.dominant_group}`;
        if (currentOverlay === "wage" && demo.mean_wage != null) extra = `<br>Mean wage: $${demo.mean_wage.toFixed(0)}/hr`;
        if (demo.n_residents < MIN_RESIDENTS_FOR_CONFIDENCE) {
          extra += `<br><em style="opacity:0.7">(low confidence: ${demo.n_residents} resident${demo.n_residents === 1 ? "" : "s"})</em>`;
        }
      }
      tooltip.html(
        `<strong>Building #${d.buildingId}</strong><br>` +
        `Type: ${d.buildingType}` +
        (d.buildingType === "Residental" ? `<br>Residents: ${residents.length}` : "") +
        (d.maxOccupancy ? `<br>Capacity: ${d.maxOccupancy}` : "") +
        extra
      ).style("opacity", 1);
    })
    .on("mousemove", (event) => {
      const [px, py] = d3.pointer(event, document.body);
      tooltip.style("left", `${px + 12}px`).style("top", `${py + 12}px`);
    })
    .on("mouseleave", function () {
      applySelection(selection.get());
      tooltip.style("opacity", 0);
    })
    .on("click", (event, d) => {
      // Shift+click on a building should become part of a lasso gesture,
      // not select that single building. The lasso mousedown handler
      // also fires first and starts a drag; this guard avoids the click
      // path firing a building selection in the meantime.
      if ((event as MouseEvent).shiftKey) return;
      event.stopPropagation();
      const residents = residentsByBuilding.get(d.buildingId) ?? [];
      if (residents.length === 0) return;
      selection.setIds(residents, { kind: "building", buildingId: d.buildingId });
    });

  svg.on("click", (event) => {
    // Don't clear selection on a shift-click (that's part of a lasso),
    // and don't clear if we just finished lassoing.
    if ((event as MouseEvent).shiftKey) return;
    if (justLassoedFlag) { justLassoedFlag = false; return; }
    const target = event.target as Element;
    if (target.tagName === "circle" || target.tagName === "path") return;
    if (target.tagName === "rect" && (target as Element).closest("g.lasso")) return;
    selection.clear();
  });

  // Zoom — filter out events when shift is held so the lasso owns those
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.5, 30])
    .filter((event: any) => !event.shiftKey && !event.button)
    .on("zoom", (event) => root.attr("transform", event.transform.toString()));
  svg.call(zoom as any);
  svg.on("dblclick.zoom", null);

  const zoomToolbar = d3.select(target)
    .append("div")
    .attr("class", "map-toolbar");
  zoomToolbar.append("button").text("+")
    .on("click", () => svg.transition().duration(200).call(zoom.scaleBy as any, 1.5));
  zoomToolbar.append("button").text("−")
    .on("click", () => svg.transition().duration(200).call(zoom.scaleBy as any, 1 / 1.5));
  zoomToolbar.append("button").text("⤢").attr("title", "Reset view")
    .on("click", () => svg.transition().duration(300).call(zoom.transform as any, d3.zoomIdentity));

  // ---- Lasso (shift+drag rectangle selection) ----
  // Building centroids in world coords (computed once)
  const buildingCentroids: Array<{
    buildingId: number; cx: number; cy: number; isResidential: boolean;
  }> = [];
  for (const b of buildings) {
    let sx = 0, sy = 0, n = 0;
    for (const ring of b.rings) {
      for (const [x, y] of ring) { sx += x; sy += y; n++; }
    }
    if (n > 0) {
      buildingCentroids.push({
        buildingId: b.buildingId,
        cx: sx / n,
        cy: sy / n,
        isResidential: b.buildingType === "Residental",
      });
    }
  }

  // ---- Vacancy highlights (data-empty residential buildings) ----
  // Residential buildings with zero participants in our sample. Honestly
  // labeled: this means "no observed residents in the data", not necessarily
  // that the apartment is physically vacant — the city's app reached only
  // ~1000 people, so unsampled non-participants may still live there.
  const dataEmptyResidentials = buildings.filter((b) => {
    if (b.buildingType !== "Residental") return false;
    const residents = residentsByBuilding.get(b.buildingId) ?? [];
    return residents.length === 0;
  });

  // Render each as a stroked outline overlay: no fill (so the underlying
  // building stays visible), bright red stroke that pulses via CSS.
  // All overlays share the same animation phase so they pulse in unison.
  vacancyLayer.selectAll<SVGPathElement, Building>("path")
    .data(dataEmptyResidentials)
    .join("path")
    .attr("class", "vacancy-highlight")
    .attr("d", (d) => pathFor(d.rings))
    .attr("fill-rule", "evenodd")
    .attr("fill", "none")
    .attr("stroke", "#ff2e3f")
    .attr("stroke-width", 3)
    .attr("vector-effect", "non-scaling-stroke")
    .style("filter", "drop-shadow(0 0 3px #ff2e3f)");

  // Toggle handler
  const vacancyToggle = toolbar.querySelector<HTMLInputElement>("#vacancy-toggle");
  if (vacancyToggle) {
    vacancyToggle.addEventListener("change", () => {
      vacancyLayer.style("display", vacancyToggle.checked ? null : "none");
    });
  }

  let lassoRect: d3.Selection<SVGRectElement, unknown, null, undefined> | null = null;
  // lassoStartWorld is the rectangle's start corner in WORLD coordinates
  // (not viewBox/screen). Storing in world coords means the rectangle
  // stays anchored to the city as the user pans/zooms.
  let lassoStartWorld: [number, number] | null = null;
  let isLassoing = false;
  let justLassoedFlag = false;

  const svgNode = svg.node()!;

  // d3.pointer on the svg returns viewBox (i.e. world-with-y-flipped)
  // coordinates after applying the current zoom transform inverse —
  // but here we apply the transform manually since the viewBox is on
  // the SVG and the zoom only transforms the inner <g>. We need the
  // viewBox-coord position then convert to world by undoing the
  // zoom transform manually.
  function eventToWorld(event: MouseEvent): [number, number] {
    const [vx, vy] = d3.pointer(event, svgNode);
    // Undo the current zoom transform on the root group
    const t = d3.zoomTransform(svgNode);
    const [ux, uy] = t.invert([vx, vy]);
    return [ux, -uy]; // flip y back to world
  }

  svgNode.addEventListener("mousedown", (event: MouseEvent) => {
    if (!event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    isLassoing = true;
    lassoStartWorld = eventToWorld(event);

    // Rectangle is added INSIDE root (zoomable group). Its coordinates
    // are world coords with y-axis flipped (rendered as `-y`) to match
    // how building paths are drawn ("M x,-y ..."). We don't use
    // vector-effect:non-scaling-stroke here because we WANT the
    // rectangle to scale with zoom — it's anchored to the city.
    if (lassoRect) lassoRect.remove();
    const [sx, sy] = lassoStartWorld;
    lassoRect = lassoLayer.append("rect")
      .attr("x", sx)
      .attr("y", -sy)
      .attr("width", 0)
      .attr("height", 0)
      .attr("fill", "rgba(34, 197, 151, 0.15)")
      .attr("stroke", "#1f6f5e")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4,3")
      .attr("vector-effect", "non-scaling-stroke");

    svg.style("cursor", "crosshair");
  });

  window.addEventListener("mousemove", (event: MouseEvent) => {
    if (!isLassoing || !lassoRect || !lassoStartWorld) return;
    const [wx, wy] = eventToWorld(event);
    const [sx, sy] = lassoStartWorld;
    // SVG rect uses y = -worldY (because the map renders points as [x,-y])
    const minWX = Math.min(sx, wx);
    const maxWX = Math.max(sx, wx);
    const minWY = Math.min(sy, wy);
    const maxWY = Math.max(sy, wy);
    lassoRect
      .attr("x", minWX)
      .attr("y", -maxWY)        // flipped: top of rect in screen-y = max world-y
      .attr("width", maxWX - minWX)
      .attr("height", maxWY - minWY);
  });

  window.addEventListener("mouseup", (event: MouseEvent) => {
    if (!isLassoing) return;
    isLassoing = false;
    svg.style("cursor", "grab");

    if (!lassoStartWorld) {
      if (lassoRect) { lassoRect.remove(); lassoRect = null; }
      return;
    }

    const [endX, endY] = eventToWorld(event);
    const [startX, startY] = lassoStartWorld;
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    // Tiny rectangles → likely accidental shift+click → just bail
    const widthW = maxX - minX, heightW = maxY - minY;
    if (widthW < 5 || heightW < 5) {
      if (lassoRect) { lassoRect.remove(); lassoRect = null; }
      lassoStartWorld = null;
      return;
    }

    const hits = buildingCentroids.filter((c) =>
      c.isResidential &&
      c.cx >= minX && c.cx <= maxX &&
      c.cy >= minY && c.cy <= maxY,
    );
    const pids = new Set<number>();
    for (const c of hits) {
      const residents = residentsByBuilding.get(c.buildingId) ?? [];
      for (const pid of residents) pids.add(pid);
    }

    if (pids.size === 0) {
      if (lassoRect) { lassoRect.remove(); lassoRect = null; }
      lassoStartWorld = null;
      return;
    }

    selection.setIds(Array.from(pids), {
      kind: "region",
      bounds: { minX, minY, maxX, maxY },
      nBuildings: hits.length,
    } as any);

    // Keep rectangle visible as a soft outline until selection changes
    lassoRect
      .attr("fill", "rgba(34, 197, 151, 0.05)")
      .attr("stroke-width", 1);

    lassoStartWorld = null;
    justLassoedFlag = true;
  });

  // Residence centroids (used for arcs)
  const buildingById = new Map(buildings.map((b) => [b.buildingId, b]));
  const residenceXY = new Map<number, [number, number]>();
  for (const [pidStr, bid] of Object.entries(residency)) {
    const b = buildingById.get(bid);
    if (!b || !b.rings.length) continue;
    const ring = b.rings[0];
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length; cy /= ring.length;
    residenceXY.set(Number(pidStr), [cx, cy]);
  }

  // Arc rendering ----------------------------------------------------
  function arcPath(x1: number, y1: number, x2: number, y2: number): string {
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / (dist || 1), ny = dx / (dist || 1);
    const bow = dist * ARC_BOW_FACTOR;
    const cx = (x1 + x2) / 2 + nx * bow;
    const cy = (y1 + y2) / 2 + ny * bow;
    return `M ${x1},${-y1} Q ${cx},${-cy} ${x2},${-y2}`;
  }

  const wExtent = d3.extent(edges, (e) => e.n) as [number, number];
  const widthScale = d3.scaleLog<number>()
    .domain([Math.max(1, wExtent[0]), wExtent[1]]).range([0.4, 2]).clamp(true);
  const opacityScale = d3.scaleLog<number>()
    .domain([Math.max(1, wExtent[0]), wExtent[1]]).range([0.08, 0.6]).clamp(true);

  function relevantArcs(selectedIds: ReadonlySet<number>): Edge[] {
    if (selectedIds.size === 0) return [];
    const filtered: Edge[] = [];
    for (const e of edges) {
      if (!selectedIds.has(e.a) && !selectedIds.has(e.b)) continue;
      if (!residenceXY.has(e.a) || !residenceXY.has(e.b)) continue;
      filtered.push(e);
    }
    filtered.sort((p, q) => q.n - p.n);
    return filtered.slice(0, 80);
  }

  function arcKey(e: Edge): string { return `${e.a}-${e.b}`; }
  function endpointKey(pid: number): string { return `pid-${pid}`; }

  function renderArcs(selectedIds: ReadonlySet<number>) {
    const arcs = relevantArcs(selectedIds);
    const ordered = [...arcs].sort((p, q) => p.n - q.n);

    const arcSel = arcsLayer.selectAll<SVGPathElement, Edge>("path")
      .data(ordered, (d: any) => arcKey(d));

    arcSel.exit()
      .transition().duration(200).ease(d3.easeCubicIn)
      .attr("stroke-opacity", 0)
      .remove();

    const enter = arcSel.enter().append("path")
      .attr("class", "animated-arc")
      .attr("d", (d) => {
        const [x1, y1] = residenceXY.get(d.a)!;
        const [x2, y2] = residenceXY.get(d.b)!;
        return arcPath(x1, y1, x2, y2);
      })
      .attr("stroke", "url(#arc-gradient)")
      .attr("stroke-width", (d) => widthScale(d.n))
      .attr("stroke-linecap", "round")
      .attr("vector-effect", "non-scaling-stroke")
      .attr("stroke-opacity", 0)
      .style("pointer-events", "stroke")
      .style("cursor", "pointer");

    enter.transition().duration(280).ease(d3.easeCubicOut)
      .attr("stroke-opacity", (d) => opacityScale(d.n));

    enter
      .on("mouseenter", function (_e, d) {
        d3.select(this).attr("filter", "url(#arc-glow)").attr("stroke-opacity", 1)
          .attr("stroke-width", widthScale(d.n) * 1.6);
        tooltip.html(`<strong>${d.a} ↔ ${d.b}</strong><br>${d.n} interactions`).style("opacity", 1);
      })
      .on("mousemove", (event) => {
        const [px, py] = d3.pointer(event, document.body);
        tooltip.style("left", `${px + 12}px`).style("top", `${py + 12}px`);
      })
      .on("mouseleave", function (_e, d) {
        d3.select(this).attr("filter", null).attr("stroke-opacity", opacityScale(d.n))
          .attr("stroke-width", widthScale(d.n));
        tooltip.style("opacity", 0);
      });

    arcSel.merge(enter as any)
      .transition().duration(200).ease(d3.easeCubicOut)
      .attr("stroke-opacity", (d) => opacityScale(d.n))
      .attr("stroke-width", (d) => widthScale(d.n));

    const involvedPids = new Set<number>();
    for (const e of ordered) { involvedPids.add(e.a); involvedPids.add(e.b); }
    const points = [...involvedPids]
      .filter((pid) => residenceXY.has(pid))
      .map((pid) => ({ pid, xy: residenceXY.get(pid)! }));

    const ptSel = endpointsLayer.selectAll<SVGCircleElement, typeof points[number]>("circle")
      .data(points, (d: any) => endpointKey(d.pid));

    ptSel.exit().transition().duration(150).attr("r", 0).remove();

    ptSel.enter().append("circle")
      .attr("cx", (d) => d.xy[0])
      .attr("cy", (d) => -d.xy[1])
      .attr("r", 0).attr("fill", "#000").attr("stroke", "#fff").attr("stroke-width", 0.5)
      .attr("vector-effect", "non-scaling-stroke")
      .transition().duration(200).ease(d3.easeCubicOut).attr("r", 2.5);
  }

  // Employer dots ----------------------------------------------------
  const wageColor = d3.scaleSequential(d3.interpolateOrRd).domain([10, 50]);
  const sizeScale = d3.scaleSqrt().domain([1, 9]).range([25, 70]);
  const employeesByEmployer = new Map<number, number[]>();
  for (const [pidStr, e] of Object.entries(employment)) {
    if (e.employerId == null) continue;
    if (!employeesByEmployer.has(e.employerId)) employeesByEmployer.set(e.employerId, []);
    employeesByEmployer.get(e.employerId)!.push(Number(pidStr));
  }

  const employerDots = root.append("g")
    .attr("class", "employers")
    .selectAll<SVGCircleElement, EmployerStat>("circle")
    .data(employers.filter((e) => e.point !== null))
    .join("circle")
    .attr("cx", (d) => d.point![0])
    .attr("cy", (d) => -d.point![1])
    .attr("r", (d) => sizeScale(d.n_jobs))
    .attr("fill", (d) => wageColor(d.avg_wage))
    .attr("stroke", "#444")
    .attr("stroke-width", 0.5)
    .attr("vector-effect", "non-scaling-stroke")
    .style("cursor", "pointer")
    .on("mouseenter", function (_e, d) {
      d3.select(this).attr("stroke", "#000").attr("stroke-width", 1.5);
      const employees = employeesByEmployer.get(d.employerId) ?? [];
      tooltip.html(
        `<strong>Employer #${d.employerId}</strong><br>` +
        `${d.n_jobs} jobs · ${employees.length} known employees<br>` +
        `Wages: $${d.min_wage.toFixed(0)}–$${d.max_wage.toFixed(0)}/hr (avg $${d.avg_wage.toFixed(0)})`,
      ).style("opacity", 1);
    })
    .on("mousemove", (event) => {
      const [px, py] = d3.pointer(event, document.body);
      tooltip.style("left", `${px + 12}px`).style("top", `${py + 12}px`);
    })
    .on("mouseleave", function () { applySelection(selection.get()); tooltip.style("opacity", 0); })
    .on("click", (event, d) => {
      if ((event as MouseEvent).shiftKey) return;
      event.stopPropagation();
      const employees = employeesByEmployer.get(d.employerId) ?? [];
      if (employees.length === 0) return;
      selection.setIds(employees, { kind: "employer", employerId: d.employerId });
    });

  // Selection styling ----------------------------------------------------
  function styleBuildings(sel: ReadonlySet<number>, source: SelectionSource) {
    paths
      .attr("fill", (d) => fillForBuilding(d))
      .attr("fill-opacity", (d) => {
        const baseOpacity = isLowConfidence(d) ? 0.55 : 1;
        if (sel.size === 0) return baseOpacity;
        const residents = residentsByBuilding.get(d.buildingId) ?? [];
        return residents.some((pid) => sel.has(pid)) ? baseOpacity : baseOpacity * 0.25;
      })
      .attr("stroke", (d) => {
        const isSource = (source as any)?.kind === "building" && (source as any).buildingId === d.buildingId;
        if (isSource) return "#ffd700";
        if (sel.size === 0) return "#666";
        const residents = residentsByBuilding.get(d.buildingId) ?? [];
        return residents.some((pid) => sel.has(pid)) ? "#000" : "#666";
      })
      .attr("stroke-width", (d) => {
        const isSource = (source as any)?.kind === "building" && (source as any).buildingId === d.buildingId;
        if (isSource) return 3;
        if (sel.size === 0) return 0.6;
        const residents = residentsByBuilding.get(d.buildingId) ?? [];
        return residents.some((pid) => sel.has(pid)) ? 1.5 : 0.6;
      });
    hatchPaths.attr("fill", (d) => isLowConfidence(d) ? "url(#low-confidence-hatch)" : "none");
  }

  function styleEmployers(sel: ReadonlySet<number>, source: SelectionSource) {
    employerDots
      .attr("fill-opacity", (d) => {
        if (sel.size === 0) return 1;
        const employees = employeesByEmployer.get(d.employerId) ?? [];
        return employees.some((pid) => sel.has(pid)) ? 1 : 0.15;
      })
      .attr("stroke", (d) => {
        const isSource = (source as any)?.kind === "employer" && (source as any).employerId === d.employerId;
        if (isSource) return "#ffd700";
        if (sel.size === 0) return "#444";
        const employees = employeesByEmployer.get(d.employerId) ?? [];
        return employees.some((pid) => sel.has(pid)) ? "#000" : "#444";
      })
      .attr("stroke-width", (d) => {
        const isSource = (source as any)?.kind === "employer" && (source as any).employerId === d.employerId;
        if (isSource) return 4;
        if (sel.size === 0) return 0.5;
        const employees = employeesByEmployer.get(d.employerId) ?? [];
        return employees.some((pid) => sel.has(pid)) ? 1.5 : 0.5;
      })
      .attr("r", (d) => {
        const isSource = (source as any)?.kind === "employer" && (source as any).employerId === d.employerId;
        const baseR = sizeScale(d.n_jobs);
        return isSource ? baseR * 1.4 : baseR;
      });
  }

  function applySelection(s: Selection) {
    styleBuildings(s.participantIds, s.source);
    styleEmployers(s.participantIds, s.source);
    renderArcs(s.participantIds);

    // Clean up leftover lasso rectangle if selection is no longer
    // sourced from a region (user clicked elsewhere, etc.)
    if (lassoRect && (s.source as any)?.kind !== "region") {
      lassoRect.remove();
      lassoRect = null;
    }
  }

  // Overlay change handler with legend update
  function setOverlay(o: Overlay) {
    currentOverlay = o;
    applySelection(selection.get());
    renderLegend();
  }

  function renderLegend() {
    const host = document.getElementById("overlay-legend") as HTMLElement;
    if (!host) return;
    host.innerHTML = "";
    if (currentOverlay === "type") {
      host.innerHTML = `
        <div style="display:flex;gap:6px;align-items:center;margin:2px 0;">
          <span style="display:inline-block;width:12px;height:12px;background:${TYPE_COLORS.Residental};border:1px solid #666;"></span>Residential
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin:2px 0;">
          <span style="display:inline-block;width:12px;height:12px;background:${TYPE_COLORS.Commercial};border:1px solid #666;"></span>Commercial
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin:2px 0;">
          <span style="display:inline-block;width:12px;height:12px;background:${TYPE_COLORS.School};border:1px solid #666;"></span>School
        </div>
      `;
    } else if (currentOverlay === "joviality") {
      host.appendChild(buildScaleLegend(jovialityScale, [0.42, 0.49, 0.56], demoMeans("mean_joviality"), "Joviality (lower→higher)"));
    } else if (currentOverlay === "group") {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:grid;grid-template-columns:auto auto;gap:2px 8px;";
      Object.entries(INTEREST_COLORS).forEach(([k, c]) => {
        const cell = document.createElement("div");
        cell.style.cssText = "display:flex;gap:4px;align-items:center;";
        cell.innerHTML = `<span style="display:inline-block;width:10px;height:10px;background:${c};border:1px solid #555;"></span>${k}`;
        wrap.appendChild(cell);
      });
      host.appendChild(wrap);
    } else if (currentOverlay === "wage") {
      host.appendChild(buildScaleLegend(wageScale, [10, 22.5, 35], demoMeans("mean_wage"), "Wage ($10 → $35)"));
    }
  }

  function demoMeans(field: "mean_joviality" | "mean_wage"): number[] {
    const out: number[] = [];
    for (const d of demoByBuilding.values()) {
      const v = d[field];
      if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  function buildScaleLegend(
    scale: (n: number) => string,
    domain: [number, number, number] | number[],
    distribution: number[],
    title: string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:140px;";
    const titleEl = document.createElement("div");
    titleEl.style.cssText = "font-size:10px;color:#666;margin-bottom:2px;";
    titleEl.textContent = title;
    wrap.appendChild(titleEl);

    const histH = 24;
    const histW = 140;
    const bins = 20;
    const dMin = domain[0], dMax = domain[domain.length - 1];
    const counts = new Array(bins).fill(0);
    for (const v of distribution) {
      if (v < dMin || v > dMax) continue;
      const idx = Math.min(bins - 1, Math.floor(((v - dMin) / (dMax - dMin)) * bins));
      counts[idx]++;
    }
    const maxCount = Math.max(...counts, 1);
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("width", String(histW));
    svgEl.setAttribute("height", String(histH));
    svgEl.style.display = "block";
    for (let i = 0; i < bins; i++) {
      const x = (i / bins) * histW;
      const w = histW / bins;
      const v = dMin + ((i + 0.5) / bins) * (dMax - dMin);
      const h = (counts[i] / maxCount) * histH;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(histH - h));
      rect.setAttribute("width", String(w - 0.5));
      rect.setAttribute("height", String(h));
      rect.setAttribute("fill", scale(v));
      svgEl.appendChild(rect);
    }
    wrap.appendChild(svgEl);

    const range = document.createElement("div");
    range.style.cssText = "display:flex;justify-content:space-between;font-size:9px;color:#888;";
    range.innerHTML = `<span>${dMin}</span><span>${dMax}</span>`;
    wrap.appendChild(range);

    return wrap;
  }

  toolbar.querySelectorAll<HTMLInputElement>('input[name="overlay"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setOverlay(input.value as Overlay);
    });
  });

  selection.subscribe(applySelection);
  topN.subscribe(() => renderArcs(selection.get().participantIds));
  applySelection(selection.get());
  renderLegend();
}
