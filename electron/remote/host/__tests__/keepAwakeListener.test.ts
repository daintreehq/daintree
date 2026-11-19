// @vitest-environment node
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KEEP_AWAKE_PATH } from "../../cloud/agent37/agent37KeepAwake.js";
import type { KeepAwakeListener } from "../KeepAwakeKeeper.js";
import { openKeepAwakeListener } from "../keepAwakeListener.js";

const open: KeepAwakeListener[] = [];
afterEach(() => {
  for (const listener of open.splice(0)) listener.close();
});

const nonce = () => crypto.randomBytes(16).toString("hex");

async function get(listener: KeepAwakeListener, path: string, method = "GET"): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${listener.port}${path}`, { method });
  await response.arrayBuffer();
  return response.status;
}

describe("openKeepAwakeListener (#17918)", () => {
  it("answers only the nonce it expects, once, and records that it arrived", async () => {
    const listener = await openKeepAwakeListener();
    open.push(listener);
    expect(listener.port).toBeGreaterThan(0);

    const first = nonce();
    listener.expect(first);
    expect(await get(listener, `${KEEP_AWAKE_PATH}${first}?a=1`)).toBe(204);
    expect(listener.take(first)).toBe(true);
    // Used once: the same nonce again finds nothing.
    expect(await get(listener, `${KEEP_AWAKE_PATH}${first}`)).toBe(404);
    expect(listener.take(first)).toBe(false);
  });

  it("answers several outstanding nonces, each once, whichever arrives first", async () => {
    const listener = await openKeepAwakeListener();
    open.push(listener);
    const [a, b] = [nonce(), nonce()];
    listener.expect(a);
    listener.expect(b);
    expect(await get(listener, `${KEEP_AWAKE_PATH}${b}`)).toBe(204);
    // A replay before the keeper looked finds nothing more.
    expect(await get(listener, `${KEEP_AWAKE_PATH}${b}`)).toBe(404);
    expect(await get(listener, `${KEEP_AWAKE_PATH}${a}`)).toBe(204);
    expect(listener.take(a)).toBe(true);
    expect(listener.take(b)).toBe(true);
    expect(listener.take(b)).toBe(false);
  });

  it("answers 404 to anything else, and records nothing", async () => {
    const listener = await openKeepAwakeListener();
    open.push(listener);
    const expected = nonce();
    listener.expect(expected);
    expect(await get(listener, "/")).toBe(404);
    expect(await get(listener, `${KEEP_AWAKE_PATH}${nonce()}`)).toBe(404);
    expect(await get(listener, `${KEEP_AWAKE_PATH}${expected}`, "POST")).toBe(404);
    expect(listener.take(expected)).toBe(false);
    // A nonce of the wrong shape is never answered, even when told to expect it.
    listener.expect("not-a-nonce");
    expect(await get(listener, `${KEEP_AWAKE_PATH}not-a-nonce`)).toBe(404);
    expect(listener.take("not-a-nonce")).toBe(false);
  });

  it("stops answering once closed", async () => {
    const listener = await openKeepAwakeListener();
    listener.close();
    await expect(get(listener, "/")).rejects.toThrow();
  });
});
