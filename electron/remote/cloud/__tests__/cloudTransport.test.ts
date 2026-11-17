import { describe, expect, it, vi } from "vitest";
import {
  SshAccessError,
  UnusableConnectionError,
  type LinkTransport,
  type LinkTransportConnection,
} from "../../client/transport.js";
import { createCloudTransports, type CloudTransportAccess } from "../cloudTransport.js";
import type { CloudSshRoute } from "../CloudSshFiles.js";

const ROUTE: CloudSshRoute = {
  target: "dtc-cb_abcdefgh12",
  sshPath: "/rh/cloud/machines/cb_abcdefgh12/ssh",
  configPath: "/rh/cloud/machines/cb_abcdefgh12/config",
};

function harness(open: LinkTransport["open"]) {
  let generation = "203.0.113.10:22:ssh-ed25519 AAAA";
  const access: CloudTransportAccess = {
    ensureAccess: vi.fn(async () => ROUTE),
    accessGeneration: vi.fn(() => generation),
    recheckHostKey: vi.fn(async () => {}),
  };
  const ssh = vi.fn((): LinkTransport => ({ open }));
  const transports = createCloudTransports({ access: () => access, ssh });
  return {
    access,
    ssh,
    transport: transports.transportFor("cb_abcdefgh12"),
    forget: () => transports.forget("cb_abcdefgh12"),
    setGeneration: (next: string) => {
      generation = next;
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
});
