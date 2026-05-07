/**
 * 3D heightmap view.
 *
 * Each residential building is extruded as a prism:
 *   - Height = mean wage of residents (continuous)
 *   - Color  = mean joviality of residents (sequential plasma)
 *
 * Non-residential buildings render as flat low gray prisms for context.
 *
 * Camera controls:
 *   - Left-drag: pan
 *   - Right-drag (or shift+left-drag): orbit
 *   - Wheel: zoom
 *   - Reset (⟲) button restores default isometric view
 *
 * Selection-driven arcs:
 *   When the selection is non-empty, the top 80 friendship pairs render
 *   as curves bowing over the city. Hot pink → vivid orange gradient
 *   matches the 2D map arcs.
 *
 *   Arcs always reveal with a short draw-on animation. After the reveal,
 *   the "Animate arcs" toggle controls whether dashes continue flowing
 *   (ON, more visually striking but uses GPU) or freeze (OFF, default,
 *   battery-friendly).
 *
 *   The render loop only runs while it has work to do — it stops
 *   automatically when selection clears, when reveal completes (if
 *   toggle is OFF), or when the page is hidden.
 */
import * as THREE from "three";
import * as d3 from "d3";
import { apiGet } from "../api.ts";
import { selection } from "../state.ts";
import type { Selection } from "../state.ts";

interface Building {
  buildingId: number;
  buildingType: string;
  rings: [number, number][][];
}

interface BuildingDemo {
  buildingId: number;
  n_residents: number;
  mean_age: number;
  mean_joviality: number;
  mean_wage: number | null;
  dominant_group: string;
}

interface Edge { a: number; b: number; n: number; }

type ResidencyMap = Record<number, number>;

const MIN_RESIDENTS_FOR_CONFIDENCE = 3;
const WAGE_MIN = 10;
const WAGE_MAX = 35;
const HEIGHT_MIN = 8;
const HEIGHT_MAX = 200;
const NONRES_HEIGHT = 4;

const ARC_TOP_LIMIT = 80;
const ARC_COLOR_START = new THREE.Color("#ff3366"); // hot pink (source)
const ARC_COLOR_END = new THREE.Color("#ff8c42");   // vivid orange (target)
const ANIMATE_KEY = "vast-mc1.heightmap.animateArcs";

export async function renderHeightmap(container: HTMLElement) {
  const [buildings, buildingDemo, residency, edges] = await Promise.all([
    apiGet<Building[]>("/derived/buildings.json"),
    apiGet<BuildingDemo[]>("/derived/building_demographics.json"),
    apiGet<ResidencyMap>("/derived/residency.json"),
    apiGet<Edge[]>("/derived/social_edges.json"),
  ]);

  const demoByBuilding = new Map<number, BuildingDemo>();
  for (const d of buildingDemo) demoByBuilding.set(d.buildingId, d);

  const residentsByBuilding = new Map<number, number[]>();
  for (const [pidStr, bid] of Object.entries(residency)) {
    if (!residentsByBuilding.has(bid)) residentsByBuilding.set(bid, []);
    residentsByBuilding.get(bid)!.push(Number(pidStr));
  }

  drawHeightmap(container, buildings, demoByBuilding, residentsByBuilding, residency, edges);
}

