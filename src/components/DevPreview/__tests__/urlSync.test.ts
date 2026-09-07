import { describe, it, expect } from "vitest";
import { computeDevServerUrl, isOnOrigin, normalizeDevPreviewUrl } from "../urlSync";

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

    it("keeps the pane's own route when the dev server also advertises a base path (#12297)", () => {
      // The advertised base wins on *first* adoption (covered above), but on a migration
      // the pane already holds the route the user or the app asked for.
      expect(
        computeDevServerUrl("http://localhost:5174/app/", "http://localhost:5174/once", PROXY)
      ).toBe(`${PROXY}/once`);
    });

    it("preserves query and fragment when migrating an upstream callback (#12297)", () => {
      expect(
        computeDevServerUrl(
          "http://localhost:5173/",
          "http://localhost:5173/consume?token=audit-single-use#done",
          PROXY
        )
      ).toBe(`${PROXY}/consume?token=audit-single-use#done`);
    });

    it("treats a root URL carrying only a query as a route worth preserving", () => {
      expect(
        computeDevServerUrl("http://localhost:5174/app/", "http://localhost:5173/?code=abc", PROXY)
      ).toBe(`${PROXY}/?code=abc`);
    });

    it("keeps a hash-router route across the migration", () => {
      expect(
        computeDevServerUrl("http://localhost:5173/", "http://localhost:5173/#/settings", PROXY)
      ).toBe(`${PROXY}/#/settings`);
    });
  });
});

describe("isOnOrigin", () => {
  it("matches a URL sitting on exactly that origin", () => {
    expect(isOnOrigin("http://dp-a-b.localhost:43000/x?y#z", "http://dp-a-b.localhost:43000")).toBe(
      true
    );
  });

  it("rejects a port that merely shares a prefix", () => {
    // `startsWith` would accept this — 43000 begins with 4300.
    expect(isOnOrigin("http://dp-a-b.localhost:43000/", "http://dp-a-b.localhost:4300")).toBe(
      false
    );
  });

  it("rejects a different subdomain and a different scheme", () => {
    expect(isOnOrigin("http://dp-a-c.localhost:43000/", "http://dp-a-b.localhost:43000")).toBe(
      false
    );
    expect(isOnOrigin("https://dp-a-b.localhost:43000/", "http://dp-a-b.localhost:43000")).toBe(
      false
    );
  });

  it("rejects unparseable input on either side", () => {
    expect(isOnOrigin("not-a-url", "http://dp-a-b.localhost:43000")).toBe(false);
    expect(isOnOrigin("http://dp-a-b.localhost:43000/", "not-a-url")).toBe(false);
  });
});

describe("normalizeDevPreviewUrl (#12297)", () => {
  const PROXY = "http://dp-proj-panel.localhost:43000";

  describe("configured proxy mode", () => {
    it("accepts the panel's own proxy origin — the bug that made the address bar unusable", () => {
      expect(normalizeDevPreviewUrl(`${PROXY}/typed-route`, PROXY)).toEqual({
        url: `${PROXY}/typed-route`,
      });
    });

    it("accepts the panel's own origin typed without a scheme", () => {
      expect(normalizeDevPreviewUrl("dp-proj-panel.localhost:43000/typed-route", PROXY)).toEqual({
        url: `${PROXY}/typed-route`,
      });
    });

    it("keeps query and fragment on the panel's own origin", () => {
      expect(normalizeDevPreviewUrl(`${PROXY}/a/b?x=1&x=2#frag`, PROXY)).toEqual({
        url: `${PROXY}/a/b?x=1&x=2#frag`,
      });
    });

    it("retargets a raw upstream URL onto the proxy origin, preserving the whole route", () => {
      expect(normalizeDevPreviewUrl("http://localhost:5173/once?a=1#b", PROXY)).toEqual({
        url: `${PROXY}/once?a=1#b`,
      });
    });

    it("retargets regardless of which upstream port was typed", () => {
      expect(normalizeDevPreviewUrl("http://127.0.0.1:9999/deep/route", PROXY)).toEqual({
        url: `${PROXY}/deep/route`,
      });
    });

    it("preserves percent-encoded path segments through the retarget", () => {
      expect(normalizeDevPreviewUrl("http://localhost:5173/a%2Fb/c%20d", PROXY)).toEqual({
        url: `${PROXY}/a%2Fb/c%20d`,
      });
    });

    it("is idempotent — re-normalizing its own output changes nothing", () => {
      const once = normalizeDevPreviewUrl("http://localhost:5173/once?a=1#b", PROXY);
      expect(normalizeDevPreviewUrl(once.url!, PROXY)).toEqual(once);
    });

    it("rejects another panel's proxy origin (same shape, different owner)", () => {
      const result = normalizeDevPreviewUrl("http://dp-proj-other.localhost:43000/x", PROXY);
      expect(result.url).toBeUndefined();
      expect(result.error).toContain("Only localhost URLs are allowed");
    });

    it("rejects the panel's own host on a different port", () => {
      expect(normalizeDevPreviewUrl("http://dp-proj-panel.localhost:43001/x", PROXY).url).toBe(
        undefined
      );
    });

    it("rejects https on the panel's own host — the proxy serves plain HTTP", () => {
      expect(normalizeDevPreviewUrl("https://dp-proj-panel.localhost:43000/x", PROXY).url).toBe(
        undefined
      );
    });

    it.each([
      ["an arbitrary .localhost name", "http://evil.localhost:43000/x"],
      ["a private LAN address", "http://192.168.1.7:3000/x"],
      ["a public host", "http://example.com/x"],
      ["a .test name", "http://app.test/x"],
    ])("rejects %s without offering confirmation", (_label, input) => {
      const result = normalizeDevPreviewUrl(input, PROXY);
      expect(result.url).toBeUndefined();
      expect(result.requiresConfirmation).toBeUndefined();
      expect(result.error).toBeTruthy();
    });

    it("rejects a non-http(s) protocol", () => {
      expect(normalizeDevPreviewUrl("file:///etc/passwd", PROXY).url).toBeUndefined();
      expect(normalizeDevPreviewUrl("javascript:alert(1)", PROXY).url).toBeUndefined();
    });

    it("rejects empty input", () => {
      expect(normalizeDevPreviewUrl("   ", PROXY).error).toBeTruthy();
    });
  });

  describe("legacy / unresolved proxy", () => {
    it("keeps a loopback URL untouched in legacy mode", () => {
      expect(normalizeDevPreviewUrl("http://localhost:5173/once", null)).toEqual({
        url: "http://localhost:5173/once",
      });
    });

    it("keeps a loopback URL untouched while the proxy port is still resolving", () => {
      expect(normalizeDevPreviewUrl("http://localhost:5173/once", undefined)).toEqual({
        url: "http://localhost:5173/once",
      });
    });

    it("still rejects a proxy-shaped origin when this panel has none", () => {
      expect(normalizeDevPreviewUrl("http://dp-proj-panel.localhost:43000/x", null).url).toBe(
        undefined
      );
    });
  });
});
