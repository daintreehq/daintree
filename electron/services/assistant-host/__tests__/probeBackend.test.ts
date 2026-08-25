import { describe, it, expect, vi } from "vitest";

import { probeAssistantBackend } from "../probeBackend.js";

/**
 * Telling a backend from a website.
 *
 * `staging.daintree.org` is Daintree's marketing and account site, and the Staging
 * environment was pointed at it. A website ANSWERS — 200, HTML, cheerfully — so the
 * failure never presented as "wrong host"; it presented as a JSON parse error deep
 * inside the engine, which reads as a broken assistant rather than a misaddressed one.
 * Most cases below are a way of answering without being a backend.
 *
 * Real `Response` objects, not hand-rolled shapes: `ok`, `status` and the body stream
 * all have behaviour the checks depend on, and a fake that gets `ok: true` for a 302
 * would let the redirect case pass for the wrong reason.
 */

const REAL = JSON.stringify({ server_version: "1.4.2", build_sha: "abc123" });

/** Captures the request so the options that matter can be asserted, not assumed. */
function fetcher(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("probeAssistantBackend", () => {
  it("reads the version off a real backend", async () => {
    const result = await probeAssistantBackend("https://assistant.example", {
      fetchImpl: fetcher(json(REAL)).impl,
    });
    expect(result).toMatchObject({
      reachable: true,
      version: { serverVersion: "1.4.2", buildSha: "abc123" },
    });
  });

  it("asks for /version, without following redirects", async () => {
    // The option is the mechanism: without `manual`, undici follows the redirect and
    // reports on whatever answered at the end of the chain as though it were the
    // backend. Asserted directly, because a fake response cannot exercise it.
    const { impl, calls } = fetcher(json(REAL));
    await probeAssistantBackend("https://assistant.example", { fetchImpl: impl });

    expect(calls[0]!.url).toBe("https://assistant.example/version");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("keeps a path prefix the origin already has", async () => {
    // `resolveBackendUrl` permits a path-prefixed backend, and the engine appends to it.
    // Probing the bare `/version` would report on a different endpoint than the one
    // turns use, and then disagree with the engine about whether it works.
    const { impl, calls } = fetcher(json(REAL));
    await probeAssistantBackend("http://127.0.0.1:8473/api", { fetchImpl: impl });

    expect(calls[0]!.url).toBe("http://127.0.0.1:8473/api/version");
  });

  it("never sends credentials, even when the origin carries them", async () => {
    // A loopback override may legitimately carry userinfo. Undici REJECTS a URL that
    // does, and puts the whole thing — password included — in the error it throws, which
    // this result would then render and invite the user to paste into an issue.
    const { impl, calls } = fetcher(json(REAL));
    await probeAssistantBackend("http://user:sekret@127.0.0.1:8473", { fetchImpl: impl });

    expect(calls[0]!.url).not.toContain("sekret");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8473/version");
  });

  it("refuses a redirect instead of following it", async () => {
    const result = await probeAssistantBackend("https://website.example", {
      fetchImpl: fetcher(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } })
      ).impl,
    });
    expect(result).toMatchObject({ reachable: false, code: "redirected" });
    expect(result.reachable === false && result.detail).toContain("elsewhere.example");
  });

  it("reports only the redirect's origin, not its query", async () => {
    // A login redirect's query carries authorization codes and state, and this string is
    // rendered in Settings and copied into bug reports.
    const result = await probeAssistantBackend("https://website.example", {
      fetchImpl: fetcher(
        new Response(null, {
          status: 302,
          headers: { location: "https://sso.example/authorize?code=SECRET&state=ALSO_SECRET" },
        })
      ).impl,
    });
    expect(result.reachable).toBe(false);
    if (result.reachable) return;
    expect(result.detail).toContain("https://sso.example");
    expect(result.detail).not.toContain("SECRET");
  });

  it("refuses HTML, which is what a website origin actually returns", async () => {
    const result = await probeAssistantBackend("https://staging.example", {
      fetchImpl: fetcher(
        new Response("<!doctype html><html><body>Daintree</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      ).impl,
    });
    expect(result).toMatchObject({ reachable: false, code: "not-a-backend" });
    expect(result.reachable === false && result.detail).toContain("text/html");
  });

  it("refuses HTML that claims to be JSON", async () => {
    // A server mislabelling its content type is exactly as wrong as one that does not,
    // so the parse is checked as well as the header.
    const result = await probeAssistantBackend("https://website.example", {
      fetchImpl: fetcher(json("<!doctype html>")).impl,
    });
    expect(result).toMatchObject({ reachable: false, code: "not-a-backend" });
  });

  it("accepts a +json media type, and is not fooled by a lookalike", async () => {
    const ok = await probeAssistantBackend("https://assistant.example", {
      fetchImpl: fetcher(
        new Response(REAL, { headers: { "content-type": "application/vnd.daintree+json" } })
      ).impl,
    });
    expect(ok.reachable).toBe(true);

    // Substring matching would have taken this for JSON.
    const notOk = await probeAssistantBackend("https://website.example", {
      fetchImpl: fetcher(new Response(REAL, { headers: { "content-type": "text/html-jsonish" } }))
        .impl,
    });
    expect(notOk).toMatchObject({ reachable: false, code: "not-a-backend" });
  });

  it("refuses well-formed JSON that is not this backend", async () => {
    // A JSON 404 page is still not a backend. The field it must carry is the test.
    const result = await probeAssistantBackend("https://cdn.example", {
      fetchImpl: fetcher(json(JSON.stringify({ error: "not found" }))).impl,
    });
    expect(result).toMatchObject({ reachable: false, code: "not-a-backend" });
  });

  it("separates a backend that said no from something that is not one", async () => {
    // Both are failures; only one means "you are pointed at the wrong host". And the
    // backend's own error body is not quoted — a status is the whole useful answer.
    const result = await probeAssistantBackend("https://assistant.example", {
      fetchImpl: fetcher(json(JSON.stringify({ error: "internal detail" }), 503)).impl,
    });
    expect(result).toMatchObject({ reachable: false, code: "http-error" });
    expect(result.reachable === false && result.detail).not.toContain("internal detail");
  });

  it("reports a connection that never completed as unreachable", async () => {
    const result = await probeAssistantBackend("https://nowhere.example", {
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ reachable: false, code: "unreachable" });
  });

  it("gives up on a body that never arrives, rather than hanging", async () => {
    // Headers can arrive and the body stall indefinitely. The obvious shape — clear the
    // deadline once headers land — leaves this probe open forever.
    //
    // The fake honours the abort signal because undici does: aborting after headers
    // errors the body stream, which is precisely the mechanism under test. A fake that
    // ignored it would model a runtime that does not exist and prove nothing.
    const stalling = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("The operation was aborted"))
            );
            // Otherwise: never enqueues, never closes.
          },
        }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const result = await probeAssistantBackend("https://slow.example", {
      fetchImpl: stalling,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ reachable: false, code: "unreachable" });
  }, 10_000);

  it("bounds a body rather than buffering whatever is sent", async () => {
    const result = await probeAssistantBackend("https://website.example", {
      fetchImpl: fetcher(
        new Response("x".repeat(500_000), { headers: { "content-type": "text/html" } })
      ).impl,
    });
    expect(result.reachable).toBe(false);
    if (result.reachable) return;
    // Evidence, not content: bounded on the way out as well as on the way in.
    expect(result.detail.length).toBeLessThan(400);
  });

  it("bounds a version string an unfriendly server might inflate", async () => {
    const result = await probeAssistantBackend("https://assistant.example", {
      fetchImpl: fetcher(json(JSON.stringify({ server_version: "v".repeat(5_000) }))).impl,
    });
    expect(result.reachable).toBe(true);
    if (!result.reachable) return;
    expect(result.version.serverVersion.length).toBeLessThan(200);
  });
});
