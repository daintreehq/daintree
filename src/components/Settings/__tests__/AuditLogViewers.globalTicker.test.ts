import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * Audit-log viewers — shared minute-ticker wiring (issue #9582).
 *
 * The three settings audit-log viewers (`McpAuditLogViewer`,
 * `ForgeAuditLogViewer`, `PluginActionAuditLogViewer`) previously each ran
 * their own 30s `setInterval` to refresh relative timestamps — firing even
 * when the window was hidden. They now derive `now` from the shared
 * visibility-gated `useGlobalMinuteTicker` singleton (the same pattern as
 * `GitHubStatsToolbarButton`).
 *
 * These are source assertions rather than render tests: the viewers have no
 * jsdom setup and the migration is a non-behavioral timer-source swap, so
 * locking the wiring in source prevents a future copy of the old per-component
 * timer pattern from drifting back in.
 */
const VIEWERS = [
  "McpAuditLogViewer.tsx",
  "ForgeAuditLogViewer.tsx",
  "PluginActionAuditLogViewer.tsx",
] as const;

describe("audit-log viewers — shared minute-ticker wiring (issue #9582)", () => {
  const sources = new Map<string, string>();

  beforeAll(async () => {
    for (const file of VIEWERS) {
      sources.set(file, await fs.readFile(path.resolve(__dirname, "..", file), "utf-8"));
    }
  });

  it.each(VIEWERS)("%s imports and reads the shared minute ticker", (file) => {
    const source = sources.get(file)!;
    expect(source).toContain('from "@/hooks/useGlobalMinuteTicker"');
    expect(source).toMatch(/const\s+tick\s*=\s*useGlobalMinuteTicker\(\)/);
  });

  it.each(VIEWERS)(
    "%s derives now via useMemo(() => { void tick; return Date.now() }, [tick])",
    (file) => {
      const source = sources.get(file)!;
      expect(source).toMatch(
        /const\s+now\s*=\s*useMemo\(\s*\(\)\s*=>\s*\{\s*void tick;\s*return Date\.now\(\);\s*\}\s*,\s*\[tick\]\s*\)/
      );
    }
  );

  it.each(VIEWERS)("%s no longer hand-rolls a per-component timer", (file) => {
    const source = sources.get(file)!;
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("clearInterval");
    expect(source).not.toContain("RELATIVE_TIMESTAMP_REFRESH_MS");
    expect(source).not.toContain("nowTick");
  });

  it("McpAuditLogViewer derives the one-hour cutoff from the ticker, not a fresh Date.now()", () => {
    const source = sources.get("McpAuditLogViewer.tsx")!;
    expect(source).toContain("const oneHourAgo = now - 3_600_000");
    expect(source).not.toContain("Date.now() - 3_600_000");
  });
});
