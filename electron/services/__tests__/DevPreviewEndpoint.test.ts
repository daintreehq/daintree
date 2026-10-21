import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_PREVIEW_PUBLIC_ADDRESS_CODE,
  createPrivateNetworkLookup,
  isPrivateNetworkAddress,
  parsePreviewEndpoint,
} from "../DevPreviewEndpoint.js";

function stubLookup(addresses: LookupAddress[]): void {
  vi.spyOn(dns, "lookup").mockImplementation(((
    _host: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
  ) => callback(null, addresses)) as unknown as typeof dns.lookup);
}

function lookup(
  options: dns.LookupOptions
): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    createPrivateNetworkLookup()("box.example.ts.net", options, (err, address, family) =>
      resolve({ err, address, family })
    );
  });
}

describe("isPrivateNetworkAddress", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "100.64.0.1",
    "100.101.102.103",
    "::1",
    "[::1]",
    "fd7a:115c:a1e0::1",
    "::ffff:192.168.1.20",
  ])("accepts %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "::",
    "fe80::1%en0",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(false);
  });
});

describe("parsePreviewEndpoint", () => {
  it("reads host, port and scheme, defaulting the port per scheme", () => {
    expect(parsePreviewEndpoint("http://box.example.ts.net:5173/app")).toEqual({
      ok: true,
      endpoint: { host: "box.example.ts.net", port: 5173, isHttps: false },
    });
    expect(parsePreviewEndpoint(" https://Box.Example.ts.net./ ")).toEqual({
      ok: true,
      endpoint: { host: "box.example.ts.net", port: 443, isHttps: true },
    });
    expect(parsePreviewEndpoint("http://[fd7a:115c:a1e0::1]:3000")).toEqual({
      ok: true,
      endpoint: { host: "fd7a:115c:a1e0::1", port: 3000, isHttps: false },
    });
  });

  it("canonicalises numeric IPv4 spellings before checking them", () => {
    // 0x7f000001 and 2130706433 are both 127.0.0.1.
    expect(parsePreviewEndpoint("http://0x7f000001:3000")).toMatchObject({
      ok: true,
      endpoint: { host: "127.0.0.1" },
    });
    expect(parsePreviewEndpoint("http://134744072:3000").ok).toBe(false); // 8.8.8.8
  });

  it("refuses public literals, credentials, other schemes and garbage", () => {
    expect(parsePreviewEndpoint("http://8.8.8.8:3000").ok).toBe(false);
    expect(parsePreviewEndpoint("http://169.254.169.254/latest").ok).toBe(false);
    expect(parsePreviewEndpoint("http://user:pass@10.0.0.2:3000").ok).toBe(false);
    expect(parsePreviewEndpoint("ftp://10.0.0.2").ok).toBe(false);
    expect(parsePreviewEndpoint("ws://10.0.0.2:3000").ok).toBe(false);
    expect(parsePreviewEndpoint("not a url").ok).toBe(false);
  });
});

describe("createPrivateNetworkLookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops public answers and hands back the private ones (all: true)", async () => {
    stubLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "100.101.102.103", family: 4 },
    ]);
    const result = await lookup({ all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([{ address: "100.101.102.103", family: 4 }]);
  });

  it("answers the single-address form with the first private address", async () => {
    stubLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "fd7a:115c:a1e0::1", family: 6 },
    ]);
    const result = await lookup({});
    expect(result.err).toBeNull();
    expect(result.address).toBe("fd7a:115c:a1e0::1");
    expect(result.family).toBe(6);
  });

  it("fails a name that rebinds to only public addresses", async () => {
    stubLookup([{ address: "93.184.216.34", family: 4 }]);
    const result = await lookup({ all: true });
    expect(result.err?.code).toBe(DEV_PREVIEW_PUBLIC_ADDRESS_CODE);
  });

  it("answers a bracketed IPv6 literal itself instead of asking DNS for it", async () => {
    const spy = vi.spyOn(dns, "lookup");
    const allowed = await new Promise<{ err: unknown; address: unknown }>((resolve) =>
      createPrivateNetworkLookup()("[fd7a:115c:a1e0::1]", { all: true }, (err, address) =>
        resolve({ err, address })
      )
    );
    expect(allowed.err).toBeNull();
    expect(allowed.address).toEqual([{ address: "fd7a:115c:a1e0::1", family: 6 }]);

    const refused = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      createPrivateNetworkLookup()("[2606:4700:4700::1111]", {}, (err) => resolve(err))
    );
    expect(refused?.code).toBe(DEV_PREVIEW_PUBLIC_ADDRESS_CODE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes a resolver error through", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null) => void
    ) => {
      const err: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND");
      err.code = "ENOTFOUND";
      callback(err);
    }) as unknown as typeof dns.lookup);
    const result = await lookup({});
    expect(result.err?.code).toBe("ENOTFOUND");
  });
});
