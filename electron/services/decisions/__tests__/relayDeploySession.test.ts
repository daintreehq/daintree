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
import { AppError } from "../../../utils/errorTypes.js";

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

const WEAK: DecisionsConnectResult = {
  result: "key-storage",
  kind: "weak-storage-unconfirmed",
  reason: "No keyring is available",
};

type ClaimRelay = (claim: ClaimDecisionsRelayPayload) => Promise<DecisionsConnectResult>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets a claim that main started by itself run to its end. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RelayDeploySessions", () => {
  let hosts: FakeHost[];
  let onChange: Mock<() => void>;
  let claimRelay: Mock<ClaimRelay>;
  let sessions: RelayDeploySessions;

  beforeEach(() => {
    hosts = [];
    onChange = vi.fn<() => void>();
    claimRelay = vi.fn<ClaimRelay>(async () => SAVED);
    sessions = new RelayDeploySessions({
      onChange,
      claimRelay,
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

    claimRelay.mockReturnValueOnce(new Promise<DecisionsConnectResult>(() => {}));
    hosts[0]!.events.onResult(COMPLETED);
    const snapshot = sessions.snapshot();
    expect(snapshot).toEqual({
      id: prepared.id,
      state: "completed",
      url: URL,
      claimState: "unclaimed",
      holdsClaimSecret: true,
      claim: { state: "claiming" },
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("claims a completed deploy's relay by itself, then drops the secret and keeps the outcome", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    await settled();

    expect(claimRelay).toHaveBeenCalledExactlyOnceWith({ url: URL, claimSecret: SECRET });
    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toEqual({
      id,
      state: "completed",
      url: URL,
      claimState: "unclaimed",
      claim: { state: "claimed", origin: URL },
    });
    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    await expect(sessions.claim({ deployId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never claims a cancelled or failed deploy by itself, though its relay can still be claimed", async () => {
    const cancelled = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, status: "cancelled" });
    await settled();
    expect(claimRelay).not.toHaveBeenCalled();
    expect(sessions.snapshot()?.claim).toBeUndefined();
    expect(sessions.claimable(cancelled.id)).toEqual({ url: URL, claimSecret: SECRET });

    const failed = await sessions.prepare(readPrefill);
    hosts[1]!.events.onResult({ ...COMPLETED, status: "failed", error: "wrangler exited 1" });
    await settled();
    expect(claimRelay).not.toHaveBeenCalled();

    await expect(sessions.claim({ deployId: failed.id })).resolves.toBe(SAVED);
    expect(claimRelay).toHaveBeenCalledExactlyOnceWith({ url: URL, claimSecret: SECRET });
  });

  it("keeps the secret through a claim that didn't save, for another try with weaker storage", async () => {
    claimRelay.mockResolvedValueOnce(WEAK);
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    await settled();

    expect(sessions.snapshot()).toMatchObject({
      holdsClaimSecret: true,
      claim: { state: "failed", failure: WEAK },
    });
    expect(sessions.claimable(id)).toEqual({ url: URL, claimSecret: SECRET });

    await sessions.claim({ deployId: id, acceptWeakStorage: true });

    expect(claimRelay.mock.calls[1]![0]).toEqual({
      url: URL,
      claimSecret: SECRET,
      acceptWeakStorage: true,
    });
    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()?.claim).toEqual({ state: "claimed", origin: URL });
  });

  it("shows main's own reason for a claim it couldn't make, and nothing else's", async () => {
    claimRelay.mockRejectedValueOnce(new Error(`socket said ${SECRET}`));
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    await settled();

    const failure = sessions.snapshot()?.claim;
    expect(failure).toMatchObject({ state: "failed", failure: { result: "error" } });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(sessions.claimable(id)).not.toBeNull();

    claimRelay.mockRejectedValueOnce(
      new AppError({ code: "CANCELLED", message: "Decisions is off, so nothing was changed" })
    );
    await expect(sessions.claim({ deployId: id })).rejects.toThrow(/Decisions is off/);
    expect(sessions.snapshot()?.claim).toEqual({
      state: "failed",
      failure: { result: "error", message: "Decisions is off, so nothing was changed" },
    });
  });

  it("joins a retry to the claim in flight, and starts no deploy until it settles", async () => {
    const pending = deferred<DecisionsConnectResult>();
    claimRelay.mockReturnValueOnce(pending.promise);
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);

    const retry = sessions.claim({ deployId: id, acceptWeakStorage: true });
    await expect(sessions.prepare(readPrefill)).rejects.toThrow(/still claiming/);
    pending.resolve(SAVED);

    await expect(retry).resolves.toBe(SAVED);
    expect(claimRelay).toHaveBeenCalledOnce();
    await expect(sessions.prepare(readPrefill)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("refuses to claim for a deploy it holds no secret for, sending nothing", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, status: "cancelled" });

    await expect(sessions.claim({ deployId: "another-deploy" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/no longer holds the claim secret/),
    });

    expect(claimRelay).not.toHaveBeenCalled();
    expect(sessions.claimable(id)).not.toBeNull();
  });

  it("leaves a newer deploy alone when an older one's claim saves after Decisions turned off", async () => {
    const pending = deferred<DecisionsConnectResult>();
    claimRelay.mockReturnValueOnce(pending.promise);
    await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);
    await settled();

    sessions.reset();
    const second = await sessions.prepare(readPrefill);
    pending.resolve(SAVED);
    await settled();

    expect(sessions.snapshot()).toEqual({ id: second.id, state: "waiting" });
  });

  it("holds nothing to claim with when the CLI reported no secret", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, claimSecret: null, claimState: "claimed" });
    await settled();

    expect(claimRelay).not.toHaveBeenCalled();
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

    await settled();

    expect(onChange).toHaveBeenCalledTimes(changes);
    expect(claimRelay).not.toHaveBeenCalled();
    expect(sessions.snapshot()).toEqual({ id: second.id, state: "waiting" });
    expect(sessions.claimable(first.id)).toBeNull();
  });

  it("lets a new deploy replace a finished one, dropping its secret", async () => {
    const first = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, status: "cancelled" });

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
    const next = new RelayDeploySessions({ onChange, claimRelay, open: async () => waitingHost });
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
    await settled();

    // The claim the result started never began, so the secret went nowhere.
    expect(claimRelay).not.toHaveBeenCalled();
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
      claimRelay,
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
      claimRelay,
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
