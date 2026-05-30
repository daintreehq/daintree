import { describe, it, expect } from "vitest";
import { computeDevServerUrl } from "../urlSync";

describe("computeDevServerUrl", () => {
  it("returns false when there is no detected URL", () => {
    expect(computeDevServerUrl("", "http://localhost:3000/dashboard")).toBe(false);
  });

  it("returns the bare detected URL when there is no current URL", () => {
    expect(computeDevServerUrl("http://localhost:3000/", "")).toBe("http://localhost:3000/");
  });

  it("returns false when detected and current URLs are identical", () => {
    expect(computeDevServerUrl("http://localhost:3000/x", "http://localhost:3000/x")).toBe(false);
  });

  it("returns false on the same origin even with a different path", () => {
    expect(computeDevServerUrl("http://localhost:3000/", "http://localhost:3000/dashboard")).toBe(
      false
    );
  });

  it("grafts the current pathname onto the new origin on a port shift", () => {
    expect(
      computeDevServerUrl("http://localhost:3001", "http://localhost:3000/dashboard/settings")
    ).toBe("http://localhost:3001/dashboard/settings");
  });

  it("preserves search and hash when grafting onto the new origin", () => {
    expect(
      computeDevServerUrl(
        "http://localhost:3001",
        "http://localhost:3000/dashboard/settings?tab=x#section"
      )
    ).toBe("http://localhost:3001/dashboard/settings?tab=x#section");
  });

  it("returns the root of the new origin when the current URL has no route", () => {
    expect(computeDevServerUrl("http://localhost:3001/", "http://localhost:3000/")).toBe(
      "http://localhost:3001/"
    );
  });

  it("respects a non-root base path the dev server advertises on a port shift", () => {
    expect(
      computeDevServerUrl("http://localhost:5174/app/", "http://localhost:5173/dashboard")
    ).toBe("http://localhost:5174/app/");
  });

  it("returns a base-path detected URL unchanged when there is no current URL", () => {
    expect(computeDevServerUrl("http://localhost:5174/app/", "")).toBe(
      "http://localhost:5174/app/"
    );
  });

  it("preserves a hash-router route when grafting onto the new origin", () => {
    expect(
      computeDevServerUrl("http://localhost:5174/", "http://localhost:5173/#/settings?tab=auth")
    ).toBe("http://localhost:5174/#/settings?tab=auth");
  });

  it("falls forward to the detected URL when the current URL cannot be parsed", () => {
    expect(computeDevServerUrl("http://localhost:3001/", "not-a-url")).toBe(
      "http://localhost:3001/"
    );
  });

  it("falls forward to the detected URL when the detected URL cannot be parsed", () => {
    expect(computeDevServerUrl("not-a-url", "http://localhost:3000/dashboard")).toBe("not-a-url");
  });

  describe("proxy mode (#9100)", () => {
    const PROXY = "http://dp-proj-panel.localhost:43000";

    it("returns false when there is no detected URL even with a proxy origin", () => {
      expect(computeDevServerUrl("", "", PROXY)).toBe(false);
    });

    it("navigates onto the proxy origin root on first detection", () => {
      expect(computeDevServerUrl("http://localhost:3000/", "", PROXY)).toBe(`${PROXY}/`);
    });

    it("returns false once the pane is already on the proxy origin (stable restart)", () => {
      // Dev server restarted on a new upstream port; the proxy follows it transparently,
      // so the webview must NOT re-navigate.
      expect(computeDevServerUrl("http://localhost:3001/", `${PROXY}/dashboard`, PROXY)).toBe(
        false
      );
    });

    it("ignores the upstream port entirely — same proxy origin regardless of detected port", () => {
      expect(computeDevServerUrl("http://localhost:9999/", `${PROXY}/`, PROXY)).toBe(false);
    });

    it("migrates off a stale direct-localhost URL onto the proxy origin, preserving the route", () => {
      expect(
        computeDevServerUrl("http://localhost:3000/", "http://localhost:3000/settings?tab=x", PROXY)
      ).toBe(`${PROXY}/settings?tab=x`);
    });

    it("honors a non-root base path the dev server advertises when first adopting the proxy", () => {
      expect(computeDevServerUrl("http://localhost:5174/app/", "", PROXY)).toBe(`${PROXY}/app/`);
    });

    it("returns false when the proxy origin string cannot be parsed", () => {
      expect(computeDevServerUrl("http://localhost:3000/", "", "not-a-url")).toBe(false);
    });
  });
});
