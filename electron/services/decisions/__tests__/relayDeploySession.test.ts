import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { RelayDeploySessions } from "../relayDeploySession.js";
import type {
  RelayDeployHost,
  RelayDeployHostEvents,
  RelayDeployResult,
} from "../relayDeployHost.js";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
} from "../../../../shared/types/decisions.js";

const URL = "https://daintree-decisions-0a1b2c3d.me.workers.dev";
const SECRET = "claim-secret-0123456789abcdef";

const COMPLETED: RelayDeployResult = {
  status: "completed",
  url: URL,
  claimSecret: SECRET,
  claimState: "unclaimed",
};

interface FakeHost extends RelayDeployHost {
  events: RelayDeployHostEvents;
  dispose: Mock<() => void>;
}

function fakeHost(channelPath: string, events: RelayDeployHostEvents): FakeHost {
  return { channelPath, events, dispose: vi.fn<() => void>() };
}

const SAVED: DecisionsConnectResult = {
  result: "saved",
  status: { state: "not-connected", relayOrigin: URL },
};

describe("RelayDeploySessions", () => {
  let hosts: FakeHost[];
  let onChange: Mock<() => void>;
  let sessions: RelayDeploySessions;

  beforeEach(() => {
    hosts = [];
    onChange = vi.fn<() => void>();
    sessions = new RelayDeploySessions({
      onChange,
      open: async (events) => {
        const host = fakeHost(`/tmp/daintree-deploy-${hosts.length}/host.sock`, events);
        hosts.push(host);
        return host;
      },
    });
  });

  const readPrefill = () => ({ keys: {} });

  it("gives the channel the settings reader it was handed, unread", async () => {
    const reader = vi.fn(() => ({ keys: { xai: "xai-key-0123456789" } }));

    await sessions.prepare(reader);

    expect(hosts[0]!.events.readPrefill).toBe(reader);
    expect(reader).not.toHaveBeenCalled();
  });

  it("waits for its CLI, then runs, then shows the result with no secret in it", async () => {
    const prepared = await sessions.prepare(readPrefill);

    expect(prepared).toEqual({ id: expect.any(String), hostChannel: hosts[0]!.channelPath });
    expect(sessions.snapshot()).toEqual({ id: prepared.id, state: "waiting" });

    hosts[0]!.events.onRunning();
    expect(sessions.snapshot()).toEqual({ id: prepared.id, state: "running" });

    hosts[0]!.events.onResult(COMPLETED);
    const snapshot = sessions.snapshot();
    expect(snapshot).toEqual({
      id: prepared.id,
      state: "completed",
      url: URL,
      claimState: "unclaimed",
      holdsClaimSecret: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("claims the reported relay with the held secret, and drops both once it's saved", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    const claimRelay = vi.fn(async (_claim: ClaimDecisionsRelayPayload) => SAVED);

    await expect(sessions.claim({ deployId: id }, claimRelay)).resolves.toBe(SAVED);

    expect(claimRelay).toHaveBeenCalledExactlyOnceWith({ url: URL, claimSecret: SECRET });
    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toBeUndefined();
  });

  it("keeps the secret through a claim that didn't save, for another try with weaker storage", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    const claimRelay = vi
      .fn(async (_claim: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> => SAVED)
      .mockResolvedValueOnce({
        result: "key-storage",
        kind: "weak-storage-unconfirmed",
        reason: "No keyring is available",
      });

    await sessions.claim({ deployId: id }, claimRelay);
    expect(sessions.claimable(id)).toEqual({ url: URL, claimSecret: SECRET });
    await sessions.claim({ deployId: id, acceptWeakStorage: true }, claimRelay);

    expect(claimRelay.mock.calls[1]![0]).toEqual({
      url: URL,
      claimSecret: SECRET,
      acceptWeakStorage: true,
    });
    expect(sessions.claimable(id)).toBeNull();
  });

  it("refuses to claim for a deploy it holds no secret for, sending nothing", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    const claimRelay = vi.fn(async (_claim: ClaimDecisionsRelayPayload) => SAVED);

    await expect(sessions.claim({ deployId: "another-deploy" }, claimRelay)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/no longer holds the claim secret/),
    });

    expect(claimRelay).not.toHaveBeenCalled();
    expect(sessions.claimable(id)).not.toBeNull();
  });

  it("leaves a newer deploy alone when an older one's claim saves after it started", async () => {
    const first = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    let finish!: (result: DecisionsConnectResult) => void;
    const claiming = sessions.claim(
      { deployId: first.id },
      () => new Promise<DecisionsConnectResult>((resolve) => (finish = resolve))
    );
    const second = await sessions.prepare(readPrefill);

    finish(SAVED);
    await claiming;

    expect(sessions.snapshot()).toEqual({ id: second.id, state: "waiting" });
  });

  it("holds nothing to claim with when the CLI reported no secret", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, claimSecret: null, claimState: "claimed" });

    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toMatchObject({ state: "completed", claimState: "claimed" });
    expect(sessions.snapshot()?.holdsClaimSecret).toBeUndefined();
  });

  it("holds nothing to claim with when the CLI reported a secret but no URL", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, status: "failed", url: null, error: "stopped" });

    expect(sessions.claimable(id)).toBeNull();
  });

  it("keeps a failed deploy's URL, secret and reason, since its Worker may exist", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, status: "failed", error: "wrangler exited 1" });

    expect(sessions.snapshot()).toMatchObject({
      state: "failed",
      url: URL,
      holdsClaimSecret: true,
      error: "wrangler exited 1",
    });
    expect(sessions.claimable(id)).toEqual({ url: URL, claimSecret: SECRET });
  });

  it("says why a channel ended with no result", async () => {
    await sessions.prepare(readPrefill);
    hosts[0]!.events.onInterrupted("closed");

    expect(sessions.snapshot()).toMatchObject({
      state: "interrupted",
      error: expect.stringMatching(/stopped before the CLI said how it went/),
    });
  });

  it("refuses a second deploy while one is asking its questions", async () => {
    await sessions.prepare(readPrefill);
    hosts[0]!.events.onRunning();

    await expect(sessions.prepare(readPrefill)).rejects.toThrow(/already running/);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.dispose).not.toHaveBeenCalled();
  });

  it("replaces a deploy whose CLI never connected, and ignores anything the old one reports", async () => {
    const first = await sessions.prepare(readPrefill);
    const second = await sessions.prepare(readPrefill);

    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    expect(second.id).not.toBe(first.id);
    const changes = onChange.mock.calls.length;
    hosts[0]!.events.onRunning();
    hosts[0]!.events.onResult(COMPLETED);
    hosts[0]!.events.onInterrupted("closed");

    expect(onChange).toHaveBeenCalledTimes(changes);
    expect(sessions.snapshot()).toEqual({ id: second.id, state: "waiting" });
    expect(sessions.claimable(first.id)).toBeNull();
  });

  it("lets a new deploy replace a finished one, dropping its secret", async () => {
    const first = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);

    await sessions.prepare(readPrefill);

    expect(sessions.claimable(first.id)).toBeNull();
  });

  it("cancels only a deploy still waiting for its CLI", async () => {
    const { id } = await sessions.prepare(readPrefill);
    sessions.cancel("another-deploy");
    expect(sessions.snapshot()?.id).toBe(id);

    hosts[0]!.events.onRunning();
    sessions.cancel(id);
    expect(sessions.snapshot()?.state).toBe("running");

    const waitingHost = fakeHost("/tmp/waiting", {} as RelayDeployHostEvents);
    const next = new RelayDeploySessions({ onChange, open: async () => waitingHost });
    const waiting = await next.prepare(readPrefill);
    onChange.mockClear();
    next.cancel(waiting.id);
    expect(next.snapshot()).toBeUndefined();
    expect(waitingHost.dispose).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("drops the channel and the secret when Decisions turns off, and deploys again after", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);

    sessions.reset();

    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toBeUndefined();
    await expect(sessions.prepare(readPrefill)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("starts nothing once disposed for quit", async () => {
    await sessions.prepare(readPrefill);
    sessions.dispose();

    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    await expect(sessions.prepare(readPrefill)).rejects.toThrow(/stopped/);
  });

  it("forgets a deploy whose channel couldn't open, and says so", async () => {
    const failing = new RelayDeploySessions({
      onChange,
      open: async () => {
        throw new Error("EACCES");
      },
    });

    await expect(failing.prepare(readPrefill)).rejects.toThrow(/couldn't open the channel/);
    expect(failing.snapshot()).toBeUndefined();
  });

  it("disposes a channel that opened after its deploy was replaced", async () => {
    let release!: () => void;
    const late = fakeHost("/tmp/late", {} as RelayDeployHostEvents);
    let calls = 0;
    const racing = new RelayDeploySessions({
      onChange,
      open: async (events) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          return late;
        }
        return fakeHost("/tmp/second", events);
      },
    });

    const first = racing.prepare(readPrefill);
    await Promise.resolve();
    const second = await racing.prepare(readPrefill);
    release();

    await expect(first).rejects.toThrow(/replaced/);
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(racing.snapshot()).toEqual({ id: second.id, state: "waiting" });
  });
});
