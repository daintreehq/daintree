// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostIdleObservation } from "../../../../shared/types/hostIdle.js";
import { KEEP_AWAKE_PATH } from "../../cloud/agent37/agent37KeepAwake.js";
import { KeepAwakeKeeper, type KeepAwakeListener } from "../KeepAwakeKeeper.js";

const RESOURCE = "ab12cd34ef";
const PORT = 40_001;
const URL_OK = `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=tok_live_0123456789`;
const URL_NEXT = `https://${RESOURCE}-${PORT}.agent37.app/?a37_token=tok_live_9876543210`;

const keepers: KeepAwakeKeeper[] = [];
afterEach(() => {
  for (const keeper of keepers.splice(0)) keeper.dispose();
});

/**
 * A keeper over a listener and an edge the test drives: the edge answers each
 * request as the test says, and reaches the listener unless told it doesn't.
 */
function setup() {
  let now = 1_800_000_000_000;
  let busy = true;
  let expected: string | null = null;
  let received: string | null = null;
  const listener: KeepAwakeListener & { closed: number } = {
    port: PORT,
    closed: 0,
    expect: (nonce) => {
      expected = nonce;
      received = null;
    },
    take: (nonce) => {
      const arrived = received === nonce;
      received = null;
      expected = null;
      return arrived;
    },
    close: () => {
      listener.closed += 1;
    },
  };
  /** How the edge answers the next requests: a status, and whether the request reached the listener. */
  let answer: () =>
    { status: number; reaches: boolean } | Promise<{ status: number; reaches: boolean }> = () => ({
    status: 204,
    reaches: true,
  });
  const requests: string[] = [];
  const fetch = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    const said = await answer();
    if (said.reaches && url.pathname.startsWith(KEEP_AWAKE_PATH)) {
      const nonce = url.pathname.slice(KEEP_AWAKE_PATH.length);
      if (nonce === expected) received = nonce;
    }
    return new Response(null, { status: said.status });
  });
  const listen = vi.fn(async () => listener);
  const idle = {
    observation: (): HostIdleObservation =>
      busy
        ? { idleAfterMinutes: 30, lastWorkAt: now, busy: true, idleEndsAt: null }
        : { idleAfterMinutes: 30, lastWorkAt: now, busy: false, idleEndsAt: now + 1_800_000 },
  };
  const keeper = new KeepAwakeKeeper({
    idle,
    listen,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
  });
  keepers.push(keeper);
  const arm = (url = URL_OK, expiresAt = now + 7 * 86_400_000) =>
    keeper.arm({ resourceId: RESOURCE, url, expiresAt });
  return {
    keeper,
    listener,
    listen,
    requests,
    arm,
    setBusy: (next: boolean) => {
      busy = next;
    },
    answer: (next: typeof answer) => {
      answer = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
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
    await env.keeper.open();
    const status = await env.keeper.open();
    expect(env.listen).toHaveBeenCalledTimes(1);
    expect(status.port).toBe(PORT);
  });

  it("says when it couldn't open a port, and opens one when asked again", async () => {
    const env = setup();
    env.listen.mockRejectedValueOnce(new Error("EADDRINUSE"));
    const failed = await env.keeper.open();
    expect(failed.port).toBeNull();
    expect(failed.problem).toContain("couldn't open a port");
    expect((await env.keeper.open()).port).toBe(PORT);
  });

  it("checks a URL reaches it before holding it, while the host sees work", async () => {
    const env = setup();
    await env.keeper.open();
    const status = await env.arm();
    expect(env.requests).toHaveLength(1);
    const sent = new URL(env.requests[0]!);
    expect(sent.pathname).toMatch(new RegExp(`^${KEEP_AWAKE_PATH}[0-9a-f]{32}$`));
    expect(sent.searchParams.get("a37_token")).toBe("tok_live_0123456789");
    expect(status).toMatchObject({ expiresAt: env.now() + 7 * 86_400_000, reachedAt: env.now() });
    expect(JSON.stringify(status)).not.toContain("tok_live");
  });

  it("refuses a URL that answers without reaching it, and keeps the one it held", async () => {
    const env = setup();
    await env.keeper.open();
    const held = await env.arm();
    env.answer(() => ({ status: 200, reaches: false }));
    await expect(env.arm(URL_NEXT, env.now() + 86_400_000)).rejects.toMatchObject({
      code: "VALIDATION",
      userMessage: expect.stringContaining("something other than this machine"),
    });
    expect(env.keeper.status().expiresAt).toBe(held.expiresAt);
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
      `https://user@${RESOURCE}-${PORT}.agent37.app/?a37_token=t`,
    ]) {
      await expect(env.arm(url)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(env.arm(URL_OK, env.now())).rejects.toMatchObject({ code: "VALIDATION" });
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
    for (let i = 0; i < 10; i++) {
      env.advance(30_000);
      await env.keeper.tick();
    }
    expect(env.requests).toHaveLength(0);
    env.setBusy(true);
    env.advance(30_000);
    await env.keeper.tick();
    expect(env.requests).toHaveLength(1);
    expect(env.keeper.status().reachedAt).toBe(env.now());
  });

  it("sends one request a minute while the host sees work", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    for (let i = 0; i < 20; i++) {
      env.advance(30_000);
      await env.keeper.tick();
    }
    // The check on arm, then one every other 30-second pass for ten minutes.
    expect(env.requests).toHaveLength(11);
  });

  it("drops a URL Agent 37 turns away, and one that expired", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.answer(() => ({ status: 401, reaches: false }));
    env.advance(60_000);
    await env.keeper.tick();
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("no longer accepts"),
    });

    env.answer(() => ({ status: 204, reaches: true }));
    await env.arm(URL_NEXT, env.now() + 120_000);
    const before = env.requests.length;
    env.advance(120_000);
    await env.keeper.tick();
    expect(env.requests).toHaveLength(before);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("expired"),
    });
  });

  it("keeps a URL that reached it through a failure that may pass, and gives up on one that never did", async () => {
    const env = setup();
    await env.keeper.open();
    await env.arm();
    env.answer(() => ({ status: 502, reaches: false }));
    for (let i = 0; i < 10; i++) {
      env.advance(120_000);
      await env.keeper.tick();
    }
    expect(env.keeper.status().expiresAt).not.toBeNull();

    // Never reached: given up after a few tries.
    const fresh = setup();
    fresh.setBusy(false);
    await fresh.keeper.open();
    await fresh.arm();
    fresh.setBusy(true);
    fresh.answer(() => ({ status: 502, reaches: false }));
    for (let i = 0; i < 10; i++) {
      fresh.advance(120_000);
      await fresh.keeper.tick();
    }
    expect(fresh.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("couldn't reach this host"),
    });
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
    // A new URL arrives, taken while the host is idle, before the old request's answer.
    env.setBusy(false);
    await env.arm(URL_NEXT, env.now() + 86_400_000);
    refuse();
    await pass;
    expect(env.keeper.status()).toMatchObject({
      expiresAt: env.now() + 86_400_000,
      problem: null,
    });
  });

  it("closes its listener on dispose, and takes no URL after", async () => {
    const env = setup();
    await env.keeper.open();
    env.keeper.dispose();
    expect(env.listener.closed).toBe(1);
    await expect(env.arm()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
