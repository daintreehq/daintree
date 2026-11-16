import { beforeAll, describe, expect, it } from "vitest";
import { build, type Metafile } from "esbuild";
import { mainEsmConfig } from "./build-main.mjs";
import {
  FORBIDDEN_EAGER_PATTERNS,
  MAIN_ON_DEMAND_PATTERNS,
  scanForbiddenModules,
  walkEagerGraph,
} from "./import-budget-lib.mjs";

/** What runs at startup: the bootstrap, then main, which it loads. */
const STARTUP_ENTRIES = ["electron/bootstrap.ts", "electron/main.ts"];

/**
 * What boot imports dynamically before the first window is interactive: host
 * services wire PluginService and the port broker, and Remote Hosts, on in
 * every build, starts once the launch settles, with its throwaway runs and,
 * where the build can be a Host, the host role, Host mode on or off.
 * PluginService and Remote Hosts' plugin parity still reach the manifest
 * schema, which plugin hydration reads at startup; neither may reach the rest.
 */
const EARLY_DYNAMIC_ROOTS = [
  "electron/services/PluginService.ts",
  "electron/services/WorktreePortBroker.ts",
  "electron/remote/boot.ts",
  "electron/services/throwaway/index.ts",
];
const HOST_ROLE_ROOT = "electron/remote/hostBoot.ts";
const NOT_EARLY = MAIN_ON_DEMAND_PATTERNS.filter(({ label }) => label !== "Plugin manifest schema");

/**
 * Main's boot registers every IPC handler, and a static import in any of them
 * evaluates whatever it reaches before the first window is interactive
 * (#17024). The plugin manifest schema, the assistant's session service and
 * voice cleanup with its prompts are each wanted only once something asks for
 * them, so they sit behind `await import()`. The import budget script that
 * would notice a regression runs on demand, not in CI, so this builds main with
 * the production config, without writing it, and walks esbuild's graph, which
 * stops at `dynamic-import` edges: exactly the boundary being asserted.
 */
describe("main's on-demand feature boundary", () => {
  let metafile: Metafile;
  let eager: Set<string>;
  let earlyRoots: string[];

  beforeAll(async () => {
    const config = mainEsmConfig({ production: true });
    earlyRoots =
      config.define?.__DAINTREE_REMOTE_HOST_ROLE__ === "true"
        ? [...EARLY_DYNAMIC_ROOTS, HOST_ROLE_ROOT]
        : EARLY_DYNAMIC_ROOTS;
    const result = await build({
      ...config,
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    metafile = result.metafile;
    eager = new Set(STARTUP_ENTRIES.flatMap((entry) => [...walkEagerGraph(metafile, entry)]));
  }, 180_000);

  it("builds every guarded module into main, so their absence below means something", () => {
    const inputs = Object.keys(metafile.inputs);
    for (const file of [
      "electron/schemas/plugin.ts",
      "electron/schemas/pluginManifestAdvisories.ts",
      "electron/services/HelpSessionService.ts",
      "electron/services/VoiceCorrectionService.ts",
      "electron/services/voiceOpeningCommand.ts",
      "shared/config/voiceCorrection.ts",
      "shared/config/voiceCorrectionOpenAI.ts",
      "shared/config/voiceCorrectionClaude.ts",
    ]) {
      expect(inputs, file).toContain(file);
    }
    for (const { label } of MAIN_ON_DEMAND_PATTERNS) {
      expect(
        inputs.some(
          (file) => scanForbiddenModules([file], MAIN_ON_DEMAND_PATTERNS)[0]?.label === label
        ),
        label
      ).toBe(true);
    }
  });

  it("reaches none of them from the startup graph", () => {
    for (const entry of STARTUP_ENTRIES) expect(eager.has(entry), entry).toBe(true);
    expect(scanForbiddenModules(eager, MAIN_ON_DEMAND_PATTERNS)).toEqual([]);
  });

  it("reaches neither the session service nor voice cleanup from what boot imports early", () => {
    const inputs = new Set(Object.keys(metafile.inputs));
    const early = new Set(eager);
    for (const root of earlyRoots) {
      expect(inputs.has(root), root).toBe(true);
      for (const file of walkEagerGraph(metafile, root)) early.add(file);
    }
    expect(scanForbiddenModules(early, NOT_EARLY)).toEqual([]);
  });

  it("keeps the light halves startup reads them through on the startup graph", () => {
    // Where the handlers now look: if these drop out, the boundary above is
    // being met by something no longer registering at all.
    for (const file of [
      "electron/services/helpSessionRuntime.ts",
      "shared/config/voiceCorrectionPolicy.ts",
      "electron/ipc/handlers/voiceInput.ts",
      "electron/ipc/handlers/fileDocument.ts",
      "electron/ipc/handlers/plugin/diagnostics.ts",
    ]) {
      expect(eager.has(file), file).toBe(true);
    }
  });

  it("reaches no module on the whole forbidden list", () => {
    expect(scanForbiddenModules(eager, FORBIDDEN_EAGER_PATTERNS)).toEqual([]);
  });
});
