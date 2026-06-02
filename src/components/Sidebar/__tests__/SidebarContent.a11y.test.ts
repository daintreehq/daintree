import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent accessibility — issue #9662", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("reconnecting indicator — one-shot screen-reader announcement", () => {
    it("hides the per-tick visual reconnecting span from the accessibility tree", () => {
      // The visible "Reconnecting… last updated Xs ago" text is rewritten every
      // second by the 1Hz tick. If it stayed inside an aria-live region the AT
      // would re-announce on every tick. The span must be aria-hidden so those
      // mutations never reach assistive tech.
      const reconnectingSpan = source.match(
        /\{showReconnecting && \(\s*<span[\s\S]*?Reconnecting…[\s\S]*?<\/span>\s*\)\}/
      );
      expect(reconnectingSpan).not.toBeNull();
      const span = reconnectingSpan![0];
      expect(span).toMatch(/aria-hidden="true"/);
      // The ticking relative time must live inside the aria-hidden span.
      expect(span).toMatch(/formatRelativeTime\(reconnectingAt\)/);
      // And the live-region attributes must be gone from that span.
      expect(span).not.toMatch(/role="status"/);
      expect(span).not.toMatch(/aria-live=/);
    });

    it("announces once via the announcer store on the rising edge of reconnecting", () => {
      // One-shot announcements replace the tick-churned live region: imperative
      // announce() calls routed through document.ariaNotify (Chromium 146).
      expect(source).toMatch(
        /import \{ useAnnouncerStore \} from "@\/store\/accessibilityAnnouncerStore"/
      );
      expect(source).toMatch(
        /useAnnouncerStore\.getState\(\)\.announce\("Reconnecting…", "polite"\)/
      );
      expect(source).toMatch(
        /useAnnouncerStore\.getState\(\)\.announce\("Still reconnecting…", "polite"\)/
      );
    });

    it("edge-detects transitions with refs so it fires once, not on every tick", () => {
      // Refs track the previous reconnecting/escalated values; the announce
      // calls are guarded by a false→true edge check, so the 1Hz re-render
      // never re-announces.
      expect(source).toMatch(/prevReconnecting\.current/);
      expect(source).toMatch(/prevEscalated\.current/);
      expect(source).toMatch(/if \(showReconnecting && !prevReconnecting\.current\)/);
      expect(source).toMatch(/if \(showReconnectingEscalated && !prevEscalated\.current\)/);
    });
  });

  describe("refresh button — aria-disabled preserves keyboard focus", () => {
    it("uses aria-disabled instead of the native disabled attribute", () => {
      // Native disabled drops keyboard focus to <body>; aria-disabled keeps the
      // button focusable while the re-entry guard in handleRefreshAll blocks
      // activation.
      const refreshButton = source.match(
        /<button[^>]*onClick=\{handleRefreshAll\}[\s\S]*?aria-label="Refresh sidebar"/
      );
      expect(refreshButton).not.toBeNull();
      const button = refreshButton![0];
      expect(button).toMatch(/aria-disabled=\{isRefreshing \|\| undefined\}/);
      expect(button).not.toMatch(/[^-]disabled=\{isRefreshing\}/);
    });

    it("uses aria-disabled: Tailwind variants for the disabled styling", () => {
      const refreshButton = source.match(
        /<button[^>]*onClick=\{handleRefreshAll\}[\s\S]*?aria-label="Refresh sidebar"/
      );
      const button = refreshButton![0];
      expect(button).toMatch(/aria-disabled:opacity-40/);
      expect(button).toMatch(/aria-disabled:cursor-not-allowed/);
      expect(button).not.toMatch(/[^-]disabled:opacity-40/);
    });

    it("keeps the handleRefreshAll re-entry guard that suppresses activation", () => {
      // aria-disabled does not natively block click/Enter/Space, so the JS guard
      // is what actually prevents a second refresh.
      expect(source).toMatch(
        /const handleRefreshAll = useCallback\(\(\) => \{\s*if \(isRefreshing\) return;/
      );
    });
  });
});
