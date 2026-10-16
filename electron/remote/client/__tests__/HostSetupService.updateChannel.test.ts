import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult } from "../commandRunner.js";
import { HostSetupService } from "../HostSetupService.js";
import type { ClientBuild } from "../installPlan.js";

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

const BUILD = '{"daintreeBuildInfo":1,"version":"1.4.0-nightly.20261016","commit":"abcdef0123"}';

/** A Linux host with this build installed and Host mode off; `settings` is what the probe saw. */
function installed(settings: "yes" | "no" | null): string {
  return [
    "@@dt:uname Linux x86_64",
    ...(settings ? [`@@dt:settings ${settings}`] : []),
    "@@dt:install deb /opt/Daintree",
    `@@dt:buildinfo ${BUILD}`,
    "@@dt:unit no",
    "@@dt:linger Linger=yes",
    "@@dt:end",
  ].join("\n");
}

const ON = installed("yes")
  .replace("@@dt:unit no", "@@dt:unit yes\n@@dt:unitenabled enabled")
  .replace(
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
  it("hands a host whose Daintree has never run there this machine's channel", async () => {
    const { setup, handoffs } = service([installed("no"), installed("yes"), ON]);
    await setup.startHostMode({ connection });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toContain(
      "--enable-host-mode --update-channel=nightly --host-mode-handoff"
    );
  });

  it("leaves the channel alone where Daintree has run before, whoever installed it", async () => {
    const { setup, handoffs } = service([installed("yes"), ON]);
    await setup.startHostMode({ connection });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).not.toContain("--update-channel");
  });

  it("sends no channel when the probe couldn't tell", async () => {
    const { setup, handoffs } = service([installed(null), ON]);
    await setup.startHostMode({ connection });
    expect(handoffs[0]).not.toContain("--update-channel");
  });
});
