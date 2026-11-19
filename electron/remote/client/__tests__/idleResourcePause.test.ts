// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IdlePauseGuard,
  IdlePausePreparation,
  IdlePauseRunOutcome,
} from "../../../../shared/types/idlePause.js";
import type {
  HostDescriptor,
  HostId,
  HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";
import { LinkMethod } from "../../host/linkMethods.js";
import type { LinkSession } from "../../link/session.js";
import { watchIdleResourcePause } from "../idleResourcePause.js";

const HOST = "host-box";
const WORKTREE = "/repo-worktrees/feature-x";
const BOX = "dev@box-1.example";

const guard: IdlePauseGuard = {
  selector: "settings:gpu",
  fingerprint: "f".repeat(64),
  sshTarget: BOX,
  commandsDigest: "d".repeat(64),
  generation: 0,
  environmentEpoch: 0,
  monitorGeneration: 0,
  processEpoch: "run-1",
};

function ownedHost(overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    id: HOST,
    name: "box-1",
    connection: { kind: "ssh", target: BOX },
    ownerWorktreeId: WORKTREE,
    ...overrides,
  } as HostDescriptor;
}

function summary(
  idle: Partial<NonNullable<HostMetricsSummary["idle"]>> | null,
  sampledAt = 10_000
) {
  return {
    hostId: HOST,
    sampledAt,
    ...(idle === null
      ? {}
      : {
          idle: {
            idleAfterMinutes: 30,
            lastWorkAt: 1_000,
            busy: false,
            idleEndsAt: 5_000,
            ...idle,
          },
        }),
  } as HostMetricsSummary;
}

/** A link whose claim answer the test sets, counting each ask. */
function fakeSession(answer: () => Promise<unknown> = async () => ({ granted: true })) {
  const call = vi.fn(async (method: string) => {
    if (method !== LinkMethod.CLAIM_IDLE) throw new Error(`unexpected ${method}`);
    return answer();
  });
  return { isOpen: true, call } as unknown as LinkSession & { call: typeof call };
}

let hosts: Map<HostId, HostDescriptor>;
let latest: HostMetricsSummary | null;
let cameOn: boolean | null;
let session: ReturnType<typeof fakeSession>;
let summaryListener: ((hostId: HostId) => void) | null;
let registryListener: (() => void) | null;
let prepare: ReturnType<typeof vi.fn<(worktreeId: string) => Promise<IdlePausePreparation>>>;
let run: ReturnType<typeof vi.fn<() => Promise<IdlePauseRunOutcome>>>;
let onFailed: ReturnType<typeof vi.fn<(host: HostDescriptor, error: string) => void>>;
let dispose: () => void;
let clock: number;

function start() {
  dispose = watchIdleResourcePause({
    // A fresh record on every read, as the real registry hands out.
    registry: {
      get: (hostId) => {
        const host = hosts.get(hostId);
        return host ? { ...host, connection: { ...host.connection } } : null;
      },
      list: () => [...hosts.values()].map((host) => ({ ...host })),
      onChange: (listener) => {
        registryListener = listener;
        return () => {
          registryListener = null;
        };
      },
    },
    metrics: {
      onSummary: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = null;
        };
      },
      latest: () => latest,
      cameOn: () => cameOn,
    },
    sessionFor: () => session,
    prepare,
    onFailed,
    now: () => clock,
  });
}

/** A summary arriving, then everything it started settling. */
async function hear(next: HostMetricsSummary | null = latest): Promise<void> {
  latest = next;
  summaryListener?.(HOST);
  await vi.waitFor(() => undefined);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  hosts = new Map([[HOST, ownedHost()]]);
  latest = summary({});
  cameOn = true;
  session = fakeSession();
  summaryListener = null;
  registryListener = null;
  run = vi.fn(async () => ({ ran: true, success: true }) as IdlePauseRunOutcome);
  prepare = vi.fn(async () => ({ ok: true, guard, run }) as IdlePausePreparation);
  onFailed = vi.fn();
  clock = 0;
  start();
});

afterEach(() => {
  dispose();
});

