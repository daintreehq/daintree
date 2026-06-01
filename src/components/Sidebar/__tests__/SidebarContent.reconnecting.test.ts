import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent reconnecting indicator — issue #8074", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("gates the reconnecting indicator behind useDohertyGate", () => {
    // Doherty Threshold (400ms): routine sub-second port replacements must not
    // flash a spinner. The reconnecting state mirrors the existing
    // showRefreshSpinner pattern on the same component.
    expect(source).toMatch(/const showReconnecting = useDohertyGate\(isReconnecting\)/);
  });

  it("renders the Reconnecting… span behind showReconnecting, not raw isReconnecting", () => {
    // Regression guard: anything in the render tree that reads isReconnecting
    // directly bypasses the deferred gate and flickers on every sub-400ms
    // disconnect→reconnect.
    const reconnectingSpan = source.match(
      /\{showReconnecting && \(\s*<span[\s\S]*?Reconnecting…[\s\S]*?<\/span>\s*\)\}/
    );
    expect(reconnectingSpan).not.toBeNull();
    expect(source).not.toMatch(/\{isReconnecting && \(\s*<span/);
  });

  it("drives the reconnect tick via useVisibilityAwareInterval, not a bare setInterval — issue #9583", () => {
    // Chromium intensively throttles hidden-tab setInterval to ~1/min after 10s,
    // which corrupts the "last updated X ago" relative-time display. The tick
    // must pause while hidden and snap back on restore via the visibility hook.
    expect(source).toMatch(/import \{ useVisibilityAwareInterval \}/);
    expect(source).toMatch(
      /useVisibilityAwareInterval\(\s*\(\) => setReconnectTick\(\(n\) => n \+ 1\),\s*1000,\s*isReconnecting && reconnectingAt != null\s*\)/
    );
    // The old ungated reconnect interval must be gone.
    expect(source).not.toMatch(/setInterval\(\(\) => setReconnectTick/);
  });
});
