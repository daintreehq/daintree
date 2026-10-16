import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../commandRunner.js";
import { HostSetupService } from "../HostSetupService.js";
import type { ClientBuild } from "../installPlan.js";

// Only what setup remembers about an install is under test here, not the install.
vi.mock("../hostInstaller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hostInstaller.js")>()),
  runHostInstall: vi.fn(
    async (
      _payload: unknown,
      deps: { probe(signal: AbortSignal): Promise<{ result: unknown }> }
    ) => {
      const before = await deps.probe(new AbortController().signal);
      return { status: "installed", probe: before.result, reconnected: null };
    }
  ),
}));

const CLIENT: ClientBuild = {
  platform: "darwin",
  arch: "arm64",
  version: "1.4.0-nightly.20261016",
  commit: "abcdef0123",
  channel: "nightly",
  bundle: { kind: "none" },
};

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});

const EMPTY = ["@@dt:uname Linux x86_64", "@@dt:unit no", "@@dt:end"].join("\n");
const BUILD = '{"daintreeBuildInfo":1,"version":"1.4.0-nightly.20261016","commit":"abcdef0123"}';
const INSTALLED = [
  "@@dt:uname Linux x86_64",
  "@@dt:install deb /opt/Daintree",
  `@@dt:buildinfo ${BUILD}`,
  "@@dt:unit no",
  "@@dt:linger Linger=yes",
  "@@dt:end",
].join("\n");
const ON = INSTALLED.replace("@@dt:unit no", "@@dt:unit yes\n@@dt:unitenabled enabled").replace(
  "@@dt:end",
  `@@dt:listening yes\n@@dt:hostpid 9\n@@dt:hostmodestate ${JSON.stringify({
    daintreeHostMode: 1,
    pid: 9,
    enabled: true,
    startAtLogin: true,
    startAtLoginInstalled: true,
    startAtLoginError: null,
    keychain: { state: "unavailable", detail: "no keyring (headless)", checked: true },
  })}\n@@dt:end`
);

let clientDir: string;

beforeEach(async () => {
  // Short: the ssh control socket lives under it, and socket paths are capped.
  clientDir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-chan-"));
});

afterEach(async () => {
  await fs.rm(clientDir, { recursive: true, force: true });
});

/** Setup against a host whose probes answer `probes` in turn (the last one repeats). */
function service(probes: string[]): { setup: HostSetupService; handoffs: string[] } {
  const handoffs: string[] = [];
  const setup = new HostSetupService({
    run: async (_command, args) => {
      const script = args.at(-1) ?? "";
      if (script.includes("@@dt:uname"))
        return ok(probes.length > 1 ? probes.shift()! : probes[0]!);
      if (script.includes("unitsaved")) return ok("@@dt:unitsaved no\n");
      if (script.includes("--host-mode-handoff")) {
        handoffs.push(script);
        return ok("@@dt:handoff 0\n");
      }
      return ok();
    },
    clientDir,
    platform: "darwin",
    knownConnections: () => [],
    clientBuild: () => CLIENT,
    restartImpact: async () => ({ detail: null, agents: null }),
    download: async () => {},
    emit: () => {},
    sleep: async () => {},
  });
  return { setup, handoffs };
}

const connection = { kind: "ssh", target: "bigbox" } as const;

describe("HostSetupService and a host's update channel", () => {
  it("gives a host it installed Daintree on from nothing this machine's channel, once", async () => {
    const { setup, handoffs } = service([EMPTY, INSTALLED, ON]);
    await setup.install({ opId: "op-1", connection });
    await setup.startHostMode({ connection });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toContain(
      "--enable-host-mode --update-channel=nightly --host-mode-handoff"
    );
  });

  it("leaves the channel of a host that already had Daintree alone", async () => {
    const { setup, handoffs } = service([INSTALLED, INSTALLED, ON]);
    await setup.install({ opId: "op-2", connection });
    await setup.startHostMode({ connection });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).not.toContain("--update-channel");
  });

  it("sends no channel when this setup installed nothing there", async () => {
    const { setup, handoffs } = service([INSTALLED, ON]);
    await setup.startHostMode({ connection });
    expect(handoffs[0]).not.toContain("--update-channel");
  });
});
