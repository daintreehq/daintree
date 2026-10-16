import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type BuildOptions, type Metafile } from "esbuild";
import { MAIN_EXTERNAL, MAIN_PRELOAD_ENTRY, mainEsmEntryPoints } from "../main-build-entries.mjs";

// A build with `__DAINTREE_REMOTE_HOSTS__` false must ship none of Remote
// Hosts' gated modules, and a Windows build, which compiles
// `__DAINTREE_REMOTE_HOST_ROLE__` to false, must ship the Shell and none of
// the Host's runtime. This bundles every entry scripts/build-main.mjs builds,
// from the same shared list, and reads the metafile, so a static import from
// core into a remote module, or from the Shell into the Host, fails here
// rather than in a release.
const root = path.resolve(__dirname, "../..");

const ESM_ENTRY_POINTS: string[] = mainEsmEntryPoints(root);

// The only remote files core code may import statically.
const CORE_ALLOWED = new Set([
  "electron/remote/buildGate.ts",
  "electron/remote/runtime.ts",
  "electron/remote/pendingHandler.ts",
  "electron/remote/handshakeInfo.ts",
]);

// The only Host modules a Shell-only build may carry: pure contracts both sides
// read (the attach preamble, the discovery file, socket paths, link method
// schemas, the Host mode status file, unit templates), never a listener or service.
const SHELL_SAFE_HOST_MODULES = new Set([
  "electron/remote/host/attachStdio.ts",
  "electron/remote/host/discoveryFile.ts",
  "electron/remote/host/hostModeStatusFile.ts",
  "electron/remote/host/hostSocketPath.ts",
  "electron/remote/host/linkMethods.ts",
  "electron/remote/host/startAtLogin.ts",
]);

const SHELL_DIRS = [
  "link",
  "client",
  "terminal",
  "worktreePort",
  "files",
  "ports",
  "metrics",
  "plugins",
  "projects",
  "hybrid",
  "assistant",
];

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
  "assistant",
];

async function bundledInputs(remoteHosts: boolean, hostRole = remoteHosts): Promise<string[]> {
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
      __DAINTREE_REMOTE_HOST_ROLE__: JSON.stringify(hostRole),
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
  let shellOnly: string[];
  let enabled: string[];

  beforeAll(async () => {
    [disabled, shellOnly, enabled] = await Promise.all([
      bundledInputs(false),
      bundledInputs(true, false),
      bundledInputs(true),
    ]);
  }, 180_000);

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

  it("bundles the Shell but none of the Host's runtime when only the Host role is off", () => {
    const remote = remoteInputs(shellOnly);
    expect(remote).toContain("electron/remote/boot.ts");
    for (const dir of SHELL_DIRS) {
      expect(
        remote.some((input) => input.startsWith(`electron/remote/${dir}/`)),
        `electron/remote/${dir}/`
      ).toBe(true);
    }
    const hostModules = remote.filter(
      (input) => input.startsWith("electron/remote/host/") || input === "electron/remote/hostBoot.ts"
    );
    expect(hostModules.filter((input) => !SHELL_SAFE_HOST_MODULES.has(input))).toEqual([]);
    // The WSL client is what a Windows build is for.
    expect(remote).toContain("electron/remote/client/wslTransport.ts");
  });

  it("bundles the Host's runtime with both roles", () => {
    const remote = remoteInputs(enabled);
    for (const input of [
      "electron/remote/hostBoot.ts",
      "electron/remote/host/HostServer.ts",
      "electron/remote/host/attachStdioCli.ts",
      "electron/remote/host/headlessHostTakeover.ts",
    ]) {
      expect(remote).toContain(input);
    }
  });
});