describe("watchIdleResourcePause (#17925)", () => {
  it("claims an ended idle time and pauses only once the grant arrives", async () => {
    let grant!: (answer: unknown) => void;
    session = fakeSession(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        })
    );

    await hear();
    expect(prepare).toHaveBeenCalledWith(WORKTREE);
    expect(session.call).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    grant({ granted: true });
    await hear();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("asks nothing while idle pause is off, and checks again only a minute on", async () => {
    prepare.mockResolvedValue({ ok: false, reason: "Idle pause is off for this environment" });

    await hear();
    await hear();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(session.call).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    // Turned on meanwhile: the next look takes it.
    prepare.mockResolvedValue({ ok: true, guard, run });
    clock = 60_000;
    await hear();
    expect(session.call).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["seen working", { busy: true }],
    ["with no end to its idle time", { idleEndsAt: null }],
  ])("leaves a host %s running", async (_label, idle) => {
    await hear(summary(idle));

    expect(prepare).not.toHaveBeenCalled();
    expect(session.call).not.toHaveBeenCalled();
  });

  it("leaves a host that reports no idle time running", async () => {
    await hear(summary(null));

    expect(prepare).not.toHaveBeenCalled();
  });

  it("goes by the host's clock, not this machine's", async () => {
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await hear(summary({ idleEndsAt: 12_000 }, 10_000));

    expect(prepare).not.toHaveBeenCalled();
  });

  it("acts once the host's idle time ends exactly at its reading", async () => {
    await hear(summary({ idleEndsAt: 10_000 }, 10_000));

    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an earlier link", false],
    ["no link at all", null],
  ])("never acts on a summary from %s", async (_label, provenance) => {
    cameOn = provenance;

    await hear();

    expect(prepare).not.toHaveBeenCalled();
  });

  it("never pauses a host the person already had", async () => {
    hosts.set(HOST, ownedHost({ ownerWorktreeId: undefined }));

    await hear();

    expect(prepare).not.toHaveBeenCalled();
    expect(session.call).not.toHaveBeenCalled();
  });

  it("asks nothing when the environment reports another machine", async () => {
    prepare.mockResolvedValue({
      ok: true,
      guard: { ...guard, sshTarget: "dev@box-2.example" },
      run,
    });

    await hear();

    expect(session.call).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing on a refused claim, and doesn't ask again for that idle time", async () => {
    session = fakeSession(async () => ({ granted: false }));

    await hear();
    await hear();

    expect(session.call).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    // New work on the host and another full idle time: a new one to ask about.
    await hear(summary({ lastWorkAt: 2_000, idleEndsAt: 8_000 }));
    expect(session.call).toHaveBeenCalledTimes(2);
  });

  it("takes an older host's answer as no claim", async () => {
    session = fakeSession(async () => {
      throw Object.assign(new Error("no such method"), { code: "UNSUPPORTED" });
    });

    await hear();

    expect(run).not.toHaveBeenCalled();
  });

  it("asks once while a check is still under way", async () => {
    let finish!: (value: IdlePausePreparation) => void;
    prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );

    await hear();
    await hear();
    finish({ ok: true, guard, run });
    await hear();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(session.call).toHaveBeenCalledTimes(1);
  });

  it("reports a pause that fails, and doesn't retry it", async () => {
    run.mockResolvedValue({ ran: true, success: false, error: "Command timed out" });

    await hear();
    await hear();

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: HOST }),
      "Command timed out"
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stays quiet about a pause refused after the claim", async () => {
    run.mockResolvedValue({ ran: false, reason: "Another resource action is queued or running" });

    await hear();

    expect(onFailed).not.toHaveBeenCalled();
  });

  it("doesn't pause a host whose owner changed during the check", async () => {
    prepare.mockImplementation(async () => {
      hosts.set(HOST, ownedHost({ ownerWorktreeId: "/repo-worktrees/other" }));
      return { ok: true, guard, run };
    });

    await hear();

    expect(session.call).not.toHaveBeenCalled();
  });

  it("doesn't pause a host whose owner changed while the claim was asked", async () => {
    session = fakeSession(async () => {
      hosts.set(HOST, ownedHost({ ownerWorktreeId: "/repo-worktrees/other" }));
      return { granted: true };
    });

    await hear();

    expect(session.call).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", async () => {
    dispose();

    expect(summaryListener).toBeNull();
    expect(registryListener).toBeNull();
  });
});
