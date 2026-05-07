/**
 * Tableau-style fixed dashboard layout: no scrolling, all domain panels
 * visible simultaneously. Map on the left fills full height (~45%
 * width); the right side is a 2x2 grid of domain panels covering the
 * three brief questions plus the contextual employer detail.
 *
 * +--------------------------+----------------+----------------+
 * |                          |  Demographics  |    Social      |
 * |                          |     (Q1)       |     (Q2)       |
 * |          MAP             |                |                |
 * |    (Geography /          +----------------+----------------+
 * |     Relations /          |   Business     |  Selected      |
 * |     3D Heightmap)        |     (Q3)       |  Employer      |
 * |                          |                |  (contextual)  |
 * +--------------------------+----------------+----------------+
 *
 * The 4 panels are always visible — clicking a chart anywhere updates
 * highlighted state across every visible panel. This preserves the
 * full cross-domain coordination that distinguishes this tool from
 * tabbed dashboards where one domain at a time hides the others.
 *
 * Minimum recommended browser size: 1280x800. The grid does not adapt
 * to narrower windows; instead the gutter can be dragged to give the
 * map more or less of the horizontal space.
 */
import { selection } from "./state.ts";

const STORAGE_KEY = "vast-mc1.layout.mapWidth";
const VIEW_KEY = "vast-mc1.layout.activeView";
const DEFAULT_RIGHT_FRACTION = 0.55;

export type ActiveView = "geography" | "relations" | "heightmap";

export interface Layout {
  mapPane: HTMLElement;
  relationsPane: HTMLElement;
  heightmapPane: HTMLElement;
  /** 2x2 grid cells on the right side. */
  demographicsPane: HTMLElement;
  socialPane: HTMLElement;
  businessPane: HTMLElement;
  employerPane: HTMLElement;
  statusBar: HTMLElement;
  setActiveView: (v: ActiveView) => void;
  getActiveView: () => ActiveView;
}

export function buildLayout(root: HTMLElement): Layout {
  root.innerHTML = `
    <header id="header">
      <h1>Engagement, Ohio</h1>
      <span class="subtitle">Challenge 1 Relationships and Demographics 2026</span>
    </header>
    <div id="body">
      <div id="map-area">
        <div id="view-toggle">
          <button data-view="geography" class="view-btn active">Geography</button>
          <button data-view="relations" class="view-btn">Relations</button>
          <button data-view="heightmap" class="view-btn">3D Heightmap</button>
        </div>
        <div id="view-stack">
          <div id="map-pane" class="view-tab"></div>
          <div id="relations-pane" class="view-tab" style="display:none"></div>
          <div id="heightmap-pane" class="view-tab" style="display:none"></div>
        </div>
      </div>
      <div id="gutter"></div>
      <div id="dashboard-grid">
        <div id="demographics-pane" class="grid-cell">
          <div class="grid-cell-header">Demographics <span class="grid-cell-q">Q1</span></div>
          <div class="grid-cell-body"></div>
        </div>
        <div id="social-pane" class="grid-cell">
          <div class="grid-cell-header">Social network <span class="grid-cell-q">Q2</span></div>
          <div class="grid-cell-body"></div>
        </div>
        <div id="business-pane" class="grid-cell">
          <div class="grid-cell-header">Business base <span class="grid-cell-q">Q3</span></div>
          <div class="grid-cell-body"></div>
        </div>
        <div id="employer-pane" class="grid-cell">
          <div class="grid-cell-header">Selected employer <span class="grid-cell-q">contextual</span></div>
          <div class="grid-cell-body"></div>
        </div>
      </div>
    </div>
    <footer id="footer">
      <span id="selection-status">no selection</span>
      <button id="clear-selection" class="btn-link" style="display:none">clear</button>
      <span style="flex:1"></span>
      <button id="reset-layout" class="btn-link">reset layout</button>
    </footer>
  `;

  injectStyles();

  const body = document.getElementById("body")!;
  const gutter = document.getElementById("gutter")!;
  const mapPane = document.getElementById("map-pane")!;
  const relationsPane = document.getElementById("relations-pane")!;
  const heightmapPane = document.getElementById("heightmap-pane")!;
  // Each grid cell exposes its `.grid-cell-body` as the mount target so the
  // header bar isn't overwritten by view code that calls `innerHTML = ""`.
  const demographicsPane = document.querySelector("#demographics-pane .grid-cell-body") as HTMLElement;
  const socialPane = document.querySelector("#social-pane .grid-cell-body") as HTMLElement;
  const businessPane = document.querySelector("#business-pane .grid-cell-body") as HTMLElement;
  const employerPane = document.querySelector("#employer-pane .grid-cell-body") as HTMLElement;
  const statusBar = document.getElementById("footer")!;

  // Initial split: prefer saved value, else default fraction
  const savedWidth = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(savedWidth) && savedWidth > 0) {
    setRightWidth(body, savedWidth);
  } else {
    setRightWidth(body, Math.round(window.innerWidth * DEFAULT_RIGHT_FRACTION));
  }

  installResize(body, gutter);
  installStatusBar(statusBar);

  document.getElementById("reset-layout")!.addEventListener("click", () => {
    setRightWidth(body, Math.round(window.innerWidth * DEFAULT_RIGHT_FRACTION));
    localStorage.removeItem(STORAGE_KEY);
  });

  // ---- Map view toggle ----
  let activeView: ActiveView = (localStorage.getItem(VIEW_KEY) as ActiveView) || "geography";
  if (activeView !== "geography" && activeView !== "relations" && activeView !== "heightmap") {
    activeView = "geography";
  }

  function setActiveView(v: ActiveView) {
    activeView = v;
    localStorage.setItem(VIEW_KEY, v);
    mapPane.style.display = v === "geography" ? "block" : "none";
    relationsPane.style.display = v === "relations" ? "block" : "none";
    heightmapPane.style.display = v === "heightmap" ? "block" : "none";
    document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === v);
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view as ActiveView));
  });

  setActiveView(activeView);

  // ---- Highlight Selected Employer cell when it has content ----
  selection.subscribe((sel) => {
    const empCell = document.getElementById("employer-pane");
    if (!empCell) return;
    const isEmployer = sel.source?.kind === "employer";
    empCell.classList.toggle("contextual-active", isEmployer);
    const q = empCell.querySelector(".grid-cell-q") as HTMLElement | null;
    if (q) {
      q.textContent = isEmployer && sel.source!.kind === "employer"
        ? `#${sel.source!.employerId}`
        : "contextual";
    }
  });

  return {
    mapPane,
    relationsPane,
    heightmapPane,
    demographicsPane,
    socialPane,
    businessPane,
    employerPane,
    statusBar,
    setActiveView,
    getActiveView: () => activeView,
  };
}

