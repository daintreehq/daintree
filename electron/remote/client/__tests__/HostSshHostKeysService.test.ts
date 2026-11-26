import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../../../../shared/types/remoteHosts.js";
import type { SshHostKeysAnswer } from "../../../../shared/types/hostSshHostKeys.js";
import type { CloudDialTrust } from "../../cloud/cloudTransport.js";
import { LinkMethod } from "../../host/linkMethods.js";
import { FIXTURE_KEYS } from "../../host/__tests__/sshKeyFixtures.js";
import type { LinkSession } from "../../link/session.js";
import {
  HostSshHostKeysService,
  matchesPinnedKey,
  SSH_HOST_KEYS_READ_TIMEOUT_MS,
} from "../HostSshHostKeysService.js";

const keyOf = (line: string) => line.split(" ").slice(0, 2).join(" ");
const ED25519 = keyOf(FIXTURE_KEYS.ed25519.line);
const ECDSA = keyOf(FIXTURE_KEYS.ecdsa.line);

function readingOf(...keys: { line: string; fingerprint: string }[]): SshHostKeysAnswer {
  return {
    status: "reading",
    complete: true,
    truncated: false,
    listeners: [
      {
        listenerId: "l1",
        pid: 42,
        complete: true,
        gaps: [],
        configFile: null,
        listenAddresses: ["0.0.0.0:22"],
        keys: keys.map(({ line, fingerprint }) => ({
          outcome: "read" as const,
          hostKeyPath: "/etc/ssh/key",
          publicKeyPath: "/etc/ssh/key.pub",
          type: line.split(" ")[0]!,
          publicKey: keyOf(line),
          fingerprint,
        })),
      },
    ],
  };
}

function fakeSession(
  call: (method: string, payload: unknown, options: unknown) => Promise<unknown>
) {
  return { isOpen: true, call: vi.fn(call) } as unknown as LinkSession & {
    isOpen: boolean;
    call: ReturnType<typeof vi.fn>;
  };
}

function harness(
  connection: HostConnection | null,
  options: { dial?: CloudDialTrust; answer?: () => Promise<unknown> } = {}
) {
  let opened: ((hostId: string, session: LinkSession) => void) | null = null;
  let current: LinkSession | null = null;
  const release = vi.fn();
  const hold = vi.fn(() => release);
  const service = new HostSshHostKeysService({
    connectionOf: () => connection,
    sessionOf: () => current,
    hold,
    onSessionOpened: (listener) => {
      opened = listener;
      return () => {
        opened = null;
      };
    },
    // Only the dial this host made to its own machine counts.
    cloudDialledWith: (hostId, bindingId) =>
      hostId === "h1" && bindingId === "cb_abcdefgh12" ? options.dial : undefined,
  });
  const session = fakeSession(options.answer ?? (async () => readingOf(FIXTURE_KEYS.ed25519)));
  return {
    service,
    session,
    hold,
    release,
    /** The link comes up: the service is told, as RemoteHostManager tells it. */
    connect(next: LinkSession = session) {
      current = next;
      opened?.("h1", next);
    },
    setCurrent(next: LinkSession | null) {
      current = next;
    },
  };
}

