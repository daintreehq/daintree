import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DNS resolver so the rebinding tests are deterministic and offline.
// The module under test calls `dns.lookup(host, { all: true })` via the default
// import, so the mock's default must expose `lookup`.
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn();
  return { default: { lookup }, lookup };
});

import dns from "node:dns/promises";
import {
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  MAX_DNTR_BYTES,
  acceptedMime,
  dntrSuffixOk,
  fetchWithPrivateHostGuard,
} from "../pluginDownloadPolicy.js";

const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

/** Minimal Response stand-in covering the fields the guard reads. */
function resp(status: number, location?: string): Response {
  return {
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === "location" ? (location ?? null) : null),
    },
    body: { cancel: async () => {} },
  } as unknown as Response;
}

/** Make `dns.lookup` resolve every hostname to the given addresses. */
function resolveAllTo(...addresses: string[]) {
  mockLookup.mockImplementation(async () => addresses.map((address) => ({ address, family: 4 })));
}

describe("pluginDownloadPolicy", () => {
  it("shares one 30s timeout across both download paths", () => {
    expect(PLUGIN_DOWNLOAD_TIMEOUT_MS).toBe(30_000);
  });

  it("re-exports the archive size cap", () => {
    expect(MAX_DNTR_BYTES).toBe(30 * 1024 * 1024);
  });

  it.each([
    "application/zip",
    "application/zip; charset=utf-8",
    "APPLICATION/ZIP",
    "application/x-dntr",
    "application/octet-stream",
    "application/x-zip",
    "  application/zip  ",
  ])("accepts the union archive MIME %s", (type) => {
    expect(acceptedMime(type)).toBe(true);
  });

  it.each(["", "text/html", "application/zipper", "application/x-dntrx", "image/png"])(
    "rejects the non-archive MIME %s",
    (type) => {
      expect(acceptedMime(type)).toBe(false);
    }
  );

  it.each(["/p.dntr", "/path/to/PLUGIN.DNTR", "/a.b.dntr"])(
    "accepts the .dntr suffix %s",
    (pathname) => {
      expect(dntrSuffixOk(pathname)).toBe(true);
    }
  );

  it.each(["/p.zip", "/dntr", "/p.dntr.zip", "/"])(
    "rejects the non-.dntr suffix %s",
    (pathname) => {
      expect(dntrSuffixOk(pathname)).toBe(false);
    }
  );
});

describe("fetchWithPrivateHostGuard — DNS-rebinding guard", () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it("rejects a public hostname that resolves to IPv4 loopback before fetching", async () => {
    resolveAllTo("127.0.0.1");
    const netFetch = vi.fn(async () => resp(200));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://rebind.example.com/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-host" });
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("rejects a hostname resolving to a cloud-metadata link-local address", async () => {
    resolveAllTo("169.254.169.254");
    const netFetch = vi.fn(async () => resp(200));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://metadata.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-host" });
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("rejects when ANY of multiple resolved addresses is private (split-horizon)", async () => {
    // A public answer paired with a private one must not slip through.
    resolveAllTo("93.184.216.34", "10.0.0.5");
    const netFetch = vi.fn(async () => resp(200));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://split.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-host" });
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("rejects an IPv6 loopback resolution", async () => {
    resolveAllTo("::1");
    const netFetch = vi.fn(async () => resp(200));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://v6.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-host" });
  });

  it("allows a hostname that resolves to a public address", async () => {
    resolveAllTo("93.184.216.34");
    const ok = resp(200);
    const netFetch = vi.fn(async () => ok);

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://example.com/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: true, response: ok });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("catches a redirect hop whose hostname resolves to a private address", async () => {
    // First host is public; it 302s to a second host that resolves to RFC1918.
    mockLookup.mockImplementation(async (host: string) =>
      host === "first.example"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.1.2.3", family: 4 }]
    );
    const netFetch = vi.fn(async () => resp(302, "https://second.example/p.dntr"));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://first.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-host" });
    // Only the first hop was fetched; the rebinding second hop was blocked at
    // the DNS pre-check before its fetch.
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a private literal host with private-redirect (not private-host)", async () => {
    // The Location host is a private IP literal — caught by the literal-host
    // guard, a distinct branch from the DNS-rebinding one.
    resolveAllTo("93.184.216.34");
    const netFetch = vi.fn(async () => resp(302, "https://192.168.1.1/p.dntr"));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://first.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "private-redirect" });
    // Only the first (public) hop was fetched; the private Location is never dialed.
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an https→http downgrade redirect with insecure-protocol", async () => {
    resolveAllTo("93.184.216.34");
    // A redirect to a PUBLIC http host (not private) — the integrity downgrade,
    // not an SSRF — must still be refused.
    const netFetch = vi.fn(async () => resp(302, "http://cdn.example.com/p.dntr"));

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://cdn.example.com/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: false, reason: "insecure-protocol" });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("allows a chain at the redirect cap but rejects one hop beyond it", async () => {
    resolveAllTo("93.184.216.34");

    // Exactly MAX_REDIRECT_HOPS (5) redirects then a 200 → allowed.
    let n = 0;
    const atCap = vi.fn(async () =>
      n++ < 5 ? resp(302, `https://hop${n}.example/p.dntr`) : resp(200)
    );
    const okResult = await fetchWithPrivateHostGuard(
      atCap as never,
      "https://start.example/p.dntr",
      {}
    );
    expect(okResult).toEqual({ ok: true, response: expect.objectContaining({ status: 200 }) });

    // One redirect past the cap → too-many-redirects.
    const overCap = vi.fn(async () => resp(302, "https://loop.example/p.dntr"));
    const overResult = await fetchWithPrivateHostGuard(
      overCap as never,
      "https://start.example/p.dntr",
      {}
    );
    expect(overResult).toEqual({ ok: false, reason: "too-many-redirects" });
  });

  it("treats DNS resolution failure as non-private and lets the fetch proceed", async () => {
    mockLookup.mockImplementation(async () => {
      throw new Error("ENOTFOUND");
    });
    const ok = resp(200);
    const netFetch = vi.fn(async () => ok);

    const result = await fetchWithPrivateHostGuard(
      netFetch as never,
      "https://unresolvable.example/p.dntr",
      {}
    );

    expect(result).toEqual({ ok: true, response: ok });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });
});
