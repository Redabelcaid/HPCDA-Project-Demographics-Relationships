import { buildLayout, addSection } from "./layout.ts";
import { renderMap } from "./views/map.ts";
import { renderDemographics } from "./views/demographics.ts";
import { renderNetwork } from "./views/network.ts";
import { renderBusiness } from "./views/business.ts";
import { renderEmployerDetail } from "./views/employer_detail.ts";
import { renderRelations } from "./views/relations.ts";
import { renderHeightmap } from "./views/heightmap.ts";

const app = document.getElementById("app")!;

function skeleton(target: HTMLElement, blocks: ("tall" | "medium" | "short")[]) {
  for (const size of blocks) {
    const div = document.createElement("div");
    div.className = `skeleton skeleton-block ${size}`;
    target.appendChild(div);
  }
}

function clearSkeleton(target: HTMLElement) {
  target.querySelectorAll(".skeleton").forEach((el) => el.remove());
}

(async () => {
  try {
    const {
      mapPane,
      relationsPane,
      heightmapPane,
      demographicsPane,
      socialPane,
      businessPane,
      employerPane,
    } = buildLayout(app);

    // The grid cells already have their own header bars; addSection
    // returns the cell body unchanged so the existing view code can
    // append directly into it.
    const demoSection = addSection(demographicsPane, "Demographics");
    skeleton(demoSection, ["short", "short"]);

    const socialSection = addSection(socialPane, "Social network");
    skeleton(socialSection, ["medium", "short"]);

    const businessSection = addSection(businessPane, "Business base");
    skeleton(businessSection, ["short", "short"]);

    const employerSection = addSection(employerPane, "Selected employer");
    skeleton(employerSection, ["short"]);

    const mapSkeleton = document.createElement("div");
    mapSkeleton.className = "skeleton";
    mapSkeleton.style.cssText = "position:absolute;inset:0;";
    mapPane.style.position = "relative";
    mapPane.appendChild(mapSkeleton);

    await Promise.all([
      renderMap(mapPane).then(() => mapSkeleton.remove()),
      renderRelations(relationsPane),
      renderHeightmap(heightmapPane),
      renderDemographics(demoSection).then(() => clearSkeleton(demoSection)),
      renderNetwork(socialSection).then(() => clearSkeleton(socialSection)),
      renderBusiness(businessSection).then(() => clearSkeleton(businessSection)),
      renderEmployerDetail(employerSection).then(() => clearSkeleton(employerSection)),
    ]);
  } catch (e) {
    app.innerHTML = `<pre style="color:crimson;padding:24px">${(e as Error).message}</pre>`;
  }
})();
