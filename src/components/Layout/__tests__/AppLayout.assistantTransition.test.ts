import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

// Issue #10693: the assistant pane is shown/hidden with an off-canvas slide. A
// fixed-width wrapper animates `transform: translateX` (composited — no layout,
// no ResizeObserver, terminal geometry stable) while a sibling layout spacer
// animates its width 0↔helpPanelWidth to drive the <main> push. The spacer is
// the grid-reflow driver, so it arms the resize lock; the wrapper's transform
// settle issues the corrective repaint and parks the wrapper inert on hide.
describe("AppLayout assistant off-canvas slide — issue #10693", () => {
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

  it("arms the grid-resize lock on the spacer's width-transition start", () => {
    const handler = source.match(
      /const handleAssistantSpacerTransitionStart = useCallback\(([\s\S]*?)\n {2}\);/
    );
    expect(handler).not.toBeNull();
    expect(handler![1]).toContain('event.propertyName === "width"');
    expect(handler![1]).toContain("event.target === event.currentTarget");
    expect(handler![1]).toContain("suppressSidebarResizes()");
  });

  it("repaints and parks inert when the wrapper's transform slide settles", () => {
    const handler = source.match(
      /const handleAssistantTransitionEnd = useCallback\(([\s\S]*?)\n {2}\);/
    );
    expect(handler).not.toBeNull();
    // Filters on transform (the property the wrapper now animates), not width.
    expect(handler![1]).toContain('event.propertyName === "transform"');
    expect(handler![1]).toContain("event.target === event.currentTarget");
    expect(handler![1]).toContain("repaintAssistantAfterTransition()");
    // Inert is only set on a hide (slide-out), never on reveal.
    expect(handler![1]).toContain("if (!showAssistant) setAssistantInert(true)");
  });

  it("tracks the parked-inert state for the off-canvas wrapper", () => {
    expect(source).toMatch(/const \[assistantInert, setAssistantInert\] = useState\(/);
  });

  it("drives the push with a width-animated spacer that arms the lock", () => {
    expect(source).toContain("onTransitionStart={handleAssistantSpacerTransitionStart}");
    // The spacer is the element that animates width now.
    expect(source).toMatch(
      /aria-hidden[\s\S]*?transition-\[width\][\s\S]*?style=\{\{ width: effectiveAssistantWidth \}\}/
    );
  });

  it("slides the fixed-width wrapper with a composited transform", () => {
    // The wrapper animates transform, not width: its width is the constant
    // helpPanelWidth and it translateX-es off-canvas when hidden.
    expect(source).toContain("transition-transform");
    expect(source).toMatch(/transform: showAssistant\s*\n?\s*\?\s*"translateX\(0\)"/);
    expect(source).toMatch(/translateX\(\$\{layout\.helpPanelWidth\}px\)/);
    expect(source).toContain("onTransitionEnd={handleAssistantTransitionEnd}");
    expect(source).toContain("inert={assistantInert}");
  });

  it("gates both the spacer width and wrapper transform transitions during drag-resize", () => {
    // Both animated properties must be suppressed while isAssistantResizing so a
    // drag tracks the cursor 1:1 (#7642/#7627). Each gated block pairs the
    // reduce-animations and resizing guards.
    const gatedBlocks = source.match(/!reduceAnimations &&\s*\n\s*!isAssistantResizing &&/g);
    expect(gatedBlocks).not.toBeNull();
    expect(gatedBlocks!.length).toBeGreaterThanOrEqual(2);
  });

  it("does not wire transitioncancel (the final transitionend resolves rapid toggles)", () => {
    expect(source).not.toContain("onTransitionCancel");
  });
});