function injectStyles() {
  if (document.getElementById("layout-grid-styles")) return;
  const style = document.createElement("style");
  style.id = "layout-grid-styles";
  style.textContent = `
    /* The body grid: header / [ map | gutter | dashboard ] / footer.
       Already declared globally as #body grid-template-areas;
       here we ensure both columns and rows fill height with no scrolling. */
    #body {
      grid-template-areas: "map gutter right";
      min-height: 0;
      overflow: hidden;
    }
    #map-area {
      grid-area: map;
      position: relative;
      background: #fafafa;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    #view-toggle {
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      background: #fff;
      border-bottom: 1px solid var(--border-subtle);
      flex: 0 0 auto;
    }
    #view-toggle .view-btn {
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      border: 1px solid #ccc;
      border-radius: 3px;
      cursor: pointer;
      color: #555;
    }
    #view-toggle .view-btn:hover { background: #f0f0f0; }
    #view-toggle .view-btn.active {
      background: #444;
      color: white;
      border-color: #444;
    }
    #view-stack { flex: 1; position: relative; overflow: hidden; min-height: 0; }
    .view-tab {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }

    /* 2x2 dashboard grid taking the right area, full height, no scroll */
    #dashboard-grid {
      grid-area: right;
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      gap: 8px;
      padding: 8px;
      background: var(--bg-elevated);
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    .grid-cell {
      background: var(--bg-section);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      transition: box-shadow var(--duration-base) var(--ease),
                  border-color var(--duration-base) var(--ease);
    }
    .grid-cell:hover {
      box-shadow: var(--shadow-md);
    }
    .grid-cell-header {
      flex: 0 0 auto;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-section);
    }
    .grid-cell-q {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-tertiary);
      letter-spacing: 0;
      text-transform: none;
      padding: 2px 6px;
      background: var(--bg-elevated);
      border-radius: 10px;
    }
    .grid-cell-body {
      flex: 1;
      min-height: 0;
      min-width: 0;
      padding: 10px 12px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .grid-cell-body::-webkit-scrollbar { width: 6px; height: 6px; }
    .grid-cell-body::-webkit-scrollbar-track { background: transparent; }
    .grid-cell-body::-webkit-scrollbar-thumb {
      background: var(--border-default);
      border-radius: 3px;
    }
    /* When an employer is selected, give the contextual cell a subtle accent */
    .grid-cell.contextual-active {
      border-color: var(--accent-emphasis);
    }
    .grid-cell.contextual-active .grid-cell-q {
      background: var(--accent-emphasis);
      color: white;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
}

function setRightWidth(body: HTMLElement, rightPx: number) {
  const min = 480;
  const max = window.innerWidth - 400;
  const clamped = Math.max(min, Math.min(max, rightPx));
  body.style.gridTemplateColumns = `1fr 6px ${clamped}px`;
}

function installResize(body: HTMLElement, gutter: HTMLElement) {
  let dragging = false;
  gutter.addEventListener("mousedown", (e) => {
    dragging = true;
    gutter.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newRight = window.innerWidth - e.clientX;
    setRightWidth(body, newRight);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove("dragging");
    const cols = body.style.gridTemplateColumns.split(" ");
    const rightPx = parseFloat(cols[2]);
    if (Number.isFinite(rightPx)) {
      localStorage.setItem(STORAGE_KEY, String(rightPx));
    }
  });
}

function installStatusBar(footer: HTMLElement) {
  const status = footer.querySelector("#selection-status") as HTMLElement;
  const clear = footer.querySelector("#clear-selection") as HTMLElement;

  selection.subscribe((sel) => {
    if (sel.isEmpty) {
      status.textContent = "no selection";
      clear.style.display = "none";
    } else {
      const count = `${sel.participantIds.size} participants selected`;
      const sourceLabel = sel.source
        ? sel.source.kind === "employer"
          ? ` · via employer #${sel.source.employerId}`
          : sel.source.kind === "building"
          ? ` · via building #${sel.source.buildingId}`
          : sel.source.kind === "chart"
          ? ` · via chart`
          : ""
        : "";
      status.textContent = count + sourceLabel;
      clear.style.display = "inline";
    }
  });

  clear.addEventListener("click", () => selection.clear());
}

/**
 * Backward-compatible helper. With the grid layout each cell already has
 * its own header bar (rendered by buildLayout), so addSection becomes a
 * no-op that simply returns the body element so existing view code
 * continues to mount correctly.
 */
export function addSection(cellBody: HTMLElement, _title: string): HTMLElement {
  return cellBody;
}