function drawHeightmap(
  target: HTMLElement,
  buildings: Building[],
  demoByBuilding: Map<number, BuildingDemo>,
  residentsByBuilding: Map<number, number[]>,
  residency: ResidencyMap,
  edges: Edge[],
) {
  target.style.position = "relative";
  target.style.height = "100%";
  target.style.minHeight = "500px";
  target.innerHTML = "";

  // World bounds
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
  const worldCenterX = (minX + maxX) / 2;
  const worldCenterY = (minY + maxY) / 2;
  const worldSize = Math.max(maxX - minX, maxY - minY);

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfafafa);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.cssText = "position:absolute;inset:0;display:block;";
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  target.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, worldSize * 10);
  let azimuth = Math.PI / 4;
  let elevation = Math.PI / 180 * 35;
  const ELEV_MIN = Math.PI / 180 * 8;
  const ELEV_MAX = Math.PI / 180 * 88;

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.55);
  dir.position.set(worldSize, worldSize * 1.5, worldSize * 0.7);
  dir.target.position.set(0, 0, 0);
  dir.castShadow = true;
  const shadowCam = dir.shadow.camera as THREE.OrthographicCamera;
  shadowCam.left = -worldSize / 2;
  shadowCam.right = worldSize / 2;
  shadowCam.top = worldSize / 2;
  shadowCam.bottom = -worldSize / 2;
  shadowCam.near = 1;
  shadowCam.far = worldSize * 4;
  dir.shadow.mapSize.set(2048, 2048);
  scene.add(dir);
  scene.add(dir.target);

  // Ground
  const groundGeom = new THREE.PlaneGeometry(worldSize * 1.05, worldSize * 1.05);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  scene.add(ground);

  // Color & height scales
  const jovialityScale = d3.scaleSequential(d3.interpolatePlasma)
    .domain([0.42, 0.56]);
  const heightScale = d3.scaleLinear()
    .domain([WAGE_MIN, WAGE_MAX])
    .range([HEIGHT_MIN, HEIGHT_MAX])
    .clamp(true);

  // Build extruded buildings
  const buildingsGroup = new THREE.Group();
  scene.add(buildingsGroup);

  type BuildingMesh = {
    mesh: THREE.Mesh;
    buildingId: number;
    buildingType: string;
    baseColor: THREE.Color;
    baseHeight: number;
    baseOpacity: number;
    isResidential: boolean;
  };
  const meshByBuilding = new Map<number, BuildingMesh>();

  for (const b of buildings) {
    const demo = demoByBuilding.get(b.buildingId);

    let height: number;
    let color: string;
    let opacity = 1.0;
    const isResidential = b.buildingType === "Residental";

    if (isResidential) {
      if (demo && demo.mean_wage != null) {
        height = heightScale(demo.mean_wage);
        color = jovialityScale(demo.mean_joviality);
        if (demo.n_residents < MIN_RESIDENTS_FOR_CONFIDENCE) opacity = 0.45;
      } else {
        height = HEIGHT_MIN;
        color = "#cccccc";
        opacity = 0.4;
      }
    } else if (b.buildingType === "Commercial") {
      height = NONRES_HEIGHT;
      color = "#bdbdbd";
    } else if (b.buildingType === "School") {
      height = NONRES_HEIGHT * 1.5;
      color = "#e08e45";
    } else {
      height = NONRES_HEIGHT;
      color = "#cccccc";
    }

    const ring0 = b.rings[0];
    if (!ring0 || ring0.length < 3) continue;

    const shape = new THREE.Shape();
    shape.moveTo(ring0[0][0] - worldCenterX, -(ring0[0][1] - worldCenterY));
    for (let i = 1; i < ring0.length; i++) {
      shape.lineTo(ring0[i][0] - worldCenterX, -(ring0[i][1] - worldCenterY));
    }
    shape.closePath();

    for (let r = 1; r < b.rings.length; r++) {
      const hole = b.rings[r];
      if (hole.length < 3) continue;
      const holePath = new THREE.Path();
      holePath.moveTo(hole[0][0] - worldCenterX, -(hole[0][1] - worldCenterY));
      for (let i = 1; i < hole.length; i++) {
        holePath.lineTo(hole[i][0] - worldCenterX, -(hole[i][1] - worldCenterY));
      }
      holePath.closePath();
      shape.holes.push(holePath);
    }

    const extrudeSettings = { depth: height, bevelEnabled: false, curveSegments: 1 };
    const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geom.rotateX(-Math.PI / 2);

    const baseColor = new THREE.Color(color);
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor.clone(),
      transparent: true,
      opacity,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.buildingId = b.buildingId;
    buildingsGroup.add(mesh);

    meshByBuilding.set(b.buildingId, {
      mesh,
      buildingId: b.buildingId,
      buildingType: b.buildingType,
      baseColor: baseColor.clone(),
      baseHeight: height,
      baseOpacity: opacity,
      isResidential,
    });
  }

  // Residence centroids in scene-space.
  //
  // Building geometry path: shape vertices are stored at (x - wcX, -(y - wcY))
  // in the 2D Shape. Then rotateX(-PI/2) rotates the extruded mesh 90°,
  // which sends shape's Y axis to -Z. The net effect on a vertex is:
  //   shape (sx, sy)  →  scene (sx, 0, -sy)  =  scene (x - wcX, 0, y - wcY)
  // So in scene space, building Z = +(y - wcY), NOT negated.
  //
  // Arcs aren't subject to that rotation, so they must use the same final
  // scene coordinates directly — without re-negating.
  const residenceXY = new Map<number, [number, number]>();
  const buildingById = new Map(buildings.map((b) => [b.buildingId, b]));
  for (const [pidStr, bid] of Object.entries(residency)) {
    const b = buildingById.get(bid);
    if (!b || !b.rings.length) continue;
    const ring = b.rings[0];
    if (ring.length === 0) continue;
    let sumX = 0, sumY = 0;
    for (const [x, y] of ring) { sumX += x; sumY += y; }
    const wcx = sumX / ring.length;
    const wcy = sumY / ring.length;
    const sceneX = wcx - worldCenterX;
    const sceneZ = wcy - worldCenterY;  // matches building's final position
    residenceXY.set(Number(pidStr), [sceneX, sceneZ]);
  }

  // ===========================================================
  // Arc rendering
  // ===========================================================
  // Arcs are drawn as TubeGeometry meshes along quadratic Bezier curves
  // that bow upward over the city. Each arc has its own shader material
  // with uniforms for time-based dash flow and reveal progress, so we
  // can animate dashes flowing along the curve and have arcs grow in
  // when first drawn.
  const arcsGroup = new THREE.Group();
  scene.add(arcsGroup);

  const arcVertexShader = `
    varying float vT;
    varying vec3 vColor;
    attribute float t;
    attribute vec3 colorAttr;
    void main() {
      vT = t;
      vColor = colorAttr;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const arcFragmentShader = `
    precision mediump float;
    uniform float u_time;
    uniform float u_reveal;     // 0..1 — fraction of arc revealed
    uniform float u_animated;   // 1.0 = animate dash flow, 0.0 = static
    uniform float u_dashLen;    // 0..1 dash length along arc
    uniform float u_gapLen;     // 0..1 gap length along arc
    varying float vT;
    varying vec3 vColor;
    void main() {
      // Hide pixels past the reveal front
      if (vT > u_reveal) discard;

      // Compute dash phase along arc
      float cycle = u_dashLen + u_gapLen;
      float flow = u_animated > 0.5 ? u_time : 0.0;
      float phase = mod(vT - flow, cycle);
      if (phase > u_dashLen) discard;

      // Soften dash edges (anti-alias the on/off transition)
      float edgeSoft = 0.02;
      float dashAlpha = smoothstep(0.0, edgeSoft, phase) *
                        smoothstep(0.0, edgeSoft, u_dashLen - phase);

      gl_FragColor = vec4(vColor, dashAlpha);
    }
  `;

  // Arc tube parameters
  const ARC_RADIUS = worldSize * 0.0025;   // tube thickness in world units
  const ARC_TUBE_SEGMENTS = 48;            // longitudinal samples
  const ARC_TUBE_RADIAL = 5;               // tube cross-section
  const ARC_PEAK_FACTOR = 0.25;            // peak height / arc-length
  const ARC_PEAK_MIN = 80;                 // minimum peak height (above tallest buildings)

  type ArcMesh = {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    edge: Edge;
  };
  let activeArcs: ArcMesh[] = [];

  function clearArcs() {
    for (const a of activeArcs) {
      arcsGroup.remove(a.mesh);
      a.mesh.geometry.dispose();
      a.material.dispose();
    }
    activeArcs = [];
  }

  function buildArcs(selectedIds: ReadonlySet<number>) {
    clearArcs();
    if (selectedIds.size === 0) return;

    // Pick top 80 friendships involving selection
    const filtered: Edge[] = [];
    for (const e of edges) {
      if (!selectedIds.has(e.a) && !selectedIds.has(e.b)) continue;
      if (!residenceXY.has(e.a) || !residenceXY.has(e.b)) continue;
      filtered.push(e);
    }
    filtered.sort((p, q) => q.n - p.n);
    const top = filtered.slice(0, ARC_TOP_LIMIT);

    for (const e of top) {
      const [ax, az] = residenceXY.get(e.a)!;
      const [bx, bz] = residenceXY.get(e.b)!;
      const dx = bx - ax;
      const dz = bz - az;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const peakY = Math.max(ARC_PEAK_MIN, dist * ARC_PEAK_FACTOR);
      const midX = (ax + bx) / 2;
      const midZ = (az + bz) / 2;

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(ax, 4, az),
        new THREE.Vector3(midX, peakY, midZ),
        new THREE.Vector3(bx, 4, bz),
      );
      const tubeGeom = new THREE.TubeGeometry(
        curve, ARC_TUBE_SEGMENTS, ARC_RADIUS, ARC_TUBE_RADIAL, false,
      );

      // Per-vertex `t` (0..1 along arc) and color (gradient pink→orange).
      // TubeGeometry vertices are laid out as (segments+1) rings of
      // (radial+1) vertices. Compute t per ring index.
      const posCount = tubeGeom.attributes.position.count;
      const tArr = new Float32Array(posCount);
      const colorArr = new Float32Array(posCount * 3);
      const ringStride = ARC_TUBE_RADIAL + 1;
      for (let i = 0; i < posCount; i++) {
        const ringIdx = Math.floor(i / ringStride);
        const t = ringIdx / ARC_TUBE_SEGMENTS;
        tArr[i] = t;
        const color = ARC_COLOR_START.clone().lerp(ARC_COLOR_END, t);
        colorArr[i * 3 + 0] = color.r;
        colorArr[i * 3 + 1] = color.g;
        colorArr[i * 3 + 2] = color.b;
      }
      tubeGeom.setAttribute("t", new THREE.BufferAttribute(tArr, 1));
      tubeGeom.setAttribute("colorAttr", new THREE.BufferAttribute(colorArr, 3));

      const material = new THREE.ShaderMaterial({
        uniforms: {
          u_time:     { value: 0.0 },
          u_reveal:   { value: 0.0 },
          u_animated: { value: animateArcs ? 1.0 : 0.0 },
          u_dashLen:  { value: 0.04 },
          u_gapLen:   { value: 0.06 },
        },
        vertexShader: arcVertexShader,
        fragmentShader: arcFragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(tubeGeom, material);
      arcsGroup.add(mesh);
      activeArcs.push({ mesh, material, edge: e });
    }
  }

  // ===========================================================
  // Render loop control
  // ===========================================================
  let animateArcs = localStorage.getItem(ANIMATE_KEY) === "1";
  let revealStart = 0;
  let revealDuration = 800;     // ms
  let revealing = false;
  let needsRender = false;
  let pageVisible = !document.hidden;
  let rafId: number | null = null;

  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
    if (pageVisible) requestRenderIfNeeded();
  });

  function loopShouldRun(): boolean {
    if (!pageVisible) return false;
    if (activeArcs.length === 0) return false;
    if (revealing) return true;
    if (animateArcs) return true;
    return false;
  }

  function requestRenderIfNeeded() {
    if (rafId !== null) return;
    if (!loopShouldRun() && !needsRender) return;
    rafId = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    rafId = null;

    let revealValue = 1.0;
    if (revealing) {
      const elapsed = now - revealStart;
      revealValue = Math.min(1.0, elapsed / revealDuration);
      // ease-out for a nicer draw-on
      revealValue = 1.0 - Math.pow(1.0 - revealValue, 3.0);
      if (elapsed >= revealDuration) revealing = false;
    }

    const flow = (now / 1000) * 0.4; // dash phase moves 0.4 cycles per second

    for (const a of activeArcs) {
      a.material.uniforms.u_time.value = flow;
      a.material.uniforms.u_reveal.value = revealValue;
      a.material.uniforms.u_animated.value = animateArcs ? 1.0 : 0.0;
    }

    renderScene();

    if (loopShouldRun()) {
      rafId = requestAnimationFrame(tick);
    }
  }

  // ===========================================================
  // Camera
  // ===========================================================
  let zoom = 1;
  let panX = 0;
  let panZ = 0;
  let cssW = 0;
  let cssH = 0;

  function applyCamera(): boolean {
    cssW = target.clientWidth;
    cssH = target.clientHeight;
    if (cssW <= 0 || cssH <= 0) return false;

    renderer.setSize(cssW, cssH, false);
    const aspect = cssW / cssH;
    const halfHeight = (worldSize * 0.7) / zoom;
    const halfWidth = halfHeight * aspect;

    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.near = 0.1;
    camera.far = worldSize * 10;

    const camRadius = worldSize * 1.5;
    camera.position.set(
      Math.sin(azimuth) * Math.cos(elevation) * camRadius + panX,
      Math.sin(elevation) * camRadius,
      Math.cos(azimuth) * Math.cos(elevation) * camRadius + panZ,
    );
    camera.lookAt(panX, 0, panZ);
    camera.updateProjectionMatrix();

    renderScene();
    return true;
  }

  function renderScene() {
    renderer.render(scene, camera);
  }

  // ===========================================================
  // Raycasting & hover
  // ===========================================================
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoveredId: number | null = null;

  const tooltip = document.createElement("div");
  tooltip.style.cssText =
    "position:absolute;padding:6px 10px;background:rgba(0,0,0,0.85);color:white;" +
    "font-size:12px;border-radius:3px;pointer-events:none;opacity:0;" +
    "transition:opacity 0.1s;white-space:nowrap;z-index:20;";
  target.appendChild(tooltip);

  function raycast(event: MouseEvent): BuildingMesh | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(buildingsGroup.children, false);
    if (intersects.length === 0) return null;
    const id = intersects[0].object.userData.buildingId as number;
    return meshByBuilding.get(id) ?? null;
  }

  function setHovered(bm: BuildingMesh | null) {
    if (hoveredId === (bm?.buildingId ?? null)) return;
    if (hoveredId !== null) {
      const prev = meshByBuilding.get(hoveredId);
      if (prev) prev.mesh.position.y = 0;
    }
    hoveredId = bm?.buildingId ?? null;
    if (bm) {
      bm.mesh.position.y = bm.baseHeight * 0.05;
    }
    applyCamera();
  }

  // ===========================================================
  // Pan / Orbit / Zoom
  // ===========================================================
  type DragMode = null | "pan" | "orbit";
  let dragMode: DragMode = null;
  let lastX = 0;
  let lastY = 0;
  let mouseDownPos = { x: 0, y: 0 };

  renderer.domElement.addEventListener("mousedown", (e) => {
    mouseDownPos = { x: e.clientX, y: e.clientY };
    lastX = e.clientX;
    lastY = e.clientY;

    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      dragMode = "orbit";
      renderer.domElement.style.cursor = "move";
    } else if (e.button === 0) {
      dragMode = "pan";
      renderer.domElement.style.cursor = "grabbing";
    }
  });

  renderer.domElement.addEventListener("mousemove", (e) => {
    if (dragMode === null) {
      const bm = raycast(e);
      setHovered(bm);

      if (bm) {
        const demo = demoByBuilding.get(bm.buildingId);
        const residents = residentsByBuilding.get(bm.buildingId) ?? [];
        let body = `<strong>Building #${bm.buildingId}</strong><br>Type: ${bm.buildingType}`;
        if (bm.isResidential) {
          body += `<br>Residents: ${residents.length}`;
          if (demo) {
            if (demo.mean_wage != null) body += `<br>Mean wage: $${demo.mean_wage.toFixed(1)}/hr`;
            body += `<br>Mean joviality: ${demo.mean_joviality.toFixed(2)}`;
            body += `<br>Dominant group: ${demo.dominant_group}`;
            if (demo.n_residents < MIN_RESIDENTS_FOR_CONFIDENCE) {
              body += `<br><em style="opacity:0.7">(low confidence: ${demo.n_residents} residents)</em>`;
            }
          }
        }
        tooltip.innerHTML = body;
        const rect = target.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left + 12}px`;
        tooltip.style.top = `${e.clientY - rect.top + 12}px`;
        tooltip.style.opacity = "1";
        renderer.domElement.style.cursor = "pointer";
      } else {
        tooltip.style.opacity = "0";
        renderer.domElement.style.cursor = "grab";
      }
      return;
    }

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (dragMode === "pan") {
      const panScale = (worldSize / 800) / zoom;
      const rightX = -Math.cos(azimuth);
      const rightZ = Math.sin(azimuth);
      const downX = Math.sin(azimuth);
      const downZ = Math.cos(azimuth);
      panX -= dx * panScale * rightX + dy * panScale * downX;
      panZ -= dx * panScale * rightZ + dy * panScale * downZ;
    } else if (dragMode === "orbit") {
      const azimuthSpeed = 0.5 * Math.PI / 180;
      const elevSpeed = 0.5 * Math.PI / 180;
      azimuth -= dx * azimuthSpeed;
      elevation -= dy * elevSpeed;
      elevation = Math.max(ELEV_MIN, Math.min(ELEV_MAX, elevation));
    }
    applyCamera();
  });

  window.addEventListener("mouseup", () => {
    dragMode = null;
    renderer.domElement.style.cursor = "grab";
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    setHovered(null);
    tooltip.style.opacity = "0";
  });

  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoom = Math.max(0.3, Math.min(8, zoom));
    applyCamera();
  });

  renderer.domElement.style.cursor = "grab";

  renderer.domElement.addEventListener("click", (e) => {
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > 4) return;
    const bm = raycast(e);
    if (!bm || !bm.isResidential) return;
    const residents = residentsByBuilding.get(bm.buildingId) ?? [];
    if (residents.length === 0) return;
    selection.setIds(residents, { kind: "building", buildingId: bm.buildingId });
  });

  // ===========================================================
  // Top-right toolbar (camera reset + animate-arcs toggle)
  // ===========================================================
  const camToolbar = document.createElement("div");
  camToolbar.style.cssText =
    "position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px;" +
    "background:#fff;padding:4px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,0.08);" +
    "border:1px solid #ddd;z-index:10;";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⟲";
  resetBtn.title = "Reset camera";
  resetBtn.style.cssText =
    "width:28px;height:28px;border:none;background:transparent;cursor:pointer;" +
    "border-radius:3px;font-size:14px;color:#555;font-weight:500;";
  resetBtn.addEventListener("mouseenter", () => { resetBtn.style.background = "#e0f2ee"; });
  resetBtn.addEventListener("mouseleave", () => { resetBtn.style.background = "transparent"; });
  resetBtn.addEventListener("click", () => {
    azimuth = Math.PI / 4;
    elevation = Math.PI / 180 * 35;
    panX = 0;
    panZ = 0;
    zoom = 1;
    applyCamera();
  });
  camToolbar.appendChild(resetBtn);

  const animBtn = document.createElement("button");
  function refreshAnimBtn() {
    animBtn.textContent = animateArcs ? "✦" : "○";
    animBtn.title = animateArcs
      ? "Animate arcs: ON (click to disable, saves GPU)"
      : "Animate arcs: OFF (click to enable flowing dashes)";
    animBtn.style.color = animateArcs ? "#ff3366" : "#888";
  }
  animBtn.style.cssText =
    "width:28px;height:28px;border:none;background:transparent;cursor:pointer;" +
    "border-radius:3px;font-size:16px;font-weight:500;";
  animBtn.addEventListener("mouseenter", () => { animBtn.style.background = "#e0f2ee"; });
  animBtn.addEventListener("mouseleave", () => { animBtn.style.background = "transparent"; });
  animBtn.addEventListener("click", () => {
    animateArcs = !animateArcs;
    localStorage.setItem(ANIMATE_KEY, animateArcs ? "1" : "0");
    refreshAnimBtn();
    for (const a of activeArcs) {
      a.material.uniforms.u_animated.value = animateArcs ? 1.0 : 0.0;
    }
    requestRenderIfNeeded();
  });
  refreshAnimBtn();
  camToolbar.appendChild(animBtn);

  target.appendChild(camToolbar);

  // ===========================================================
  // Selection-driven styling
  // ===========================================================
  const goldColor = new THREE.Color("#ffd700");

  function applySelection(s: Selection) {
    const sids = s.participantIds;
    const isEmpty = s.isEmpty;
    const source = s.source;

    for (const bm of meshByBuilding.values()) {
      const isSourceBuilding = (source as any)?.kind === "building" && (source as any).buildingId === bm.buildingId;
      const residents = residentsByBuilding.get(bm.buildingId) ?? [];
      const inSelection = isEmpty || residents.some((pid) => sids.has(pid));

      const mat = bm.mesh.material as THREE.MeshStandardMaterial;

      if (isSourceBuilding) {
        mat.color.copy(goldColor);
        mat.opacity = 1;
        mat.emissive = goldColor.clone().multiplyScalar(0.3);
      } else if (inSelection) {
        mat.color.copy(bm.baseColor);
        mat.opacity = bm.baseOpacity;
        mat.emissive = new THREE.Color(0x000000);
      } else {
        mat.color.copy(bm.baseColor).lerp(new THREE.Color(0x999999), 0.7);
        mat.opacity = bm.baseOpacity * 0.25;
        mat.emissive = new THREE.Color(0x000000);
      }
      mat.needsUpdate = true;
    }

    // Build/clear arcs and trigger reveal
    buildArcs(sids);
    if (activeArcs.length > 0) {
      revealStart = performance.now();
      revealing = true;
      requestRenderIfNeeded();
    }

    applyCamera();
  }

  // Info banner
  const info = document.createElement("div");
  info.style.cssText =
    "position:absolute;top:8px;left:8px;background:rgba(255,255,255,0.95);" +
    "padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:11px;" +
    "z-index:5;box-shadow:0 1px 3px rgba(0,0,0,0.08);max-width:280px;";
  info.innerHTML = `
    <div style="font-weight:600;color:#444;margin-bottom:4px;">3D Heightmap</div>
    <div style="color:#555;line-height:1.4;">
      <strong>Height</strong> = mean wage of residents<br>
      <strong>Color</strong> = mean joviality (plasma)<br>
      <em style="color:#888;">Hover for details · click to select<br>
      Left-drag = pan · Right-drag = orbit · Scroll = zoom<br>
      Top-right ✦/○ toggles animated arcs (off saves GPU)</em>
    </div>
  `;
  target.appendChild(info);

  selection.subscribe(applySelection);

  const resizeObs = new ResizeObserver(() => applyCamera());
  resizeObs.observe(target);

  applyCamera();
  applySelection(selection.get());
}
