import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// A render path that subscribes to the panel kind definition registry must
// resolve its definition by indexing the snapshot `useSyncExternalStore`
// returns. Subscribing and then calling `getPanelKindDefinition(kind)`
// separately reads mutable module state during render: React Compiler (wired
// for both `vite dev` and `vite build`, `compilationMode: "infer"`) cannot see
// that the getter closes over that state, so it caches the call keyed only on
// `kind`. The subscription still schedules a rerender, but the cache keeps
// serving the definition resolved on first render — a panel restored before its
// plugin registered its kind stayed on `PluginMissingPanel` permanently (#11636).
//
// Scanning source rather than asserting behaviour is deliberate: vitest runs
// uncompiled TSX, where the getter re-runs every render and picks the new value
// up. A rendering test of this would pass with or without the bug. The compiled
// bundle is only reachable from E2E, which does not run on PRs — so this
// contract is what guards the invariant on every change.

const SUBSCRIBE_FN = "subscribeToPanelKindDefinitions";
const SNAPSHOT_FN = "getPanelKindDefinitionsSnapshot";
// Matches a call/declaration of the getter but not `getPanelKindDefinitionsSnapshot(`,
// whose next character after the shared prefix is `s` rather than `(`.
const GETTER_CALL = /\bgetPanelKindDefinition\s*\(/;
// The module that declares both symbols necessarily mentions both.
const DECLARING_MODULE = "panels/registry.tsx";

/** Render paths that must stay reactive to late plugin kind registration. */
const REQUIRED_SUBSCRIBERS = [
  "components/Terminal/GridPanel.tsx",
  "components/Terminal/DockedPanel.tsx",
  "components/Panel/PanelDialogHost.tsx",
];

/**
 * Drop block and line comments so prose naming the banned getter (including the
 * comments explaining this very rule) isn't mistaken for a call. Only trailing
 * text is removed, so a real call can never be hidden — anything after `//` on a
 * line is commented-out code, which is not a call either.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(SRC_ROOT).map((file) => {
  const text = fs.readFileSync(file, "utf8");
  return {
    rel: path.relative(SRC_ROOT, file).split(path.sep).join("/"),
    text,
    code: stripComments(text),
  };
});

describe("panel kind definition reads (#11636)", () => {
  it("resolves definitions from the subscribed snapshot, never a parallel getter call", () => {
    const offenders = sourceFiles
      .filter(
        (file) =>
          file.rel !== DECLARING_MODULE &&
          file.code.includes(SUBSCRIBE_FN) &&
          GETTER_CALL.test(file.code)
      )
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it("keeps every panel presentation subscribed to the definition registry", () => {
    const missing = REQUIRED_SUBSCRIBERS.filter((rel) => {
      const file = sourceFiles.find((candidate) => candidate.rel === rel);
      if (!file) throw new Error(`Contract target no longer exists: src/${rel}`);
      return !file.code.includes(SUBSCRIBE_FN) || !file.code.includes(SNAPSHOT_FN);
    });

    // Dropping the subscription would "satisfy" the rule above while
    // reintroducing the stuck placeholder, so pin the subscription too.
    expect(missing).toEqual([]);
  });
});
