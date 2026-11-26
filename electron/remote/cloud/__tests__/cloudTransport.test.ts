import { describe, expect, it, vi } from "vitest";
import {
  SshAccessError,
  UnusableConnectionError,
  type LinkTransport,
  type LinkTransportConnection,
} from "../../client/transport.js";
import {
  createCloudTransports,
  type CloudDialSample,
  type CloudTransportAccess,
} from "../cloudTransport.js";
import type { CloudSshRoute } from "../CloudSshFiles.js";

const ROUTE: CloudSshRoute = {
  target: "dtc-cb_abcdefgh12",
  sshPath: "/rh/cloud/machines/cb_abcdefgh12/ssh",
  configPath: "/rh/cloud/machines/cb_abcdefgh12/config",
};

function harness(open: LinkTransport["open"]) {
  let generation = "203.0.113.10:22:ssh-ed25519 AAAA";
  let trust: CloudDialSample | null = {
    providerId: "gce",
    sshTrust: "pinned-from-api",
    hostKey: "ssh-ed25519 AAAA",
    revision: 1,
  };
  const access: CloudTransportAccess = {
    ensureAccess: vi.fn(async () => ROUTE),
    accessGeneration: vi.fn(() => generation),
    recheckHostKey: vi.fn(async () => {}),
    dialTrust: vi.fn(() => trust),
  };
  const ssh = vi.fn((): LinkTransport => ({ open }));
  const transports = createCloudTransports({ access: () => access, ssh });
  const ensureRunning = vi.fn(async () => true);
  return {
    access,
    ssh,
    ensureRunning,
    transports,
    transport: transports.transportFor("cb_abcdefgh12", ensureRunning, "h1"),
    forget: () => transports.forget("cb_abcdefgh12"),
    dialledWith: (hostId = "h1") => transports.dialledWith(hostId, "cb_abcdefgh12"),
    setGeneration: (next: string) => {
      generation = next;
    },
    setTrust: (next: CloudDialSample | null) => {
      trust = next;
    },
  };
}

const signal = () => new AbortController().signal;

