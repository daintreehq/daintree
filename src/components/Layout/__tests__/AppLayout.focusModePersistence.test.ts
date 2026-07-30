import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

/**
 * AppLayout has no render harness, so this suite reads the source the way the
 * sibling sidebar/banner suites do.
 *
 * What it protects: focus mode is persisted per workspace, and a workspace is a
 * project OR a scratch. Only a renderer with neither may fall back to writing
 * the legacy global `appState.focusMode`. That global is still the migration
 * source for every real project the user has not reopened since upgrading, so
 * letting a scratch write to it destroys their saved focus mode (#11497).
 */
describe("AppLayout focus-mode persistence — workspace ownership (#11497)", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("resolves a workspace id that a scratch can satisfy", () => {
    // A scratch has no Project row but does own per-workspace state, so the
    // scratch id has to be part of the id the persistence path resolves.
    expect(source).toMatch(/const workspaceId = currentProject\?\.id \?\? currentScratch\?\.id/);
  });

  it("gates the legacy global write on there being no workspace at all", () => {
    // The guard must test the resolved workspace id, never `currentProject`
    // alone — `!currentProject?.id` is true for a scratch, which is exactly the
    // path that used to overwrite the legacy global.
    expect(source).toContain("if (!workspaceId) {");
    expect(source).not.toMatch(/if \(!currentProject\?\.id\) \{[\s\S]{0,400}?appClient\.setState/);
  });

  it("writes per-workspace state through the resolved workspace id", () => {
    // Passing `currentProject.id` here would throw for a scratch and silently
    // reintroduce the global fallback as the only working path.
    expect(source).toMatch(/setFocusMode\(\s*workspaceId,/);
  });

  it("re-runs persistence when the active scratch changes", () => {
    // Without the scratch id in the dependency list the effect keeps the
    // previous workspace's closure and writes focus mode to the wrong record.
    const effectDeps = source.match(/\}, \[\s*layout\.gestureSidebarHidden,[\s\S]*?\]\);/);
    expect(effectDeps).not.toBeNull();
    expect(effectDeps?.[0]).toContain("currentScratch?.id");
  });
});