describe("HostSshHostKeysService", () => {
  it("reads a hand-added host's keys over its link, resting on the person's own ssh config", async () => {
    const env = harness({ kind: "ssh", target: "me@box" });
    env.connect();
    const read = await env.service.read("h1");
    expect(read).toMatchObject({
      status: "read",
      trust: { basis: "own-ssh-config", providerId: null, pinnedFingerprint: null },
      pinnedKey: null,
    });
    expect(env.session.call).toHaveBeenCalledWith(LinkMethod.SSH_HOST_KEYS, null, {
      timeoutMs: SSH_HOST_KEYS_READ_TIMEOUT_MS,
    });
    // The link is held while the read is out, and let go after.
    expect(env.hold).toHaveBeenCalledWith("h1");
    expect(env.release).toHaveBeenCalledTimes(1);
  });

  it("names a pinned cloud host's pin as the dial that opened its link pinned it", async () => {
    const env = harness(
      { kind: "cloud", bindingId: "cb_abcdefgh12" },
      {
        dial: { providerId: "gce", sshTrust: "pinned-from-api", hostKey: ED25519 },
        answer: async () => readingOf(FIXTURE_KEYS.ed25519, FIXTURE_KEYS.ecdsa),
      }
    );
    env.connect();
    const read = await env.service.read("h1");
    if (read.status !== "read") throw new Error(read.status);
    expect(read.trust).toEqual({
      basis: "provider-pin",
      providerId: "gce",
      pinnedFingerprint: FIXTURE_KEYS.ed25519.fingerprint,
    });
    const listener = read.answer.status === "reading" ? read.answer.listeners[0]! : null;
    const matches = listener?.keys.map((key) =>
      key.outcome === "read" ? matchesPinnedKey(key.publicKey, read.pinnedKey) : null
    );
    expect(matches).toEqual([true, false]);
  });

  it.each([
    ["confirm-on-first-connect", "person-confirmed-pin"],
    ["api-or-confirm", "provider-or-person-pin"],
  ] as const)("names a %s provider's pin as %s", async (sshTrust, basis) => {
    const env = harness(
      { kind: "cloud", bindingId: "cb_abcdefgh12" },
      { dial: { providerId: "digitalocean", sshTrust, hostKey: ECDSA } }
    );
    env.connect();
    expect(await env.service.read("h1")).toMatchObject({
      status: "read",
      trust: { basis, pinnedFingerprint: FIXTURE_KEYS.ecdsa.fingerprint },
    });
  });

  it("names an Agent 37 host's tunnel, with no pin to match", async () => {
    const env = harness(
      { kind: "cloud", bindingId: "cb_abcdefgh12" },
      { dial: { providerId: "agent37", sshTrust: "provider-tunnel", hostKey: null } }
    );
    env.connect();
    const read = await env.service.read("h1");
    expect(read).toMatchObject({
      status: "read",
      trust: { basis: "provider-tunnel", providerId: "agent37", pinnedFingerprint: null },
      pinnedKey: null,
    });
    expect(matchesPinnedKey(ED25519, null)).toBeNull();
  });

  it("keeps the trust a link was dialled with when the route is pinned anew while it stays up", async () => {
    const dial: CloudDialTrust = {
      providerId: "gce",
      sshTrust: "pinned-from-api",
      hostKey: ED25519,
    };
    const env = harness({ kind: "cloud", bindingId: "cb_abcdefgh12" }, { dial });
    env.connect();
    // A setup probe resolved access again and the next dial would pin another key.
    dial.hostKey = ECDSA;
    expect(await env.service.read("h1")).toMatchObject({
      trust: { pinnedFingerprint: FIXTURE_KEYS.ed25519.fingerprint },
    });
  });

  it("calls the trust unknown when the dial's pin couldn't be told", async () => {
    const env = harness(
      { kind: "cloud", bindingId: "cb_abcdefgh12" },
      { dial: { providerId: "gce", sshTrust: null, hostKey: null } }
    );
    env.connect();
    expect(await env.service.read("h1")).toMatchObject({
      status: "read",
      trust: { basis: "unknown", providerId: "gce", pinnedFingerprint: null },
      pinnedKey: null,
    });
  });

  it("calls a cloud link that opened before it was told of it unknown, and a WSL one local", async () => {
    const cloud = harness(
      { kind: "cloud", bindingId: "cb_abcdefgh12" },
      { dial: { providerId: "gce", sshTrust: "pinned-from-api", hostKey: ED25519 } }
    );
    cloud.setCurrent(cloud.session);
    expect(await cloud.service.read("h1")).toMatchObject({ trust: { basis: "unknown" } });

    const wsl = harness({ kind: "wsl", distro: "Ubuntu" });
    wsl.setCurrent(wsl.session);
    expect(await wsl.service.read("h1")).toMatchObject({ trust: { basis: "local-wsl" } });
  });

  it("answers disconnected for a host with no open link, and never calls or dials", async () => {
    const env = harness({ kind: "ssh", target: "me@box" });
    expect(await env.service.read("h1")).toEqual({ status: "disconnected" });
    expect(env.session.call).not.toHaveBeenCalled();
    expect(env.hold).not.toHaveBeenCalled();
  });

  it("answers not-found for a host this Shell doesn't have", async () => {
    const env = harness(null);
    expect(await env.service.read("h1")).toEqual({ status: "not-found" });
  });

  it("answers unsupported for an older Host that has no such method", async () => {
    const env = harness(
      { kind: "ssh", target: "me@box" },
      {
        answer: () =>
          Promise.reject(Object.assign(new Error("No handler"), { code: "UNSUPPORTED" })),
      }
    );
    env.connect();
    expect(await env.service.read("h1")).toEqual({ status: "unsupported" });
    expect(env.release).toHaveBeenCalledTimes(1);
  });

  it("calls a link replaced while it read disconnected, even when the old one answered", async () => {
    const env = harness({ kind: "ssh", target: "me@box" });
    const replacement = fakeSession(async () => readingOf(FIXTURE_KEYS.ecdsa));
    vi.mocked(env.session.call).mockImplementationOnce(async () => {
      env.connect(replacement);
      return readingOf(FIXTURE_KEYS.ed25519);
    });
    env.connect();
    expect(await env.service.read("h1")).toEqual({ status: "disconnected" });
  });

  it("calls an older Host's refusal on a link replaced meanwhile disconnected, not unsupported", async () => {
    const env = harness({ kind: "ssh", target: "me@box" });
    vi.mocked(env.session.call).mockImplementationOnce(async () => {
      env.setCurrent(null);
      throw Object.assign(new Error("No handler"), { code: "UNSUPPORTED" });
    });
    env.connect();
    expect(await env.service.read("h1")).toEqual({ status: "disconnected" });
  });

  it("tells no answer in time on an open link apart from a dropped one", async () => {
    const timedOut = () =>
      Promise.reject(Object.assign(new Error("No answer"), { code: "OUTCOME_UNKNOWN" }));
    const env = harness({ kind: "ssh", target: "me@box" }, { answer: timedOut });
    env.connect();
    expect(await env.service.read("h1")).toEqual({ status: "no-answer" });
  });

  it("passes the caller's abort to the link and answers cancelled", async () => {
    const abort = new AbortController();
    const env = harness(
      { kind: "ssh", target: "me@box" },
      {
        answer: () => {
          abort.abort();
          return Promise.reject(Object.assign(new Error("aborted"), { code: "OUTCOME_UNKNOWN" }));
        },
      }
    );
    env.connect();
    expect(await env.service.read("h1", abort.signal)).toEqual({ status: "cancelled" });
    expect(env.session.call).toHaveBeenCalledWith(LinkMethod.SSH_HOST_KEYS, null, {
      timeoutMs: SSH_HOST_KEYS_READ_TIMEOUT_MS,
      signal: abort.signal,
    });
  });

  it("refuses an answer that isn't a reading rather than passing it on", async () => {
    const env = harness(
      { kind: "ssh", target: "me@box" },
      {
        answer: async () => ({
          status: "reading",
          complete: true,
          truncated: false,
          listeners: [],
        }),
      }
    );
    env.connect();
    expect(await env.service.read("h1")).toEqual({ status: "invalid-answer" });
  });

  it.each([
    ["names another key's fingerprint", { fingerprint: FIXTURE_KEYS.ecdsa.fingerprint }],
    ["names another type than its key's", { type: "ssh-rsa" }],
    [
      "puts one key's type before another's blob",
      { publicKey: `ssh-ed25519 ${FIXTURE_KEYS.rsa.line.split(" ")[1]}` },
    ],
  ])(
    "refuses a reading whose key row %s, so it can't be shown as the pin",
    async (_name, change) => {
      const answer = readingOf(FIXTURE_KEYS.ed25519);
      if (answer.status !== "reading") throw new Error("fixture");
      Object.assign(answer.listeners[0]!.keys[0]!, change);
      const env = harness(
        { kind: "cloud", bindingId: "cb_abcdefgh12" },
        {
          dial: { providerId: "gce", sshTrust: "pinned-from-api", hostKey: ED25519 },
          answer: async () => answer,
        }
      );
      env.connect();
      expect(await env.service.read("h1")).toEqual({ status: "invalid-answer" });
    }
  );

  it("passes the Host's own non-readings through as they came", async () => {
    const env = harness(
      { kind: "ssh", target: "me@box" },
      { answer: async () => ({ status: "no-sshd-visible" }) }
    );
    env.connect();
    expect(await env.service.read("h1")).toMatchObject({
      status: "read",
      answer: { status: "no-sshd-visible" },
    });
  });

  it("matches a pin by its key, whatever its comment or RSA signature name", () => {
    const rsa = keyOf(FIXTURE_KEYS.rsa.line);
    expect(matchesPinnedKey(FIXTURE_KEYS.rsa.line, rsa.replace("ssh-rsa", "rsa-sha2-512"))).toBe(
      true
    );
    expect(matchesPinnedKey("not a key", rsa)).toBe(false);
  });
});
