import { describe, expect, it } from "vitest";
import type {
  HostSshKey,
  HostSshListenerReading,
  HostSshReadOutcome,
} from "../../../../shared/types/ipc/remoteHosts.js";
import {
  MAX_SAVED_SSH_LISTENERS,
  applyReading,
  readBaselines,
  readOutcome,
} from "../sshHostKeyReadings.js";

function key(char: string, type = "ssh-ed25519"): HostSshKey {
  return { type, fingerprint: `SHA256:${char.repeat(43)}`, publicKey: `${type} AAAA${char}` };
}

function listener(
  keys: HostSshKey[],
  overrides: Partial<HostSshListenerReading> = {}
): HostSshListenerReading {
  return {
    listenerId: "main",
    configFile: null,
    listenAddresses: ["0.0.0.0:22"],
    complete: true,
    gaps: [],
    keys,
    keyGaps: [],
    ...overrides,
  };
}

function reading(...listeners: HostSshListenerReading[]): HostSshReadOutcome {
  return {
    status: "reading",
    complete: listeners.every((entry) => entry.complete),
    truncated: false,
    listeners,
  };
}

describe("applyReading", () => {
  it("makes a first complete reading the baseline, with no change", () => {
    const [baseline] = applyReading([], reading(listener([key("A")])), 10);
    expect(baseline).toMatchObject({ listenerId: "main", readAt: 10, change: null });
    expect(baseline!.keys.map((k) => k.fingerprint)).toEqual([key("A").fingerprint]);
  });

  it("doesn't count order or a repeated key as a change", () => {
    const first = applyReading([], reading(listener([key("A"), key("B", "ssh-rsa")])), 10);
    const second = applyReading(
      first,
      reading(listener([key("B", "ssh-rsa"), key("A"), key("A")])),
      20
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ readAt: 20, change: null });
  });

  it("records the old keys when a complete reading differs, and advances the baseline", () => {
    const first = applyReading([], reading(listener([key("A")])), 10);
    const [changed] = applyReading(first, reading(listener([key("C")])), 20);
    expect(changed!.keys.map((k) => k.fingerprint)).toEqual([key("C").fingerprint]);
    expect(changed!.change).toEqual({ previous: first[0]!.keys, changedAt: 20 });
    // The same keys again keep the change on record for a later window.
    const [again] = applyReading([changed!], reading(listener([key("C")])), 30);
    expect(again!.change).toEqual(changed!.change);
  });

  it("never lets a partial reading replace the baseline", () => {
    const first = applyReading([], reading(listener([key("A")])), 10);
    const partial = applyReading(
      first,
      reading(listener([key("B")], { complete: false, gaps: ["timed-out"] })),
      20
    );
    expect(partial).toEqual(first);
    // A later complete reading is compared with the last complete one, not the partial.
    const [changed] = applyReading(partial, reading(listener([key("C")])), 30);
    expect(changed!.change?.previous.map((k) => k.fingerprint)).toEqual([key("A").fingerprint]);
  });

  it("keeps the baseline through a failed read and a listener missing this time", () => {
    const first = applyReading([], reading(listener([key("A")])), 10);
    for (const outcome of [
      { status: "timed-out" },
      { status: "no-sshd-visible" },
      { status: "failed", message: "x" },
    ] as HostSshReadOutcome[]) {
      expect(applyReading(first, outcome, 20)).toEqual(first);
    }
    const other = applyReading(first, reading(listener([key("D")], { listenerId: "tunnel" })), 20);
    expect(other.map((b) => b.listenerId)).toEqual(["main", "tunnel"]);
    expect(other.find((b) => b.listenerId === "main")).toEqual(first[0]);
  });

  it("never keeps a listener without an identity of its own", () => {
    expect(applyReading([], reading(listener([key("A")], { listenerId: null })), 10)).toEqual([]);
    const twice = reading(listener([key("A")]), listener([key("B")]));
    expect(applyReading([], twice, 10)).toEqual([]);
  });

  it("keeps at most the most recently read listeners", () => {
    let baselines = applyReading([], reading(listener([key("A")], { listenerId: "old" })), 1);
    for (let i = 0; i < MAX_SAVED_SSH_LISTENERS; i++) {
      baselines = applyReading(
        baselines,
        reading(listener([key("A")], { listenerId: `l${i}` })),
        10 + i
      );
    }
    expect(baselines).toHaveLength(MAX_SAVED_SSH_LISTENERS);
    expect(baselines.some((b) => b.listenerId === "old")).toBe(false);
  });
});

describe("readOutcome", () => {
  it("splits a listener's keys into those read and those that gave none", () => {
    const outcome = readOutcome({
      status: "reading",
      complete: false,
      truncated: false,
      listeners: [
        {
          listenerId: "main",
          pid: 42,
          complete: false,
          gaps: [],
          configFile: null,
          listenAddresses: [],
          keys: [
            {
              outcome: "read",
              hostKeyPath: "/etc/ssh/ssh_host_ed25519_key",
              publicKeyPath: "/etc/ssh/ssh_host_ed25519_key.pub",
              ...key("A"),
            },
            {
              outcome: "permission-denied",
              hostKeyPath: "/etc/ssh/ssh_host_rsa_key",
              publicKeyPath: "/etc/ssh/ssh_host_rsa_key.pub",
            },
          ],
        },
      ],
    });
    expect(outcome.status === "reading" && outcome.listeners[0]).toMatchObject({
      keys: [key("A")],
      keyGaps: [{ publicKeyPath: "/etc/ssh/ssh_host_rsa_key.pub", reason: "permission-denied" }],
    });
  });
});

describe("readBaselines", () => {
  it("drops entries a hand-edited file left unusable", () => {
    const good = applyReading([], reading(listener([key("A")])), 10)[0]!;
    expect(
      readBaselines([
        good,
        {
          ...good,
          listenerId: "bad-key",
          keys: [{ type: "x", fingerprint: "nope", publicKey: "" }],
        },
        { ...good, listenerId: "" },
        good,
        "junk",
      ])
    ).toEqual([good]);
    expect(readBaselines({})).toEqual([]);
  });
});
