// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostIdleObservation } from "../../../../shared/types/hostIdle.js";
import { KEEP_AWAKE_PATH } from "../../cloud/agent37/agent37KeepAwake.js";
import { KeepAwakeKeeper, type KeepAwakeListener } from "../KeepAwakeKeeper.js";

const RESOURCE = "ab12cd34ef";
const PORT = 40_001;
const TOKEN_A = "tok_live_0123456789";
const TOKEN_B = "tok_live_9876543210";
const URL_A = `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=${TOKEN_A}`;
const URL_B = `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=${TOKEN_B}`;
const DAY = 86_400_000;

const keepers: KeepAwakeKeeper[] = [];
afterEach(() => {
  for (const keeper of keepers.splice(0)) keeper.dispose();
  vi.useRealTimers();
});

/**
 * How the edge answers: a status, whether the request reached the listener,
 * what happens once it did, and whether the answer then never comes back.
 */
type Answer = { status: number; reaches: boolean; after?: () => void; lost?: boolean };

/**
 * A keeper over a listener and an edge the test drives: the edge answers each
 * request as the test says, and reaches the listener unless told it doesn't.
 * The wall clock and the monotonic clock move together unless a test steps
 * the wall clock alone.
 */
function setup() {
  let wall = 1_800_000_000_000;
  let mono = 0;
  let busy = true;
  const expected = new Set<string>();
  const received = new Set<string>();
  const listener: KeepAwakeListener & { closed: number } = {
    port: PORT,
    closed: 0,
    expect: (nonce) => {
      expected.add(nonce);
    },
    take: (nonce) => {
      expected.delete(nonce);
      return received.delete(nonce);
    },
    close: () => {
      listener.closed += 1;
    },
  };
  let answer: (token: string | null) => Answer | Promise<Answer> = () => ({
    status: 204,
    reaches: true,
  });
  const requests: URL[] = [];
  const fetch = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    requests.push(url);
    const said = await answer(url.searchParams.get("a37_token"));
    if (said.reaches && url.pathname.startsWith(KEEP_AWAKE_PATH)) {
      const nonce = url.pathname.slice(KEEP_AWAKE_PATH.length);
      if (expected.delete(nonce)) received.add(nonce);
    }
    said.after?.();
    if (said.lost) throw new DOMException("The operation timed out.", "TimeoutError");
    return new Response(null, { status: said.status });
  });
  const listen = vi.fn(async () => listener);
  const idle = {
    observation: (): HostIdleObservation =>
      busy
        ? { idleAfterMinutes: 30, lastWorkAt: wall, busy: true, idleEndsAt: null }
        : { idleAfterMinutes: 30, lastWorkAt: wall, busy: false, idleEndsAt: wall + 1_800_000 },
  };
  const keeper = new KeepAwakeKeeper({
    idle,
    listen,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => wall,
    monotonic: () => mono,
  });
  keepers.push(keeper);
  const arm = (url = URL_A, expiresAt = wall + 7 * DAY) =>
    keeper.arm({ resourceId: RESOURCE, url, expiresAt });
  const tokens = () => requests.map((url) => url.searchParams.get("a37_token"));
  return {
    keeper,
    listener,
    listen,
    requests,
    tokens,
    arm,
    setBusy: (next: boolean) => {
      busy = next;
    },
    answer: (next: typeof answer) => {
      answer = next;
    },
    /** Both clocks move on. */
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    /** Only the wall clock moves: set back or forward by hand, or by NTP. */
    stepWall: (ms: number) => {
      wall += ms;
    },
    now: () => wall,
    /** Moves on in steps of `ms`, ticking after each. */
    passes: async (count: number, ms: number) => {
      for (let i = 0; i < count; i++) {
        wall += ms;
        mono += ms;
        await keeper.tick();
      }
    },
  };
}

