import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { MAIN_EXTERNAL } from "./main-build-entries.mjs";
import { walkEagerGraph } from "./import-budget-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = "shared/theme/";
const WORKER = "electron/plugin-dev-worker.ts";
const BOOTSTRAP = "electron/plugin-dev-worker-bootstrap.ts";

/**
 * Every plugin with worker code forks its own utility process, so whatever the
 * worker evaluates at boot is paid once per plugin instance. `themes.ts` derives
 * every built-in scheme at module level (15-16 ms and about 2 MB retained per
 * process), and a worker has no use for a theme: the only colours it touches are
 * the static panel-kind and branch-type constants in `entityColors.ts`.
 *
 * The bundler's graph is the evidence. The `shared/theme` barrel re-exports
 * `themes.ts`, so one barrel import in a module the worker reaches evaluates the
 * whole engine; how an import is spelled in the file proves nothing about it.
 */

async function metafileOf(entry: string): Promise<Metafile> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: MAIN_EXTERNAL,
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(""),
      __DAINTREE_REMOTE_HOSTS__: "false",
      __DAINTREE_REMOTE_HOST_ROLE__: "false",
      __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
    },
    absWorkingDir: ROOT,
    logLevel: "silent",
  });
  return result.metafile;
}

describe("the plugin worker's boot graph", () => {
  it("never evaluates the theme engine", async () => {
    const metafile = await metafileOf(WORKER);
    const eager = [...walkEagerGraph(metafile, WORKER)];

    // Not a vacuous pass: the worker does reach the panel-kind registry, the
    // module that used to pull the barrel in, and the constants it needs.
    expect(eager).toContain("shared/config/panelKindRegistry.ts");
    expect(eager).toContain(`${THEME_DIR}entityColors.ts`);

    expect(eager.filter((file) => file.startsWith(THEME_DIR))).toEqual([
      `${THEME_DIR}entityColors.ts`,
    ]);
    // Dynamic imports are inlined into the metafile's inputs, so the whole
    // closure is checked as well: even a lazy theme load would be one nobody
    // asked a worker to make.
    expect(Object.keys(metafile.inputs).filter((file) => file.startsWith(THEME_DIR))).toEqual([
      `${THEME_DIR}entityColors.ts`,
    ]);
  }, 60_000);

  it("keeps the bootstrap clear of the theme engine too", async () => {
    const metafile = await metafileOf(BOOTSTRAP);
    expect(Object.keys(metafile.inputs)).toContain(WORKER);
    expect(
      Object.keys(metafile.inputs).filter(
        (file) => file.startsWith(THEME_DIR) && file !== `${THEME_DIR}entityColors.ts`
      )
    ).toEqual([]);
  }, 60_000);

  it.each(["shared/config/panelKindRegistry.ts", "shared/config/branchPrefixes.ts"])(
    "keeps %s on the static colour constants",
    async (entry) => {
      const metafile = await metafileOf(entry);
      expect(Object.keys(metafile.inputs)).toContain(`${THEME_DIR}entityColors.ts`);
      expect(
        Object.keys(metafile.inputs).filter(
          (file) => file.startsWith(THEME_DIR) && file !== `${THEME_DIR}entityColors.ts`
        )
      ).toEqual([]);
    },
    60_000
  );
});
