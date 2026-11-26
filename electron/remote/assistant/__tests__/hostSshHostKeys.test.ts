import { describe, expect, it, vi } from "vitest";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";
import {
  HostSshHostKeysResultSchema,
  type HostSshTrust,
} from "../../../../shared/types/hostControl.js";
import {
  MAX_SSH_HOST_KEYS_PER_LISTENER,
  MAX_SSH_LISTENERS,
  type SshHostKeysAnswer,
} from "../../../../shared/types/hostSshHostKeys.js";
import { FIXTURE_KEYS } from "../../host/__tests__/sshKeyFixtures.js";
import type { HostSshHostKeysRead } from "../../client/HostSshHostKeysService.js";
import {
  projectSshReading,
  runHostSshHostKeys,
  type HostSshHostKeysToolDeps,
} from "../hostSshHostKeys.js";

const keyOf = (line: string) => line.split(" ").slice(0, 2).join(" ");
const ED25519 = keyOf(FIXTURE_KEYS.ed25519.line);

const PINNED: HostSshTrust = {
  basis: "provider-pin",
  providerId: "gce",
  pinnedFingerprint: FIXTURE_KEYS.ed25519.fingerprint,
};

function reading(
  listeners = 1,
  keys: { line: string; fingerprint: string }[] = [FIXTURE_KEYS.ed25519, FIXTURE_KEYS.ecdsa]
): SshHostKeysAnswer {
  return {
    status: "reading",
    complete: true,
    truncated: false,
    listeners: Array.from({ length: listeners }, (_, index) => ({
      listenerId: `listener-${index}`,
      pid: 100 + index,
      complete: true,
      gaps: [],
      configFile: "/etc/ssh/sshd_config",
      listenAddresses: ["0.0.0.0:22"],
      keys: keys.map(({ line, fingerprint }) => ({
        outcome: "read" as const,
        hostKeyPath: "/etc/ssh/ssh_host_key",
        publicKeyPath: "/etc/ssh/ssh_host_key.pub",
        type: line.split(" ")[0]!,
        publicKey: keyOf(line),
        fingerprint,
      })),
    })),
  };
}

function deps(
  read: HostSshHostKeysRead,
  overrides: Partial<Omit<HostSshHostKeysToolDeps, "read">> = {}
) {
  return {
    hostIds: () => ["h1"],
    controlOn: () => true,
    read: vi.fn(async (_hostId: string, _signal?: AbortSignal) => read),
    ...overrides,
  };
}

