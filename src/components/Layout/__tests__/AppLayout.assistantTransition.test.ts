import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

// Issue #10693: showing/hiding the Assistant pane animates its wrapper width
// 0↔full over 250ms. The per-frame ResizeObserver storm that drives a SIGWINCH
// to the hosted CLI orphans a status-line row into scrollback each cycle.
// AppLayout must arm the PTY resize lock at the real animation start and issue a
// single corrective repaint when the transition settles — wired to the
// wrapper's transition events, mirroring the existing sidebar handler.
describe("AppLayout assistant transition resize suppression — issue #10693", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports both the arm and repaint helpers from sidebarToggle", () => {
    expect(source).toContain('from "@/lib/sidebarToggle"');
    expect(source).toMatch(
      /import \{[^}]*repaintAssistantAfterTransition[^}]*\} from "@\/lib\/sidebarToggle"/
    );
    expect(source).toMatch(
      /import \{[^}]*suppressSidebarResizes[^}]*\} from "@\/lib\/sidebarToggle"/
    );
  });

  it("arms the lock on transitionstart via suppressSidebarResizes", () => {
    const handler = source.match(
      /const handleAssistantTransitionStart = useCallback\(([\s\S]*?)\n {2}\);/
    );
    expect(handler).not.toBeNull();
    expect(handler![1]).toContain("suppressSidebarResizes()");
  });

  it("repaints on transition settle via repaintAssistantAfterTransition", () => {
    const handler = source.match(
      /const handleAssistantTransitionEnd = useCallback\(([\s\S]*?)\n {2}\);/
    );
    expect(handler).not.toBeNull();
    expect(handler![1]).toContain("repaintAssistantAfterTransition()");
  });

  it("filters both handlers to the wrapper's own width transition", () => {
    // propertyName === "width" ignores other transitioned props; target ===
    // currentTarget blocks bubbled child transitions — same guard the sidebar
    // handler uses.
    for (const name of ["handleAssistantTransitionStart", "handleAssistantTransitionEnd"]) {
      const handler = source.match(
        new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\n {2}\\);`)
      );
      expect(handler, `${name} should exist`).not.toBeNull();
      expect(handler![1]).toContain('event.propertyName === "width"');
      expect(handler![1]).toContain("event.target === event.currentTarget");
    }
  });

  it("wires only transitionstart and transitionend on the assistant wrapper", () => {
    // transitioncancel is deliberately NOT wired: a rapid hide→show fires cancel
    // at an intermediate animating width, where a repaint would assert a wrong
    // column count. The suppression timer owns the unlock and the following
    // show's transitionend repaints correctly.
    expect(source).toContain("onTransitionStart={handleAssistantTransitionStart}");
    expect(source).toContain("onTransitionEnd={handleAssistantTransitionEnd}");
    expect(source).not.toContain("onTransitionCancel");
  });
});