describe("createCloudTransports", () => {
  it("keeps one ssh transport per access generation", async () => {
    const connection = {} as LinkTransportConnection;
    const env = harness(async () => connection);
    await expect(env.transport.open(signal())).resolves.toBe(connection);
    await env.transport.open(signal(), { fresh: true });
    expect(env.ssh).toHaveBeenCalledTimes(1);
    expect(env.access.ensureAccess).toHaveBeenLastCalledWith("cb_abcdefgh12", expect.anything(), {
      fresh: true,
    });
    env.setGeneration("203.0.113.10:22:ssh-ed25519 BBBB");
    await env.transport.open(signal());
    expect(env.ssh).toHaveBeenCalledTimes(2);
    env.forget();
    await env.transport.open(signal());
    expect(env.ssh).toHaveBeenCalledTimes(3);
  });

  it("hands the dial's signal and options through to ssh on the resolved route", async () => {
    const open = vi.fn(async () => ({}) as LinkTransportConnection);
    const env = harness(open);
    const dialSignal = signal();
    const options = { fresh: true, mayStart: false };
    await env.transport.open(dialSignal, options);
    expect(env.ssh).toHaveBeenCalledWith(ROUTE, env.ensureRunning);
    expect(open).toHaveBeenCalledWith(dialSignal, options);
  });

  it("looks at the key again when ssh refuses it, and reports the change it finds", async () => {
    const env = harness(async () => {
      throw new SshAccessError(
        "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."
      );
    });
    const changed = new UnusableConnectionError("This machine's identity changed", null);
    vi.mocked(env.access.recheckHostKey).mockRejectedValueOnce(changed);
    await expect(env.transport.open(signal())).rejects.toBe(changed);
    expect(env.access.recheckHostKey).toHaveBeenCalledWith("cb_abcdefgh12", expect.anything());
  });

  it("keeps ssh's own refusal when the key still matches what was trusted", async () => {
    const refusal = new SshAccessError("Host key verification failed.");
    const env = harness(async () => {
      throw refusal;
    });
    await expect(env.transport.open(signal())).rejects.toBe(refusal);
    expect(env.access.recheckHostKey).toHaveBeenCalledTimes(1);
  });

  it("leaves a refused login alone", async () => {
    const refusal = new SshAccessError("user@203.0.113.10: Permission denied (publickey).");
    const env = harness(async () => {
      throw refusal;
    });
    await expect(env.transport.open(signal())).rejects.toBe(refusal);
    expect(env.access.recheckHostKey).not.toHaveBeenCalled();
  });

  it("records what a dial that opened rested on, and nothing for one that failed", async () => {
    const env = harness(async () => {
      throw new SshAccessError("user@203.0.113.10: Permission denied (publickey).");
    });
    await expect(env.transport.open(signal())).rejects.toThrow();
    expect(env.dialledWith()).toBeUndefined();

    const ok = harness(async () => ({}) as LinkTransportConnection);
    await ok.transport.open(signal());
    expect(ok.dialledWith()).toEqual({
      providerId: "gce",
      sshTrust: "pinned-from-api",
      hostKey: "ssh-ed25519 AAAA",
    });
    ok.forget();
    expect(ok.dialledWith()).toBeUndefined();
  });

  it("leaves the trust unknown when the route was rewritten while ssh opened", async () => {
    const env: ReturnType<typeof harness> = harness(async () => {
      // A setup probe resolved access again meanwhile, onto another key.
      env.setGeneration("203.0.113.10:22:ssh-ed25519 BBBB");
      env.setTrust({
        providerId: "gce",
        sshTrust: "pinned-from-api",
        hostKey: "ssh-ed25519 BBBB",
        revision: 2,
      });
      return {} as LinkTransportConnection;
    });
    await env.transport.open(signal());
    expect(env.dialledWith()).toEqual({ providerId: "gce", sshTrust: null, hostKey: null });
  });

  it("takes the trust the route had once access resolved, unknown as it was before (#18258)", async () => {
    // A first dial after a restart: nothing vouched for the files until access resolved them.
    const env = harness(async () => ({}) as LinkTransportConnection);
    env.setTrust({ providerId: "gce", sshTrust: null, hostKey: null, revision: 0 });
    vi.mocked(env.access.ensureAccess).mockImplementationOnce(async () => {
      env.setTrust({
        providerId: "gce",
        sshTrust: "pinned-from-api",
        hostKey: "ssh-ed25519 AAAA",
        revision: 2,
      });
      return ROUTE;
    });
    await env.transport.open(signal());
    expect(env.dialledWith()).toEqual({
      providerId: "gce",
      sshTrust: "pinned-from-api",
      hostKey: "ssh-ed25519 AAAA",
    });
  });

  it("leaves the trust unknown when the route was rewritten and back while ssh opened", async () => {
    const env: ReturnType<typeof harness> = harness(async () => {
      // Rewritten to another key and back: the same key and generation, a later revision.
      env.setTrust({
        providerId: "gce",
        sshTrust: "pinned-from-api",
        hostKey: "ssh-ed25519 AAAA",
        revision: 5,
      });
      return {} as LinkTransportConnection;
    });
    await env.transport.open(signal());
    expect(env.dialledWith()?.sshTrust).toBeNull();
  });

  it("keeps each host's dial apart, even two hosts naming one machine", async () => {
    const env = harness(async () => ({}) as LinkTransportConnection);
    await env.transport.open(signal());
    env.setGeneration("203.0.113.10:22:ssh-ed25519 BBBB");
    env.setTrust({
      providerId: "gce",
      sshTrust: "pinned-from-api",
      hostKey: "ssh-ed25519 BBBB",
      revision: 2,
    });
    await env.transports.transportFor("cb_abcdefgh12", undefined, "h2").open(signal());
    expect(env.dialledWith("h1")?.hostKey).toBe("ssh-ed25519 AAAA");
    expect(env.dialledWith("h2")?.hostKey).toBe("ssh-ed25519 BBBB");
    // A host re-pointed at another machine has no dial on record for it.
    expect(env.transports.dialledWith("h1", "cb_otherbinding9")).toBeUndefined();
    env.forget();
    expect(env.dialledWith("h1")).toBeUndefined();
    expect(env.dialledWith("h2")).toBeUndefined();
  });

  it("leaves the trust unknown when the provider's trust changed mid-dial on the same route", async () => {
    const env: ReturnType<typeof harness> = harness(async () => {
      env.setTrust({ providerId: "gce", sshTrust: "provider-tunnel", hostKey: null, revision: 1 });
      return {} as LinkTransportConnection;
    });
    await env.transport.open(signal());
    expect(env.dialledWith()?.sshTrust).toBeNull();
  });
});
