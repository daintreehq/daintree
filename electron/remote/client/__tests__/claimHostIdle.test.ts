// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyPayloadSchema, LinkMethod } from "../../host/linkMethods.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import type { LinkSession } from "../../link/session.js";
import { withHostIdleClaim } from "../claimHostIdle.js";

const HOST = "host-1";

let dir: string;
const sessions: LinkSession[] = [];

async function link() {
  const pair = await openSessionPair(dir);
  sessions.push(pair.host, pair.client);
  return pair;
}

/** A host handler whose answer the test gives once it has been asked. */
function heldAnswer(host: LinkSession) {
  let answer: ((value: unknown) => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  host.registerCallHandler(
    LinkMethod.CLAIM_IDLE,
    EmptyPayloadSchema,
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      })
  );
  return {
    asked: () => waitFor(() => answer !== null),
    answer: (value: unknown) => answer!(value),
    fail: (error: unknown) => fail!(error),
  };
}

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close("test over");
  await removeTempDir(dir);
});

describe("withHostIdleClaim (#17922)", () => {
  it("acts at once on a grant, on the link that asked", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: true }));
    const act = vi.fn(() => "stopped");
    await expect(withHostIdleClaim(HOST, client, () => client, act)).resolves.toEqual({
      kind: "claimed",
      result: "stopped",
    });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("starts the action before anything else can run, and hands back how it ended", async () => {
    const { host, client } = await link();
    const held = heldAnswer(host);
    let current: LinkSession | null = client;
    let looks = 0;
    // The link is replaced in the first turn after the last look: the action must already be going.
    const sessionFor = () => {
      looks += 1;
      if (looks === 2) queueMicrotask(() => (current = null));
      return current;
    };
    let startedWhileCurrent: boolean | null = null;
    const outcome = withHostIdleClaim(HOST, client, sessionFor, async () => {
      startedWhileCurrent = current === client;
      throw new Error("the provider refused the stop");
    });
    await held.asked();
    held.answer({ granted: true });
    await expect(outcome).rejects.toThrow("the provider refused the stop");
    expect(looks).toBe(2);
    expect(startedWhileCurrent).toBe(true);
  });

  it("does nothing on a refusal", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: false }));
    const act = vi.fn();
    await expect(withHostIdleClaim(HOST, client, () => client, act)).resolves.toEqual({
      kind: "refused",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("takes a host from before the claim as no claim", async () => {
    const { client } = await link();
    const act = vi.fn();
    await expect(withHostIdleClaim(HOST, client, () => client, act)).resolves.toEqual({
      kind: "unsupported",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it.each([
    ["a grant", (held: ReturnType<typeof heldAnswer>) => held.answer({ granted: true })],
    ["a refusal", (held: ReturnType<typeof heldAnswer>) => held.answer({ granted: false })],
    [
      "an older host's answer",
      (held: ReturnType<typeof heldAnswer>) =>
        held.fail(Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" })),
    ],
  ])(
    "says only that the link was replaced for %s arriving after it, the old one still open",
    async (_name, settle) => {
      const { host, client } = await link();
      const held = heldAnswer(host);
      const replacement = (await link()).client;
      let current: LinkSession = client;
      const act = vi.fn();
      const outcome = withHostIdleClaim(HOST, client, () => current, act);
      await held.asked();
      current = replacement;
      settle(held);
      await expect(outcome).resolves.toEqual({ kind: "superseded" });
      expect(client.isOpen).toBe(true);
      expect(act).not.toHaveBeenCalled();
    }
  );

  it("asks nothing over a link that is closed or no longer the host's", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: true }));
    const call = vi.spyOn(client, "call");
    const other = (await link()).client;
    const act = vi.fn();
    await expect(withHostIdleClaim(HOST, client, () => other, act)).resolves.toEqual({
      kind: "superseded",
    });
    client.close("dropped");
    await expect(withHostIdleClaim(HOST, client, () => client, act)).resolves.toEqual({
      kind: "superseded",
    });
    expect(call).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("throws, without acting, for an answer it can't read or one lost with the link", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: "yes" }));
    const act = vi.fn();
    await expect(withHostIdleClaim(HOST, client, () => client, act)).rejects.toMatchObject({
      name: "ZodError",
    });

    const dropping = await link();
    const held = heldAnswer(dropping.host);
    const outcome = withHostIdleClaim(HOST, dropping.client, () => dropping.client, act);
    await held.asked();
    dropping.client.close("dropped");
    await expect(outcome).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(act).not.toHaveBeenCalled();
  });
});
