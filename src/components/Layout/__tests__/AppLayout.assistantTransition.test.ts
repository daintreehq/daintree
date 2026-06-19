import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

// Issue #10693: showing/hiding the Assistant pane animates its wrapper width
// 0↔full over 250ms. The per-frame ResizeObserver storm that drives forwards a
// SIGWINCH to the hosted CLI orphans a status-line row into scrollback each
// cycle. AppLayout must arm the PTY resize lock at the real animation start and
// release it (with a corrective repaint) when the transition settles — wired to
// the wrapper's transition events, mirroring the existing sidebar handler.
describe("AppLayout assistant transition resize suppression — issue #10693", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports both the arm and release helpers from sidebarToggle", () => {
    expect(source).toContain('from "@/lib/sidebarToggle"');
    expect(source).toMatch(
      /import \{[^}]*releaseAssistantResizeLock[^}]*\} from "@\/lib\/sidebarToggle"/
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

  it("releases the lock on transition settle via releaseAssistantResizeLock", () => {
    const handler = source.match(
      /const handleAssistantTransitionSettled = useCallback\(([\s\S]*?)\n {2}\);/
    );
    expect(handler).not.toBeNull();
    expect(handler![1]).toContain("releaseAssistantResizeLock()");
  });

  it("filters both handlers to the wrapper's own width transition", () => {
    // propertyName === "width" ignores other transitioned props; target ===
    // currentTarget blocks bubbled child transitions — same guard the sidebar
    // handler uses.
    for (const name of ["handleAssistantTransitionStart", "handleAssistantTransitionSettled"]) {
      const handler = source.match(
        new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\n {2}\\);`)
      );
      expect(handler, `${name} should exist`).not.toBeNull();
      expect(handler![1]).toContain('event.propertyName === "width"');
      expect(handler![1]).toContain("event.target === event.currentTarget");
    }
  });

  it("wires transitionstart, transitionend, and transitioncancel on the assistant wrapper", () => {
    // transitioncancel is mandatory: a rapid hide→show reverses the animation
    // and fires transitioncancel (never transitionend), so it must route to the
    // same release handler or the lock is stranded.
    expect(source).toContain("onTransitionStart={handleAssistantTransitionStart}");
    expect(source).toContain("onTransitionEnd={handleAssistantTransitionSettled}");
    expect(source).toContain("onTransitionCancel={handleAssistantTransitionSettled}");
  });
});