describe("KeepAwakeKeeper (#17918)", () => {
  it("opens its listener only when asked, once, and says its port", async () => {
    const env = setup();
    expect(env.listen).not.toHaveBeenCalled();
    expect(env.keeper.status()).toEqual({
      port: null,
      expiresAt: null,
      reachedAt: null,
      problem: null,
    });
    // Two asks while the first is still opening share it.
    const [first, second] = await Promise.all([env.keeper.open(), env.keeper.open()]);
    await env.keeper.open();
    expect(env.listen).toHaveBeenCalledTimes(1);
    expect(first.port).toBe(PORT);
    expect(second.port).toBe(PORT);
  });

  it("says when it couldn't open a port, and opens one when asked again", async () => {
    const env = setup();
    env.listen.mockRejectedValueOnce(new Error("EADDRINUSE"));
    const failed = await env.keeper.open();
    expect(failed.port).toBeNull();
    expect(failed.problem).toContain("couldn't open a port");
    expect(await env.keeper.open()).toMatchObject({ port: PORT, problem: null });
  });

  it("checks a URL reaches it before holding it, while the host sees work", async () => {
    const env = setup();
    await env.keeper.open();
    const status = await env.arm();
    expect(env.requests).toHaveLength(1);
    const sent = env.requests[0]!;
    expect(sent.pathname).toMatch(new RegExp(`^${KEEP_AWAKE_PATH}[0-9a-f]{32}$`));
    expect(sent.searchParams.get("a37_token")).toBe(TOKEN_A);
    expect(status).toMatchObject({ expiresAt: env.now() + 7 * DAY, reachedAt: env.now() });
    expect(JSON.stringify(status)).not.toContain("tok_live");
    // Every request carries a nonce of its own.
    await env.passes(2, 30_000);
    expect(env.requests).toHaveLength(2);
    expect(env.requests[1]!.pathname).not.toBe(sent.pathname);
  });

  it("refuses a URL that answers without reaching it, and keeps the one it held", async () => {
    const env = setup();
    await env.keeper.open();
    const held = await env.arm();
    env.answer((token) => ({ status: 200, reaches: token !== TOKEN_B }));
    await expect(env.arm(URL_B, env.now() + DAY)).rejects.toMatchObject({
      code: "VALIDATION",
      userMessage: expect.stringContaining("never arrived"),
    });
    expect(env.keeper.status().expiresAt).toBe(held.expiresAt);
    await env.passes(2, 30_000);
    expect(env.tokens().at(-1)).toBe(TOKEN_A);
  });

  it("refuses a URL for another machine or port, or an expired one, without sending anything", async () => {
    const env = setup();
    await expect(env.arm()).rejects.toMatchObject({ code: "VALIDATION" });
    await env.keeper.open();
    for (const url of [
      `https://zz12cd34ef-${PORT}.agent37.app/?a37_token=t`,
      `https://${RESOURCE}-${PORT + 1}.agent37.app/?a37_token=t`,
      `http://${RESOURCE}-${PORT}.agent37.app/?a37_token=t`,
      `https://${RESOURCE}-${PORT}.agent37.app.example.com/?a37_token=t`,
      `https://${RESOURCE}-${PORT}.agent37.app/`,
      `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=`,
      `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=&x=1`,
      `https://user@${RESOURCE}-${PORT}.agent37.app/?a37_token=t`,
      `https://${RESOURCE}-${PORT}.agent37.app:443/?a37_token=t`,
      `https://${RESOURCE}-${PORT}.agent37.app:444/?a37_token=t`,
    ]) {
      await expect(env.arm(url)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(env.arm(URL_A, env.now())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.requests).toHaveLength(0);
    expect(env.keeper.status().expiresAt).toBeNull();
  });

  it("sends nothing while the host is idle, and checks a URL taken then on its first busy pass", async () => {
    const env = setup();
    env.setBusy(false);
    await env.keeper.open();
    const status = await env.arm();
    expect(env.requests).toHaveLength(0);
    expect(status).toMatchObject({ reachedAt: null, problem: null });
    await env.passes(10, 30_000);
    expect(env.requests).toHaveLength(0);
    env.setBusy(true);
    await env.passes(1, 10_000);
    expect(env.requests).toHaveLength(1);
    expect(env.keeper.status().reachedAt).toBe(env.now());
  });

  it("sends one request a minute while the host sees work, by a clock no wall-clock step moves", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    await env.passes(1, 59_999);
    expect(env.requests).toHaveLength(1);
    await env.passes(1, 1);
    expect(env.requests).toHaveLength(2);

    // The wall clock set back ten minutes: the next request still goes a minute later.
    env.stepWall(-10 * 60_000);
    await env.passes(1, 60_000);
    expect(env.requests).toHaveLength(3);
  });

  it("checks a URL that replaced one while idle on its first busy pass, however recently the old one went", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.setBusy(false);
    // Outlasting the old one, it is what the host says it holds.
    const replaced = await env.arm(URL_B, env.now() + 8 * DAY);
    // What reached it was the old URL, not this one.
    expect(replaced.reachedAt).toBeNull();
    env.setBusy(true);
    await env.passes(1, 10_000);
    expect(env.tokens()).toEqual([TOKEN_A, TOKEN_B]);
    expect(env.keeper.status().reachedAt).toBe(env.now());
  });

  it("takes back the URL that worked when the one that replaced it is turned away", async () => {
    const env = setup();
    await env.keeper.open();
    const first = await env.arm();
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 8 * DAY);
    env.setBusy(true);
    env.answer((token) =>
      token === TOKEN_B ? { status: 403, reaches: false } : { status: 204, reaches: true }
    );
    await env.passes(1, 10_000);
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, problem: null });
    await env.passes(1, 10_000);
    expect(env.tokens().at(-1)).toBe(TOKEN_A);
  });

  it.each([
    ["answered", false],
    ["its answer lost", true],
  ])("drops a URL that runs out after its request arrived, %s", async (_name, lost) => {
    const env = setup();
    await env.keeper.open();
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 20_000);
    env.setBusy(true);
    // It arrives with ten seconds left; the wait for its answer ends five seconds after it expired.
    env.answer(() => ({ status: 204, reaches: true, lost, after: () => env.advance(15_000) }));
    await env.passes(1, 10_000);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      reachedAt: null,
      problem: expect.stringContaining("expired"),
    });
  });

  it("takes back the URL that worked when the one that replaced it runs out while its answer is awaited", async () => {
    const env = setup();
    await env.keeper.open();
    const first = await env.arm();
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 20_000);
    env.setBusy(true);
    env.answer((token) => ({
      status: 204,
      reaches: true,
      after: token === TOKEN_B ? () => env.advance(15_000) : undefined,
    }));
    await env.passes(1, 10_000);
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, problem: null });
    await env.passes(1, 60_000);
    expect(env.tokens().at(-1)).toBe(TOKEN_A);
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, reachedAt: env.now() });
  });

  it("refuses a URL that ran out while it waited behind a pass, the host gone idle meanwhile", async () => {
    const env = setup();
    await env.keeper.open();
    const first = await env.arm();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    env.answer(async () => {
      await gate;
      return { status: 204, reaches: true };
    });
    env.advance(60_000);
    const pass = env.keeper.tick();
    const arming = env.arm(URL_B, env.now() + 5_000);
    // Taken in its turn, it now waits behind the pass's request.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    env.setBusy(false);
    env.advance(10_000);
    release();
    await pass;
    await expect(arming).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, problem: null });
    expect(env.tokens()).not.toContain(TOKEN_B);
  });

  it("keeps the longest-lived URL that reached it behind a shorter one that does too, unless they expire together", async () => {
    const env = setup();
    const TOKEN_C = "tok_live_5555555555";
    const URL_C = `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=${TOKEN_C}`;
    await env.keeper.open();
    const first = await env.arm();
    // An unchecked one comes between, then a shorter one reaches it: that one is held, the first behind it.
    env.setBusy(false);
    await env.arm(URL_C, env.now() + 9 * DAY);
    env.setBusy(true);
    // What covers the host longest is still the first.
    await expect(env.arm(URL_B, env.now() + DAY)).resolves.toMatchObject({
      expiresAt: first.expiresAt,
    });
    await env.passes(1, 60_000);
    expect(env.tokens().at(-1)).toBe(TOKEN_B);
    // A later one is turned away: the first comes back, not the shorter one.
    env.setBusy(false);
    await env.arm(URL_C, env.now() + 9 * DAY);
    env.setBusy(true);
    env.answer((token) =>
      token === TOKEN_C ? { status: 403, reaches: false } : { status: 204, reaches: true }
    );
    await env.passes(1, 10_000);
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, problem: null });
    // One that expires with it lets it go: turned away, nothing is left.
    await env.arm(URL_B, first.expiresAt!);
    env.answer((token) =>
      token === TOKEN_B ? { status: 403, reaches: false } : { status: 204, reaches: true }
    );
    await env.passes(1, 60_000);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("no longer accepts"),
    });
  });

  it("keeps the URL that worked behind every unchecked one that came after it", async () => {
    const env = setup();
    const TOKEN_C = "tok_live_5555555555";
    await env.keeper.open();
    const first = await env.arm();
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 8 * DAY);
    await env.arm(
      `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=${TOKEN_C}`,
      env.now() + 9 * DAY
    );
    env.setBusy(true);
    env.answer((token) =>
      token === TOKEN_A ? { status: 204, reaches: true } : { status: 403, reaches: false }
    );
    await env.passes(1, 10_000);
    expect(env.keeper.status()).toMatchObject({ expiresAt: first.expiresAt, problem: null });
  });

  it("lets go of the old URL once the new one reaches it", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 8 * DAY);
    env.setBusy(true);
    await env.passes(1, 10_000);
    expect(env.tokens().at(-1)).toBe(TOKEN_B);
    // Turned away later, it isn't replaced by the one it superseded.
    env.answer(() => ({ status: 403, reaches: false }));
    await env.passes(1, 60_000);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("no longer accepts"),
    });
  });

  it("drops a URL Agent 37 turns away, and one that expired, even while idle", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.answer(() => ({ status: 401, reaches: false }));
    await env.passes(1, 60_000);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("no longer accepts"),
    });

    env.answer(() => ({ status: 204, reaches: true }));
    await env.arm(URL_B, env.now() + 120_000);
    const before = env.requests.length;
    env.setBusy(false);
    await env.passes(1, 120_000);
    expect(env.requests).toHaveLength(before);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("expired"),
    });
  });

  it("counts a request that arrived as reaching it, though its answer timed out", async () => {
    const env = setup();
    await env.keeper.open();
    env.answer(() => ({ status: 204, reaches: true, lost: true }));
    await expect(env.arm()).resolves.toMatchObject({ reachedAt: env.now() });
    await env.passes(6, 60_000);
    expect(env.keeper.status()).toMatchObject({ reachedAt: env.now(), problem: null });
    // One that never arrived, its answer lost too, is a try that may pass.
    env.answer(() => ({ status: 204, reaches: false, lost: true }));
    await env.passes(1, 60_000);
    expect(env.keeper.status().reachedAt).toBe(env.now() - 60_000);
  });

  it("keeps a URL that reached it through failures that may pass", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.answer(() => ({ status: 502, reaches: false }));
    await env.passes(10, 120_000);
    expect(env.keeper.status().expiresAt).not.toBeNull();
    env.answer(() => ({ status: 204, reaches: true }));
    await env.passes(1, 120_000);
    expect(env.keeper.status().reachedAt).toBe(env.now());
  });

  it("gives up on a URL that never reached it after three tries, its arm's own among them", async () => {
    const env = setup();
    await env.keeper.open();
    env.answer(() => ({ status: 502, reaches: false }));
    // Taken on trust: the arm's own try may have failed for a moment.
    await expect(env.arm()).resolves.toMatchObject({ reachedAt: null, problem: null });
    await env.passes(1, 120_000);
    expect(env.requests).toHaveLength(2);
    expect(env.keeper.status().expiresAt).not.toBeNull();
    await env.passes(1, 120_000);
    expect(env.requests).toHaveLength(3);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("couldn't reach this host"),
    });
  });

  it("checks a new URL after a request already out, so neither's nonce is lost", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    let release!: () => void;
    env.answer(
      (token) =>
        new Promise<Answer>((resolve) => {
          if (token === TOKEN_A) release = () => resolve({ status: 204, reaches: true });
          else resolve({ status: 204, reaches: true });
        })
    );
    env.advance(60_000);
    const pass = env.keeper.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // The renewal arrives while that request is out, and waits for it.
    const renewal = env.arm(URL_B, env.now() + 8 * DAY);
    await new Promise((resolve) => setImmediate(resolve));
    expect(env.requests).toHaveLength(2);
    release();
    await pass;
    await expect(renewal).resolves.toMatchObject({
      expiresAt: env.now() + 8 * DAY,
      reachedAt: env.now(),
    });
    expect(env.tokens()).toEqual([TOKEN_A, TOKEN_A, TOKEN_B]);
  });

  it("never lets a late answer for a replaced URL drop the newer one", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    let refuse!: () => void;
    env.answer(
      () =>
        new Promise((resolve) => {
          refuse = () => resolve({ status: 401, reaches: false });
        })
    );
    env.advance(60_000);
    const pass = env.keeper.tick();
    await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
    // A new URL that outlasts the old one arrives, taken while the host is idle, before the old
    // request's answer.
    env.setBusy(false);
    await env.arm(URL_B, env.now() + 8 * DAY);
    refuse();
    await pass;
    expect(env.keeper.status()).toMatchObject({
      expiresAt: env.now() + 8 * DAY,
      problem: null,
    });
  });

  it("keeps its port open while it checks a URL for it, past the wait for a URL to come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const env = setup();
    await env.keeper.open();
    let release!: () => void;
    env.answer(
      () =>
        new Promise<Answer>((resolve) => {
          release = () => resolve({ status: 204, reaches: true });
        })
    );
    const armed = env.arm();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    vi.advanceTimersByTime(6 * 60_000);
    expect(env.listener.closed).toBe(0);
    release();
    await expect(armed).resolves.toMatchObject({ port: PORT, reachedAt: env.now() });

    // With nothing held, the port closes once nobody hands a URL over.
    const idle = setup();
    await idle.keeper.open();
    vi.advanceTimersByTime(6 * 60_000);
    expect(idle.listener.closed).toBe(1);
  });

  it("closes its listener and lets go of its URL on dispose, and takes no URL after", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.keeper.dispose();
    expect(env.listener.closed).toBe(1);
    expect(env.keeper.status()).toMatchObject({ expiresAt: null, reachedAt: null });
    await expect(env.arm()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
