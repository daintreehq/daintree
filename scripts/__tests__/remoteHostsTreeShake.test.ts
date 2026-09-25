import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type BuildOptions, type Metafile } from "esbuild";
import { MAIN_EXTERNAL, MAIN_PRELOAD_ENTRY, mainEsmEntryPoints } from "../main-build-entries.mjs";

// A Windows build compiles `__DAINTREE_REMOTE_HOSTS__` to false and must ship
// none of Remote Hosts' gated modules. This bundles every entry
// scripts/build-main.mjs builds, from the same shared list, and reads the
// metafile, so a static import from core into a remote module fails here
// rather than in a Windows release.
const root = path.resolve(__dirname, "../..");

const ESM_ENTRY_POINTS: string[] = mainEsmEntryPoints(root);

// The only remote files core code may import statically.
const CORE_ALLOWED = new Set([
  "electron/remote/buildGate.ts",
  "electron/remote/runtime.ts",
  "electron/remote/pendingHandler.ts",
  "electron/remote/handshakeInfo.ts",
]);

const GATED_DIRS = [
  "link",
  "host",
  "client",
  "terminal",
  "worktreePort",
  "files",
  "ports",
  "metrics",
  "plugins",
  "projects",
  "hybrid",
];

async function bundledInputs(remoteHosts: boolean): Promise<string[]> {
  const shared: BuildOptions = {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node22",
    external: MAIN_EXTERNAL,
    write: false,
    metafile: true,
    logLevel: "silent",
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(""),
      __DAINTREE_REMOTE_HOSTS__: JSON.stringify(remoteHosts),
      __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
    },
  };
  const [esm, preload] = await Promise.all([
    build({
      ...shared,
      entryPoints: ESM_ENTRY_POINTS,
      format: "esm",
      splitting: true,
      outdir: "dist-electron",
      outbase: ".",
      chunkNames: "electron/chunks/[name]-[hash]",
    }),
    build({
      ...shared,
      entryPoints: [MAIN_PRELOAD_ENTRY],
      format: "cjs",
      outdir: "dist-electron/electron",
      outExtension: { ".js": ".cjs" },
    }),
  ]);
  return [...new Set([...collectInputs(esm.metafile!), ...collectInputs(preload.metafile!)])];
}

function collectInputs(metafile: Metafile): string[] {
  const inputs = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) inputs.add(input.split(path.sep).join("/"));
  }
  return [...inputs];
}

function remoteInputs(inputs: string[]): string[] {
  return inputs.filter((input) => input.startsWith("electron/remote/")).sort();
}

describe("Remote Hosts build gate tree-shaking", () => {
  let disabled: string[];
  let enabled: string[];

  beforeAll(async () => {
    [disabled, enabled] = await Promise.all([bundledInputs(false), bundledInputs(true)]);
  }, 120_000);

  it("checks every entry the production build compiles", () => {
    expect(ESM_ENTRY_POINTS).toContain("electron/pty-host-bootstrap.ts");
    expect(ESM_ENTRY_POINTS).toContain("electron/services/voice/openaiVadWorker.ts");
    expect(ESM_ENTRY_POINTS.some((entry) => entry.startsWith("plugins/builtin/"))).toBe(true);
    for (const entry of [...ESM_ENTRY_POINTS, MAIN_PRELOAD_ENTRY]) {
      expect(disabled, entry).toContain(entry);
    }
  });

  it("bundles no gated remote module when the gate is false", () => {
    expect(disabled.length).toBeGreaterThan(0);
    const leaked = remoteInputs(disabled).filter((input) => !CORE_ALLOWED.has(input));
    expect(leaked).toEqual([]);
  });

  it("bundles the remote boot and every gated remote directory when the gate is true", () => {
    const remote = remoteInputs(enabled);
    expect(remote).toContain("electron/remote/boot.ts");
    for (const dir of GATED_DIRS) {
      expect(
        remote.some((input) => input.startsWith(`electron/remote/${dir}/`)),
        `electron/remote/${dir}/`
      ).toBe(true);
    }
  });
});
