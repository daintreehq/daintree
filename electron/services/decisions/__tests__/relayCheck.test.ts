import { describe, expect, it, vi } from "vitest";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@daintreehq/decisions-protocol";
import {
  DAINTREE_RELAY_VERSIONS,
  RelayCheckCancelledError,
  checkDecisionsRelay,
  relayOriginFromInput,
  type RelayFetch,
} from "../relayCheck.js";

const DAINTREE_RELAY_VERSION = DAINTREE_RELAY_VERSIONS.workerVersion;

const ORIGIN = "https://decisions.example.workers.dev";

function info(overrides: Record<string, unknown> = {}) {
  return {
    name: "daintree-decisions",
    protocol_min: MIN_PROTOCOL_VERSION,
    protocol_max: PROTOCOL_VERSION,
    worker_version: DAINTREE_RELAY_VERSION,
    claimed: false,
    claim_configured: true,
    voice: { xai: false, anthropic: false, openai: false },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A relay answering by path; anything unlisted is a 404. */
function relay(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn<RelayFetch>(async (url, init) => {
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return { fetchImpl, calls };
}

function healthyRelay(infoBody: unknown = info()) {
  return relay({
    "/health": () => json({ ok: true, version: DAINTREE_RELAY_VERSION }),
    "/api/v1/info": () => json(infoBody),
  });
}

function failingWith(error: Error) {
  return vi.fn<RelayFetch>(async () => {
    throw error;
  });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("relayOriginFromInput", () => {
  it.each([
    ["decisions.example.workers.dev", ORIGIN],
    ["  https://decisions.example.workers.dev/  ", ORIGIN],
    ["https://decisions.example.workers.dev/pair?ticket=secret#frag", ORIGIN],
    ["HTTPS://Decisions.Example.Workers.Dev", ORIGIN],
    ["https://decisions.example.workers.dev:8443/x", "https://decisions.example.workers.dev:8443"],
    ["localhost:8787", "https://localhost:8787"],
  ])("reads %j as the origin %s", (input, origin) => {
    expect(relayOriginFromInput(input)).toEqual({ origin });
  });

  it.each([
    ["", "unparsable"],
    ["   ", "unparsable"],
    ["https://", "unparsable"],
    ["https://exa mple.com", "unparsable"],
    ["https://evil.example\\@decisions.example.workers.dev", "unparsable"],
    ["https://decisions.example.workers.dev\u0000", "unparsable"],
    ["http://decisions.example.workers.dev", "not-https"],
    ["http://localhost:8787", "not-https"],
    ["http://127.0.0.1:8787", "not-https"],
    ["ftp://decisions.example.workers.dev", "not-https"],
    ["wss://decisions.example.workers.dev", "not-https"],
    ["https://user:hunter2@decisions.example.workers.dev", "credentials"],
    ["https://decisions.example.workers.dev@other.example", "credentials"],
    ["decisions.example.workers.dev:@other.example", "credentials"],
  ])("refuses %j as %s", (input, reason) => {
    expect(relayOriginFromInput(input)).toEqual({ result: "invalid-url", reason });
  });
});

describe("checkDecisionsRelay", () => {
  it("sends nothing for an address it can't use", async () => {
    const { fetchImpl } = healthyRelay();

    await expect(
      checkDecisionsRelay("http://decisions.example.workers.dev", { fetchImpl })
    ).resolves.toEqual({ result: "invalid-url", reason: "not-https" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks only the origin, without cookies or redirects, and never echoes the typed path", async () => {
    const { fetchImpl, calls } = healthyRelay();

    const result = await checkDecisionsRelay(
      "https://decisions.example.workers.dev/pair?ticket=s3cret-token",
      { fetchImpl }
    );

    expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/health`, `${ORIGIN}/api/v1/info`]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(result)).not.toContain("s3cret-token");
    expect(result).toMatchObject({ result: "unclaimed", origin: ORIGIN });
  });

  it.each([
    ["claimed", info({ claimed: true }), "claimed"],
    [
      "claimed, whatever its claim secret",
      info({ claimed: true, claim_configured: false }),
      "claimed",
    ],
    ["unclaimed with a claim secret set", info(), "unclaimed"],
    ["unclaimed with no claim secret", info({ claim_configured: false }), "claim-not-configured"],
  ])("reports a relay %s", async (_label, body, result) => {
    const { fetchImpl } = healthyRelay(body);

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toMatchObject({
      result,
      origin: ORIGIN,
      compatibility: { diverges: false },
    });
  });

  it("reports a protocol range that doesn't overlap Daintree's, with both ranges, before the claim", async () => {
    const above = PROTOCOL_VERSION + 1;
    const { fetchImpl } = healthyRelay(
      info({ protocol_min: above, protocol_max: above + 1, claimed: true, worker_version: "9.0.0" })
    );

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "incompatible",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: above, protocolMax: above + 1, workerVersion: "9.0.0" },
        daintree: {
          protocolMin: MIN_PROTOCOL_VERSION,
          protocolMax: PROTOCOL_VERSION,
          workerVersion: DAINTREE_RELAY_VERSION,
        },
        diverges: true,
      },
    });
  });

  it("counts any overlap as compatible, and any difference as diverging", async () => {
    const wider = healthyRelay(info({ protocol_max: PROTOCOL_VERSION + 1, claimed: true }));
    await expect(
      checkDecisionsRelay(ORIGIN, { fetchImpl: wider.fetchImpl })
    ).resolves.toMatchObject({ result: "claimed", compatibility: { diverges: true } });

    const newerWorker = healthyRelay(info({ worker_version: "0.2.0", claimed: true }));
    await expect(
      checkDecisionsRelay(ORIGIN, { fetchImpl: newerWorker.fetchImpl })
    ).resolves.toMatchObject({
      result: "claimed",
      compatibility: { relay: { workerVersion: "0.2.0" }, diverges: true },
    });
  });

  it.each([
    ["a DNS failure", new Error("net::ERR_NAME_NOT_RESOLVED"), "dns"],
    ["a refused connection", new Error("net::ERR_CONNECTION_REFUSED"), "refused"],
    ["a bad certificate", new Error("net::ERR_CERT_AUTHORITY_INVALID"), "certificate"],
    ["an expired certificate", new Error("net::ERR_CERT_DATE_INVALID"), "certificate"],
    [
      "a timeout",
      namedError("TimeoutError", "The operation was aborted due to timeout"),
      "timeout",
    ],
    ["anything else", new Error("net::ERR_INTERNET_DISCONNECTED"), "network"],
  ])("reports %s as unreachable, without its message", async (_label, error, reason) => {
    error.message += ` at ${ORIGIN}/health?token=leak`;

    const result = await checkDecisionsRelay(ORIGIN, { fetchImpl: failingWith(error) });

    expect(result).toEqual({ result: "unreachable", origin: ORIGIN, endpoint: "health", reason });
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("times a request out on its own deadline", async () => {
    const fetchImpl = vi.fn<RelayFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl, timeoutMs: 10 })).resolves.toEqual({
      result: "unreachable",
      origin: ORIGIN,
      endpoint: "health",
      reason: "timeout",
    });
  });

  it("reports a redirect as not a relay, without following it", async () => {
    const fetchImpl = failingWith(
      new Error("Attempted to redirect, but redirect policy was 'error'")
    );

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "health",
      answered: "redirect",
      status: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [500, "http-error"],
    [503, "http-error"],
    [429, "http-error"],
  ])("reports a %i from /health as a relay error", async (status, result) => {
    const { fetchImpl } = relay({ "/health": () => json({ code: "internal_error" }, status) });

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result,
      origin: ORIGIN,
      endpoint: "health",
      status,
    });
  });

  it.each([404, 403, 405])("reports a %i from /health as not a relay", async (status) => {
    const { fetchImpl } = relay({ "/health": () => new Response("nope", { status }) });

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "health",
      answered: "status",
      status,
    });
  });

  it("reports a site whose /health is something else, without asking /info", async () => {
    for (const health of [
      () => new Response("<html>hello</html>", { status: 200 }),
      () => json({ ok: false }),
      () => json({ status: "ok" }),
      () => json(null),
    ]) {
      const { fetchImpl, calls } = relay({ "/health": health, "/api/v1/info": () => json(info()) });

      await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
        result: "not-a-relay",
        origin: ORIGIN,
        endpoint: "health",
        answered: "body",
        status: null,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it.each([
    ["another service's name", info({ name: "something-else" })],
    ["a missing claim flag", { ...info(), claimed: undefined }],
    ["a non-integer protocol", info({ protocol_min: 1.5 })],
    ["an inverted range", info({ protocol_min: 3, protocol_max: 2 })],
    ["a protocol below 1", info({ protocol_min: 0 })],
    ["an unreadable worker version", info({ worker_version: "<script>" })],
    ["an overlong worker version", info({ worker_version: "1".repeat(65) })],
  ])("reports /info with %s as not a relay", async (_label, body) => {
    const { fetchImpl } = healthyRelay(body);

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "info",
      answered: "body",
      status: null,
    });
  });

  it("reports /info missing behind a working /health as not a relay", async () => {
    const { fetchImpl } = relay({ "/health": () => json({ ok: true }) });

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "info",
      answered: "status",
      status: 404,
    });
  });

  it("names /info when that read is the one that fails", async () => {
    const failing = relay({
      "/health": () => json({ ok: true }),
      "/api/v1/info": () => json({ code: "internal_error" }, 500),
    });
    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl: failing.fetchImpl })).resolves.toEqual({
      result: "http-error",
      origin: ORIGIN,
      endpoint: "info",
      status: 500,
    });

    let call = 0;
    const dropped = vi.fn<RelayFetch>(async () => {
      call += 1;
      if (call === 1) return json({ ok: true });
      throw new Error("net::ERR_CONNECTION_RESET");
    });
    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl: dropped })).resolves.toEqual({
      result: "unreachable",
      origin: ORIGIN,
      endpoint: "info",
      reason: "network",
    });
  });

  it("stops reading a body far bigger than a relay's", async () => {
    const { fetchImpl } = relay({
      "/health": () => new Response(`{"ok":true,"pad":"${"x".repeat(70 * 1024)}"}`),
    });

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toEqual({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "health",
      answered: "body",
      status: null,
    });
  });

  it("refuses a body declared far bigger than a relay's without reading it", async () => {
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { fetchImpl } = relay({
      "/health": () =>
        new Response(body, { headers: { "content-length": String(10 * 1024 * 1024) } }),
    });

    await expect(checkDecisionsRelay(ORIGIN, { fetchImpl })).resolves.toMatchObject({
      result: "not-a-relay",
      endpoint: "health",
      answered: "body",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("ends with a cancellation, not an observation, when its signal aborts mid-request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<RelayFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort();
        })
    );

    await expect(
      checkDecisionsRelay(ORIGIN, { fetchImpl, signal: controller.signal })
    ).rejects.toBeInstanceOf(RelayCheckCancelledError);
  });

  it("sends nothing once its signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = healthyRelay();

    await expect(
      checkDecisionsRelay(ORIGIN, { fetchImpl, signal: controller.signal })
    ).rejects.toBeInstanceOf(RelayCheckCancelledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("expects the relay release its installed libraries came with", () => {
    expect(DAINTREE_RELAY_VERSIONS).toEqual({
      protocolMin: MIN_PROTOCOL_VERSION,
      protocolMax: PROTOCOL_VERSION,
      workerVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });
});
