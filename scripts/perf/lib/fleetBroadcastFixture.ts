/**
 * The real fleet-broadcast eligibility gate, linked for plain Node.
 *
 * `scenarios/fleetBroadcast.ts` used to hand-mirror `isTerminalFleetEligible`
 * with a comment saying `src/store/fleetEligibility.ts` "can't be imported
 * under tsx — it pulls in the Vite-only renderer store graph". That was true of
 * a direct import and false of the harness as a whole: `worktreeSidebarFixture`
 * and `actionDispatchFixture` both esbuild-link renderer modules with the `@`
 * and `@shared` aliases resolved and `import.meta.env` defined. The mirror is
 * the worst failure mode the harness has: it keeps passing while the predicate
 * it copies changes underneath it, so the benchmark measures a fossil and its
 * target count is over the wrong denominator without anything going red.
 *
 * The Vite-only leaf is exactly one file. `fleetEligibility` reaches
 * `src/config/agentIcons.ts` through `terminalType → terminalChrome →
 * config/agents`, and that module is an `import.meta.glob` of React brand
 * icons evaluated at module scope. It is stubbed — the same stub
 * `actionDispatchFixture` uses — and is unreachable from the predicate, which
 * only reads `kind`, `location`, `hasPty` and `runtimeStatus`. Everything else
 * in the graph, including `isPtyPanel` and `isGridPanelLocation`, is the
 * shipped code.
 *
 * Scope limit: there is no renderer and no store. The predicate is fed panel
 * records built here rather than read out of `panelStore`, so this measures the
 * gate and the fan-out around it, never the selector work a real broadcast does
 * to assemble the armed set.
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PanelInstance, PanelLocation, PtyPanelData } from "../../../shared/types/panel";
import { createPerfTempRoot } from "./tempRoots";
import { createRng } from "./workloads";

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const AGENT_ICONS_STUB = `
const Icon = () => null;
export const AGENT_ICON_MAP = { claude: Icon };
export function resolveAgentIcon() { return Icon; }
`;

export interface FleetEligibilityModule {
  isTerminalFleetEligible: (panel: PanelInstance | undefined) => panel is PtyPanelData;
}

let modulePromise: Promise<FleetEligibilityModule> | null = null;

/** Link and load the real `src/store/fleetEligibility.ts`. Built once per process. */
export function loadFleetEligibility(): Promise<FleetEligibilityModule> {
  if (!modulePromise) modulePromise = buildBundle();
  return modulePromise;
}

async function buildBundle(): Promise<FleetEligibilityModule> {
  const esbuild = await import("esbuild");
  const outDir = createPerfTempRoot("daintree-perf-fleet-");

  const entryFile = join(outDir, "entry.ts");
  writeFileSync(
    entryFile,
    `export { isTerminalFleetEligible } from ${JSON.stringify(
      join(REPO_ROOT, "src/store/fleetEligibility.ts")
    )};\n`
  );

  const outfile = join(outDir, "fleetEligibility.mjs");
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    alias: { "@": join(REPO_ROOT, "src"), "@shared": join(REPO_ROOT, "shared") },
    define: { "import.meta.env": "{}" },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty" },
    plugins: [
      {
        name: "daintree-perf-fleet-stubs",
        setup(build) {
          build.onResolve({ filter: /(^|[\\/])agentIcons$/ }, (args) => ({
            path: args.path,
            namespace: "daintree-perf-fleet-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "daintree-perf-fleet-stub" }, () => ({
            contents: AGENT_ICONS_STUB,
            loader: "js",
          }));
        },
      },
    ],
  });

  const mod = (await import(pathToFileURL(outfile).href)) as FleetEligibilityModule;
  if (typeof mod.isTerminalFleetEligible !== "function") {
    throw new Error("fleet bundle did not export isTerminalFleetEligible");
  }
  return mod;
}

/**
 * A panel record as the armed set carries it. Only the four fields the
 * eligibility gate reads are populated; everything else a real `PanelInstance`
 * has is irrelevant to the predicate and would be dead weight in the fan-out.
 */
export interface FleetPanel {
  id: string;
  worktreeId: string;
  kind: "terminal" | "browser";
  location: PanelLocation | undefined;
  hasPty: boolean;
  runtimeStatus: "running" | "exited" | "error";
}

/**
 * An armed set of `eligible` live grid terminals plus `noise` panels that the
 * gate must reject — one per rejection clause in `isTerminalFleetEligible`, so
 * a gate that stops checking any single field shows up as a target count over
 * the wrong denominator rather than as a faster fan-out.
 *
 * The armed set drifts in real use (a pane exits, a terminal is docked), which
 * is why a faithful broadcast has chaff to filter at all.
 */
export function buildFleet(eligible: number, noise: number, seed: number): FleetPanel[] {
  const rng = createRng(seed);
  const panels: FleetPanel[] = [];
  for (let i = 0; i < eligible; i += 1) {
    panels.push({
      id: `term-${i}`,
      worktreeId: `wt-${i % 8}`,
      kind: "terminal",
      // Mix of explicit "grid" and legacy undefined — both are grid members.
      location: rng() > 0.5 ? "grid" : undefined,
      hasPty: true,
      runtimeStatus: "running",
    });
  }
  const noiseKinds: Array<() => FleetPanel> = [
    // Dock terminals are excluded: the collapsed dock cannot render the armed
    // state that warns a user their keystrokes are being broadcast.
    () => ({
      id: `dock-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "dock",
      hasPty: true,
      runtimeStatus: "running",
    }),
    () => ({
      id: `exited-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "grid",
      hasPty: true,
      runtimeStatus: "exited",
    }),
    () => ({
      id: `nopty-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "grid",
      hasPty: false,
      runtimeStatus: "running",
    }),
    () => ({
      id: `browser-${rng()}`,
      worktreeId: "wt-x",
      kind: "browser",
      location: "grid",
      hasPty: true,
      runtimeStatus: "running",
    }),
  ];
  for (let i = 0; i < noise; i += 1) {
    panels.push(noiseKinds[i % noiseKinds.length]!());
  }
  // Interleave so the filter can't short-circuit a contiguous eligible block.
  for (let i = panels.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [panels[i], panels[j]] = [panels[j]!, panels[i]!];
  }
  return panels;
}
