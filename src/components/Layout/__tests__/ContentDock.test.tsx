// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ContentDock regression test", () => {
  it("does not import or render ClusterAttentionPill", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ClusterAttentionPill");
    expect(content).not.toContain('from "@/components/Fleet"');
  });

  it("renders from resolved dock items instead of raw tab-group shells", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("const dockItems = useMemo");
    expect(content).toContain("dockItems.length === 0");
    expect(content).not.toContain("if (groupPanels.length === 0) return null");
  });

  it("offscreen dock container closes stale active dock state", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activeDockTerminalId");
    expect(content).toContain("closeDockTerminal()");
    expect(content).toContain("!s.trashedTerminals.has(t.id)");
  });

  it("renders the visible DockLaunchButton wired to handleAddTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("DockLaunchButton");
    expect(content).toContain("agents={launchAgents}");
    expect(content).toMatch(/onLaunchAgent=\{[^}]*handleAddTerminal/);
    expect(content).toContain("hasDevPreview={hasDevPreview}");
  });

  it("places the launch button on the left side of the dock", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    const launchIdx = content.indexOf("<DockLaunchButton");
    const helpIdx = content.indexOf("<HelpAgentDockButton");
    const trashIdx = content.indexOf("<TrashContainer");

    expect(launchIdx).toBeGreaterThan(0);
    expect(launchIdx).toBeLessThan(trashIdx);
    expect(launchIdx).toBeLessThan(helpIdx);
  });

  // Issue #6428 — accent ring on isOver was a restraint violation; replace with neutral.
  it("uses a neutral ring on dock isOver state (no accent)", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ring-daintree-accent");
    expect(content).toMatch(/isOver\s*&&\s*[^]*?ring-border-default/);
  });
});
