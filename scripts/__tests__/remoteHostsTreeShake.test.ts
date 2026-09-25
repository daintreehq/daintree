import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type Metafile } from "esbuild";

// A Windows build compiles `__DAINTREE_REMOTE_HOSTS__` to false and must ship
// none of Remote Hosts. This bundles the core entries the way
// scripts/build-main.mjs does and reads the metafile, so a static import from
// core into a remote module fails here rather than in a Windows release.
const root = path.resolve(__dirname, "../..");

const ENTRY_POINTS = [
  "electron/bootstrap.ts",
  "electron/main.ts",
  "electron/pty-host.ts",
  "electron/workspace-host.ts",
  "electron/watchdog-host.ts",
  "electron/plugin-dev-worker.ts",
  "electron/pty-host/analysisWorker.ts",
  "electron/workspace-host/copytreeWorker.ts",
  "electron/services/persistence/dbMaintenanceWorker.ts",
];

const EXTERNAL = [
  "electron",
  "@parcel/watcher",
  "node-pty",
  "better-sqlite3",
  "win-job-object",
  "posix-pty-reaper",
  "copytree",
  "onnxruntime-node",
  "avr-vad",
];

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
  const result = await build({
    absWorkingDir: root,
    entryPoints: ENTRY_POINTS,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    splitting: true,
    outdir: "dist-electron",
    outbase: ".",
    chunkNames: "electron/chunks/[name]-[hash]",
    external: EXTERNAL,
    write: false,
    metafile: true,
    logLevel: "silent",
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(""),
      __DAINTREE_REMOTE_HOSTS__: JSON.stringify(remoteHosts),
      __DAINTREE_BUILD_COMMIT__: JSON.stringify("test"),
    },
  });
  return collectInputs(result.metafile);
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
