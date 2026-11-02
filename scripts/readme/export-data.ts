// Writes the facts the README artwork is drawn from: every built-in agent with
// its real brand mark and colour, every built-in theme with its location and
// palette, and the Daintree mark. The art reads this file rather than copying
// names, hexes or SVG paths by hand, so a renamed theme or a new agent shows up
// on the next render instead of drifting.
//
//   npx tsx scripts/readme/export-data.ts <out.json>

import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import { AGENT_REGISTRY } from "../../shared/config/agentRegistry";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme";
import { BUILT_IN_THEME_SOURCES } from "../../shared/theme/builtInThemeSources";
import { resolveBrandMarkInk } from "../../src/lib/brandIcon";
import * as Brands from "../../src/components/icons/brands";
import { DaintreeIcon } from "../../src/components/icons/DaintreeIcon";

const out = process.argv[2];
if (!out) throw new Error("usage: export-data.ts <out.json>");

const brandByIconId = new Map<string, ComponentType<{ size?: number }>>();
for (const [exportName, component] of Object.entries(Brands)) {
  if (!exportName.endsWith("Icon") || typeof component !== "function") continue;
  brandByIconId.set(
    exportName.slice(0, -4).toLowerCase(),
    component as ComponentType<{ size?: number }>
  );
}

const svg = (Component: ComponentType<{ size?: number }>) =>
  renderToStaticMarkup(createElement(Component, { size: 64 })).replace(/ class="[^"]*"/g, "");

// The artwork sits on Daintree's panel colour, so each mark gets the ink the app
// itself would paint there: the vendor colour, moved only as far as legibility
// demands (Goose and Open Interpreter ship near-black marks).
const daintree = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === "daintree");
if (!daintree) throw new Error("no built-in daintree scheme");

const agents = Object.values(AGENT_REGISTRY).map((agent) => {
  const mark = brandByIconId.get(agent.iconId);
  if (!mark) throw new Error(`no brand mark for agent ${agent.id} (iconId ${agent.iconId})`);
  const ink = resolveBrandMarkInk(agent.color, daintree, { surface: "surface-panel" });
  return {
    id: agent.id,
    name: agent.name,
    color: agent.color,
    ink: ink?.active ?? agent.color,
    svg: svg(mark),
  };
});

const themes = BUILT_IN_THEME_SOURCES.map((theme) => ({
  id: theme.id,
  name: theme.name,
  type: theme.type,
  location: theme.location ?? "",
  heroImage: theme.heroImage ?? "",
  palette: theme.palette,
}));

writeFileSync(out, JSON.stringify({ daintreeMark: svg(DaintreeIcon), agents, themes }, null, 2));
console.log(`README_DATA agents=${agents.length} themes=${themes.length} → ${out}`);
