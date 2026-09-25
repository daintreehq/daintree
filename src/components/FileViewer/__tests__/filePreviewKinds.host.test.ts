import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDaintreeFileUrl,
  buildDaintreeMediaUrl,
  buildDaintreePdfUrl,
} from "../filePreviewKinds";

function viewHost(id: string | undefined): void {
  vi.stubGlobal("window", id === undefined ? {} : { __DAINTREE_HOST_ID__: { id } });
}

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("are byte-identical to the local shape for a view of this machine", () => {
    viewHost(undefined);
    expect(build()).toEqual(LOCAL);
    viewHost("local");
    expect(build()).toEqual(LOCAL);
  });

  it("name the host for a remote view, keeping the local query", () => {
    viewHost("studio-01");
    const urls = build();
    expect(urls.file).toBe(
      "daintree-file://host/studio-01/load?path=%2Frepo%2Fa%20b.png&root=%2Frepo"
    );
    expect(urls.media).toBe(
      "daintree-media://host/studio-01/load/?path=%2Frepo%2Fa%20b.png&root=%2Frepo"
    );
    expect(urls.pdf).toBe(
      "daintree-pdf://host/studio-01/load?path=%2Frepo%2Fa%20b.png&root=%2Frepo"
    );
    for (const url of Object.values(urls)) {
      const parsed = new URL(url);
      expect(parsed.host).toBe("host");
      expect(parsed.searchParams.get("path")).toBe("/repo/a b.png");
    }
  });

  it("lets a caller pin the host explicitly", () => {
    viewHost("studio-01");
    expect(buildDaintreeFileUrl("/a", "/", null)).toBe("daintree-file://load?path=%2Fa&root=%2F");
    viewHost(undefined);
    expect(buildDaintreeFileUrl("/a", "/", "Mac.lan")).toBe(
      "daintree-file://host/Mac.lan/load?path=%2Fa&root=%2F"
    );
  });
});
