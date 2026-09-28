import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDaintreeFileUrl,
  buildDaintreeMediaUrl,
  buildDaintreePdfUrl,
  primeHostPreviewCapability,
  resetHostPreviewCapabilityForTests,
} from "../filePreviewKinds";

const CAP = "0123456789abcdef0123456789abcdef";

function viewHost(
  id: string | undefined,
  getPreviewCapability = vi.fn(async (): Promise<string | null> => CAP)
) {
  vi.stubGlobal("window", {
    ...(id === undefined ? {} : { __DAINTREE_HOST_ID__: { id } }),
    electron: { fileTransfer: { getPreviewCapability } },
  });
  return getPreviewCapability;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHostPreviewCapabilityForTests();
});

const LOCAL = {
  file: "daintree-file://load?path=%2Frepo%2Fa%20b.png&root=%2Frepo",
  media: "daintree-media://load/?path=%2Frepo%2Fa%20b.png&root=%2Frepo",
  pdf: "daintree-pdf://load?path=%2Frepo%2Fa%20b.png&root=%2Frepo",
};

function build() {
  return {
    file: buildDaintreeFileUrl("/repo/a b.png", "/repo"),
    media: buildDaintreeMediaUrl("/repo/a b.png", "/repo"),
    pdf: buildDaintreePdfUrl("/repo/a b.png", "/repo"),
  };
}

describe("preview URLs by view host", () => {
  it("are byte-identical to the local shape for a view of this machine", async () => {
    const fetchCap = viewHost(undefined);
    expect(build()).toEqual(LOCAL);
    expect(await primeHostPreviewCapability()).toBeNull();
    viewHost("local", fetchCap);
    expect(build()).toEqual(LOCAL);
    expect(await primeHostPreviewCapability()).toBeNull();
    expect(fetchCap).not.toHaveBeenCalled();
  });

  it("name the host and carry this view's capability for a remote view", async () => {
    const fetchCap = viewHost("studio-01");
    expect(await primeHostPreviewCapability()).toBe(CAP);
    const urls = build();
    expect(urls.file).toBe(
      `daintree-file://host/studio-01/${CAP}/load?path=%2Frepo%2Fa%20b.png&root=%2Frepo`
    );
    expect(urls.media).toBe(
      `daintree-media://host/studio-01/${CAP}/load/?path=%2Frepo%2Fa%20b.png&root=%2Frepo`
    );
    expect(urls.pdf).toBe(
      `daintree-pdf://host/studio-01/${CAP}/load?path=%2Frepo%2Fa%20b.png&root=%2Frepo`
    );
    for (const url of Object.values(urls)) {
      const parsed = new URL(url);
      expect(parsed.host).toBe("host");
      expect(parsed.searchParams.get("path")).toBe("/repo/a b.png");
    }
    await primeHostPreviewCapability();
    expect(fetchCap).toHaveBeenCalledTimes(1);
  });

  it("fetches the capability once for concurrent callers", async () => {
    const fetchCap = viewHost("studio-01");
    const [a, b] = await Promise.all([primeHostPreviewCapability(), primeHostPreviewCapability()]);
    expect(a).toBe(CAP);
    expect(b).toBe(CAP);
    expect(fetchCap).toHaveBeenCalledTimes(1);
  });

  it("goes without a capability until it arrives, and starts fetching it", async () => {
    const fetchCap = viewHost("studio-01");
    expect(buildDaintreeFileUrl("/a", "/")).toBe(
      "daintree-file://host/studio-01/load?path=%2Fa&root=%2F"
    );
    expect(fetchCap).toHaveBeenCalledTimes(1);
    await primeHostPreviewCapability();
    expect(buildDaintreeFileUrl("/a", "/")).toBe(
      `daintree-file://host/studio-01/${CAP}/load?path=%2Fa&root=%2F`
    );
  });

  it("asks again after a failed fetch", async () => {
    const fetchCap = viewHost(
      "studio-01",
      vi.fn(async (): Promise<string | null> => {
        throw new Error("link down");
      })
    );
    expect(await primeHostPreviewCapability()).toBeNull();
    fetchCap.mockResolvedValueOnce(CAP);
    expect(await primeHostPreviewCapability()).toBe(CAP);
    expect(fetchCap).toHaveBeenCalledTimes(2);
  });

  it("lets a caller pin the host explicitly, never lending this view's capability to another host", async () => {
    viewHost("studio-01");
    await primeHostPreviewCapability();
    expect(buildDaintreeFileUrl("/a", "/", null)).toBe("daintree-file://load?path=%2Fa&root=%2F");
    expect(buildDaintreeFileUrl("/a", "/", "Mac.lan")).toBe(
      "daintree-file://host/Mac.lan/load?path=%2Fa&root=%2F"
    );
  });
});
