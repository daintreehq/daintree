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

  beforeAll(async () => {
    const result = await build({
      ...mainEsmConfig({ production: true }),
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

  it("keeps the light halves startup reads them through on the startup graph", () => {
    // Where the handlers now look: if these drop out, the boundary above is
    // being met by something no longer registering at all.
    for (const file of [
      "electron/services/helpSessionRuntime.ts",
      "shared/config/voiceCorrectionConfig.ts",
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
