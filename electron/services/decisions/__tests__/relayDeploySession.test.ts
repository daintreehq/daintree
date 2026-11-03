import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelayDeploySessions } from "../relayDeploySession.js";
import type {
  RelayDeployHost,
  RelayDeployHostEvents,
  RelayDeployResult,
} from "../relayDeployHost.js";

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
  dispose: ReturnType<typeof vi.fn>;
}

describe("RelayDeploySessions", () => {
  let hosts: FakeHost[];
  let onChange: ReturnType<typeof vi.fn>;
  let sessions: RelayDeploySessions;

  beforeEach(() => {
    hosts = [];
    onChange = vi.fn();
    sessions = new RelayDeploySessions({
      onChange,
      open: async (events) => {
        const host: FakeHost = {
          channelPath: `/tmp/daintree-deploy-${hosts.length}/host.sock`,
          events,
          dispose: vi.fn(),
        };
        hosts.push(host);
        return host;
      },
    });
  });

  const readPrefill = () => ({ keys: {} });

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

  it("hands over the held secret for that deploy's relay alone, until it's claimed", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult(COMPLETED);

    expect(sessions.claimable("another-deploy")).toBeNull();
    expect(sessions.claimable(id)).toEqual({ url: URL, claimSecret: SECRET });

    sessions.claimed(id);
    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toBeUndefined();
  });

  it("holds nothing to claim with when the CLI reported no secret or no URL", async () => {
    const { id } = await sessions.prepare(readPrefill);
    hosts[0]!.events.onResult({ ...COMPLETED, claimSecret: null, claimState: "claimed" });

    expect(sessions.claimable(id)).toBeNull();
    expect(sessions.snapshot()).toMatchObject({ state: "completed", claimState: "claimed" });
    expect(sessions.snapshot()?.holdsClaimSecret).toBeUndefined();
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
    hosts[0]!.events.onResult(COMPLETED);
    hosts[0]!.events.onInterrupted("closed");

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

    const next = new RelayDeploySessions({ onChange, open: async () => hosts[0]! });
    const waiting = await next.prepare(readPrefill);
    next.cancel(waiting.id);
    expect(next.snapshot()).toBeUndefined();
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
    const late: FakeHost = { channelPath: "/tmp/late", events: {} as never, dispose: vi.fn() };
    let calls = 0;
    const racing = new RelayDeploySessions({
      onChange,
      open: async (events) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          return late;
        }
        return { channelPath: "/tmp/second", events, dispose: vi.fn() };
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