describe("runHostSshHostKeys", () => {
  it("answers ok with the trust and each read key held against the pin, paths left out", async () => {
    const result = await runHostSshHostKeys(
      deps({ status: "read", trust: PINNED, pinnedKey: ED25519, answer: reading() }),
      { hostId: "h1" }
    );
    expect(HostSshHostKeysResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ outcome: "ok", trust: PINNED });
    const keys = result.reading?.status === "reading" ? result.reading.listeners[0]!.keys : [];
    expect(keys).toEqual([
      {
        outcome: "read",
        type: "ssh-ed25519",
        publicKey: ED25519,
        fingerprint: FIXTURE_KEYS.ed25519.fingerprint,
        matchesPin: true,
      },
      {
        outcome: "read",
        type: "ecdsa-sha2-nistp256",
        publicKey: keyOf(FIXTURE_KEYS.ecdsa.line),
        fingerprint: FIXTURE_KEYS.ecdsa.fingerprint,
        matchesPin: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("ssh_host_key");
  });

  it("keeps a missing key's path, so the gap can be told where", async () => {
    const answer: SshHostKeysAnswer = {
      status: "reading",
      complete: false,
      truncated: false,
      listeners: [
        {
          listenerId: null,
          pid: 7,
          complete: false,
          gaps: [],
          configFile: null,
          listenAddresses: [],
          keys: [
            {
              outcome: "permission-denied",
              hostKeyPath: "/srv/tunnel/key",
              publicKeyPath: "/srv/tunnel/key.pub",
            },
          ],
        },
      ],
    };
    const result = await runHostSshHostKeys(
      deps({
        status: "read",
        trust: { basis: "provider-tunnel", providerId: "agent37", pinnedFingerprint: null },
        pinnedKey: null,
        answer,
      }),
      { hostId: "h1" }
    );
    expect(result.trust).toEqual({
      basis: "provider-tunnel",
      providerId: "agent37",
      pinnedFingerprint: null,
    });
    expect(result.reading).toEqual({
      status: "reading",
      complete: false,
      truncated: false,
      listeners: [
        {
          listenerId: null,
          complete: false,
          gaps: [],
          listenAddresses: [],
          keys: [{ outcome: "permission-denied", publicKeyPath: "/srv/tunnel/key.pub" }],
        },
      ],
    });
  });

  it.each([
    [{ status: "disconnected" }, "disconnected"],
    [{ status: "unsupported" }, "unsupported"],
    [{ status: "no-answer" }, "ambiguous"],
    [{ status: "rate-limited" }, "rate_limited"],
    [{ status: "invalid-answer" }, "ambiguous"],
    [{ status: "failed" }, "ambiguous"],
  ] as const)("answers %o as %s, with no trust or reading", async (read, outcome) => {
    const result = await runHostSshHostKeys(deps(read), { hostId: "h1" });
    expect(result).toMatchObject({ outcome, trust: null, reading: null });
    expect(result.detail?.length).toBeGreaterThan(0);
  });

  it("refuses local, an unknown host, and one whose control is off, without reading", async () => {
    const env = deps({ status: "disconnected" });
    const local = await runHostSshHostKeys(env, { hostId: "local" });
    expect(local.outcome).toBe("unsupported");
    expect(local.detail).toContain("local");
    expect(await runHostSshHostKeys(env, { hostId: "nope" })).toMatchObject({
      outcome: "not_found",
    });
    const off = deps({ status: "disconnected" }, { controlOn: () => false });
    expect(await runHostSshHostKeys(off, { hostId: "h1" })).toMatchObject({
      outcome: "opted_out",
    });
    expect(env.read).not.toHaveBeenCalled();
    expect(off.read).not.toHaveBeenCalled();
  });

  it("withholds a reading when control was turned off while the host read", async () => {
    let on = true;
    const env = deps(
      { status: "read", trust: PINNED, pinnedKey: ED25519, answer: reading() },
      { controlOn: () => on }
    );
    env.read.mockImplementationOnce(async () => {
      on = false;
      return { status: "read", trust: PINNED, pinnedKey: ED25519, answer: reading() };
    });
    expect(await runHostSshHostKeys(env, { hostId: "h1" })).toMatchObject({
      outcome: "opted_out",
      reading: null,
    });
  });

  it("withholds a reading when the host was removed while it read", async () => {
    let hosts = ["h1"];
    const env = deps({ status: "disconnected" }, { hostIds: () => hosts });
    env.read.mockImplementationOnce(async () => {
      hosts = [];
      return { status: "read", trust: PINNED, pinnedKey: ED25519, answer: reading() };
    });
    expect(await runHostSshHostKeys(env, { hostId: "h1" })).toMatchObject({
      outcome: "not_found",
      reading: null,
    });
  });

  it("is unsupported where no reader is installed, whatever host it names", async () => {
    for (const hostId of ["h1", "nope"]) {
      expect(
        await runHostSshHostKeys({ hostIds: () => ["h1"], controlOn: () => true }, { hostId })
      ).toMatchObject({ outcome: "unsupported" });
    }
  });

  it("tells a host on another protocol version from one that is down", async () => {
    const env = deps({ status: "disconnected" }, { versionMismatch: (hostId) => hostId === "h1" });
    const result = await runHostSshHostKeys(env, { hostId: "h1" });
    expect(result.outcome).toBe("unsupported");
    expect(result.detail).not.toContain("bringBack");
    const down = await runHostSshHostKeys(deps({ status: "disconnected" }), { hostId: "h1" });
    expect(down.outcome).toBe("disconnected");
  });

  it("says when the trust behind a reading couldn't be told, so its unmarked keys aren't read as unpinned", async () => {
    const unknown: HostSshTrust = { basis: "unknown", providerId: "gce", pinnedFingerprint: null };
    const result = await runHostSshHostKeys(
      deps({ status: "read", trust: unknown, pinnedKey: null, answer: reading() }),
      { hostId: "h1" }
    );
    const known = await runHostSshHostKeys(
      deps({ status: "read", trust: PINNED, pinnedKey: ED25519, answer: reading() }),
      { hostId: "h1" }
    );
    expect(result.outcome).toBe("ok");
    expect(result.detail).not.toBe(known.detail);
    expect(result.detail).toContain("pin");
  });
});

describe("projectSshReading", () => {
  it("fits the largest reading a Host may send inside one MCP answer, cutting whole keys and saying so", async () => {
    const big = reading(
      MAX_SSH_LISTENERS,
      Array.from({ length: MAX_SSH_HOST_KEYS_PER_LISTENER }, () => FIXTURE_KEYS.rsa)
    );
    const result = await runHostSshHostKeys(
      deps({ status: "read", trust: PINNED, pinnedKey: ED25519, answer: big }),
      { hostId: "h1" }
    );
    expect(HostSshHostKeysResultSchema.parse(result)).toEqual(result);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
    const projected = result.reading;
    if (projected?.status !== "reading") throw new Error("expected a reading");
    expect(projected).toMatchObject({ complete: false, truncated: true });
    const last = projected.listeners.at(-1)!;
    expect(last.complete).toBe(false);
    expect(last.gaps).toContain("truncated");
    for (const listener of projected.listeners) {
      for (const key of listener.keys) {
        if (key.outcome === "read") expect(key.publicKey).toBe(keyOf(FIXTURE_KEYS.rsa.line));
      }
    }
  });

  it("keeps the listeners within any budget it is given, and marks every cut", () => {
    const big = reading(4, [FIXTURE_KEYS.ed25519, FIXTURE_KEYS.ecdsa, FIXTURE_KEYS.rsa]);
    const full = projectSshReading(big, ED25519);
    if (full.status !== "reading") throw new Error("expected a reading");
    const whole = new TextEncoder().encode(JSON.stringify(full.listeners)).length;
    for (let budget = 300; budget <= whole + 50; budget += 23) {
      const projected = projectSshReading(big, ED25519, budget);
      if (projected.status !== "reading") throw new Error("expected a reading");
      const bytes = new TextEncoder().encode(JSON.stringify(projected.listeners)).length;
      expect(bytes, `budget ${budget}`).toBeLessThanOrEqual(budget);
      const kept = projected.listeners.reduce((sum, listener) => sum + listener.keys.length, 0);
      expect(projected.truncated, `budget ${budget}`).toBe(kept < 12);
      for (const listener of projected.listeners) {
        if (listener.keys.length < 3) {
          expect(listener.complete).toBe(false);
          expect(listener.gaps).toContain("truncated");
        }
      }
    }
  });

  it("carries a cut the Host made in one listener up to the whole reading", () => {
    const answer = reading(2);
    if (answer.status !== "reading") throw new Error("fixture");
    answer.complete = false;
    answer.listeners[1] = { ...answer.listeners[1]!, complete: false, gaps: ["truncated"] };
    const projected = projectSshReading(answer, null);
    expect(projected).toMatchObject({ complete: false, truncated: true });
  });

  it("leaves a reading that fits whole", () => {
    const projected = projectSshReading(reading(2), null);
    expect(projected).toMatchObject({ complete: true, truncated: false });
    if (projected.status !== "reading") throw new Error("expected a reading");
    expect(projected.listeners.flatMap((listener) => listener.keys)).toHaveLength(4);
    // No pin: nothing is marked either way.
    for (const key of projected.listeners.flatMap((listener) => listener.keys)) {
      if (key.outcome === "read") expect(key.matchesPin).toBeNull();
    }
    expect(projected.listeners.every((listener) => listener.complete)).toBe(true);
  });

  it("drops whole listeners past the budget and marks the reading cut", () => {
    const projected = projectSshReading(reading(3), null, 900);
    if (projected.status !== "reading") throw new Error("expected a reading");
    expect(projected.truncated).toBe(true);
    expect(projected.complete).toBe(false);
    expect(
      new TextEncoder().encode(JSON.stringify(projected.listeners)).length
    ).toBeLessThanOrEqual(900);
  });
});
