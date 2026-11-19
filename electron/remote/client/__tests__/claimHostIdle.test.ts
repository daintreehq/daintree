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

let dir: string;
const sessions: LinkSession[] = [];

async function link() {
  const pair = await openSessionPair(dir);
  sessions.push(pair.host, pair.client);
  return pair;
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
    await expect(withHostIdleClaim(client, () => client, act)).resolves.toEqual({
      kind: "claimed",
      result: "stopped",
    });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a refusal", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: false }));
    const act = vi.fn();
    await expect(withHostIdleClaim(client, () => client, act)).resolves.toEqual({
      kind: "refused",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("takes a host from before the claim as no claim", async () => {
    const { client } = await link();
    const act = vi.fn();
    await expect(withHostIdleClaim(client, () => client, act)).resolves.toEqual({
      kind: "unsupported",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("never acts on a grant once the host's link is another, the old one still open", async () => {
    const { host, client } = await link();
    let answer: ((value: { granted: boolean }) => void) | null = null;
    host.registerCallHandler(
      LinkMethod.CLAIM_IDLE,
      EmptyPayloadSchema,
      () => new Promise((resolve) => (answer = resolve))
    );
    const replacement = (await link()).client;
    let current: LinkSession = client;
    const act = vi.fn();
    const outcome = withHostIdleClaim(client, () => current, act);
    await waitFor(() => answer !== null);
    current = replacement;
    answer!({ granted: true });
    await expect(outcome).resolves.toEqual({ kind: "superseded" });
    expect(client.isOpen).toBe(true);
    expect(act).not.toHaveBeenCalled();
  });

  it("asks nothing over a link that is closed or no longer the host's", async () => {
    const { host, client } = await link();
    const handler = vi.fn(() => ({ granted: true }));
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, handler);
    const other = (await link()).client;
    const act = vi.fn();
    await expect(withHostIdleClaim(client, () => other, act)).resolves.toEqual({
      kind: "superseded",
    });
    client.close("dropped");
    await expect(withHostIdleClaim(client, () => client, act)).resolves.toEqual({
      kind: "superseded",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("throws, without acting, for an answer it can't read or one lost with the link", async () => {
    const { host, client } = await link();
    host.registerCallHandler(LinkMethod.CLAIM_IDLE, EmptyPayloadSchema, () => ({ granted: "yes" }));
    const act = vi.fn();
    await expect(withHostIdleClaim(client, () => client, act)).rejects.toThrow();

    const dropping = await link();
    dropping.host.registerCallHandler(
      LinkMethod.CLAIM_IDLE,
      EmptyPayloadSchema,
      () => new Promise(() => {})
    );
    const outcome = withHostIdleClaim(dropping.client, () => dropping.client, act);
    dropping.client.close("dropped");
    await expect(outcome).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(act).not.toHaveBeenCalled();
  });
});
