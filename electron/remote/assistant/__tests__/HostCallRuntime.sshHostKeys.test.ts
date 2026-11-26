import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostSshHostKeysResultSchema } from "../../../../shared/types/hostControl.js";
import { FIXTURE_KEYS } from "../../host/__tests__/sshKeyFixtures.js";
import type { HostSshHostKeysRead } from "../../client/HostSshHostKeysService.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const ED25519 = FIXTURE_KEYS.ed25519.line.split(" ").slice(0, 2).join(" ");

function observed(hostId: string): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection: { status: "connected", rttMs: 3 } as ObservedHost["connection"],
    lastSeenAt: null,
    summary: null,
  };
}

describe("HostCallRuntime host.sshHostKeys (#18258)", () => {
  let runs: Map<string, OpenRun>;
  let read: ReturnType<
    typeof vi.fn<(hostId: string, signal?: AbortSignal) => Promise<HostSshHostKeysRead>>
  >;
  let installed: boolean;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    runs = new Map([["a", { ...RUN }]]);
    installed = true;
    read = vi.fn(async () => ({
      status: "read" as const,
      trust: {
        basis: "provider-pin" as const,
        providerId: "boat",
        pinnedFingerprint: FIXTURE_KEYS.ed25519.fingerprint,
      },
      pinnedKey: ED25519,
      answer: {
        status: "reading" as const,
        complete: true,
        truncated: false,
        listeners: [
          {
            listenerId: "l1",
            pid: 9,
            complete: true,
            gaps: [],
            configFile: null,
            listenAddresses: ["0.0.0.0:22"],
            keys: [
              {
                outcome: "read" as const,
                hostKeyPath: "/etc/ssh/ssh_host_ed25519_key",
                publicKeyPath: "/etc/ssh/ssh_host_ed25519_key.pub",
                type: "ssh-ed25519",
                publicKey: ED25519,
                fingerprint: FIXTURE_KEYS.ed25519.fingerprint,
              },
            ],
          },
        ],
      },
    }));
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => [observed("studio"), observed("mini")],
      inLocalView: () => true,
      controlEnabled: (hostId) => hostId === "studio",
      sshHostKeys: () => (installed ? { read } : null),
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("reads a host's keys for this machine's assistant, in the advertised shape, with its abort", async () => {
    const abort = new AbortController();
    const outcome = await runtime.sshHostKeys("a", { hostId: "studio" }, abort.signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(HostSshHostKeysResultSchema.parse(outcome.value)).toEqual(outcome.value);
    expect(outcome.value).toMatchObject({
      outcome: "ok",
      trust: { basis: "provider-pin", providerId: "boat" },
      reading: { status: "reading", listeners: [{ keys: [{ matchesPin: true }] }] },
    });
    expect(read).toHaveBeenCalledWith("studio", abort.signal);
  });

  it("refuses a session with no run here, and reads nothing for it", async () => {
    await expect(runtime.sshHostKeys("stranger", { hostId: "studio" })).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("answers a host whose control is off, and a Shell with no reader, without reading", async () => {
    expect(await runtime.sshHostKeys("a", { hostId: "mini" })).toMatchObject({
      ok: true,
      value: { outcome: "opted_out", trust: null, reading: null },
    });
    installed = false;
    expect(await runtime.sshHostKeys("a", { hostId: "studio" })).toMatchObject({
      ok: true,
      value: { outcome: "unsupported" },
    });
    expect(read).not.toHaveBeenCalled();
  });
});
