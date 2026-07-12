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
      /import \{[^}]*createAssistantRevealCoordinator[^}]*\} from "@\/lib\/sidebarToggle"/
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
    // #11070: the settle carries the show/hide direction, so a hide-settle cancels
    // the reveal obligation instead of arming one against a parked pane.
    expect(handler![1]).toContain("assistantReveal.settleAfterTransition(showAssistant)");
    // Inert is only set on a hide (slide-out), never on reveal.
    expect(handler![1]).toContain("if (!showAssistant) setAssistantInert(true)");
  });

  // Issue #11070: on a cold first open the slide settles while the assistant
  // session is still provisioning, so there is no terminalId to repaint. The
  // repaint must survive as an obligation the coordinator discharges once the
  // terminal binds — not be dropped on the floor.
  it("owns a reveal coordinator whose lifetime is the layout's", () => {
    expect(source).toMatch(
      /const \[assistantReveal\] = useState\(createAssistantRevealCoordinator\)/
    );
    // Subscription installed via effect (never at module scope) and disposed with
    // the component.
    expect(source).toContain("useEffect(() => assistantReveal.start(), [assistantReveal])");
  });

  it("cancels the obligation on the hide STATE change, not at the hide slide's end", () => {
    // A terminal that binds while the panel is sliding away must not repaint into
    // a hidden pane, so visibility is tracked as it flips — ahead of transitionend.
    expect(source).toMatch(/assistantReveal\.setVisible\(showAssistant\)/);
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

  // Issue #10704: the slide must use asymmetric Tier-3 panel-motion timing —
  // decelerate on enter (200ms ease-out-expo), accelerate on exit (120ms
  // ease-panel-minimize) — switched on showAssistant, not a symmetric 250ms.
  it("uses asymmetric panel-motion-tier timing switched on showAssistant", () => {
    // Anchor to the assistant region (first aria-hidden = the spacer) so the
    // sidebar's legitimate symmetric 250ms width transition isn't captured.
    const region = source.match(
      /aria-hidden[\s\S]*?onTransitionEnd=\{handleAssistantTransitionEnd\}/
    );
    expect(region).not.toBeNull();
    const slide = region![0];

    // Bind direction to branch: the enter (200ms decelerate) class must sit on
    // the `showAssistant ?` true-arm and the exit (120ms accelerate) class on
    // the `:` false-arm. A bare toContain would pass even if the branches were
    // swapped (both strings exist either way), so match the ternary shape.
    // `transitionClass` is the literal (regex-escaped) transition utility: the
    // spacer animates width via `transition-[width]`, the wrapper slides via
    // `transition-transform`.
    const ternary = (transitionClass: string): RegExp =>
      new RegExp(
        `showAssistant\\s*\\?\\s*"${transitionClass} duration-\\[var\\(--duration-200\\)\\] ease-\\[var\\(--ease-out-expo\\)\\][^"]*"\\s*:\\s*"${transitionClass} duration-\\[var\\(--duration-120\\)\\] ease-\\[var\\(--ease-panel-minimize\\)\\]`
      );
    // The spacer (width push) and the wrapper (transform slide) must carry
    // identical timing per direction or the push and slide visibly desync.
    expect(slide).toMatch(ternary("transition-\\[width\\]"));
    expect(slide).toMatch(ternary("transition-transform"));
    // The old symmetric 250ms is gone from the assistant slide (it remains
    // correct for the sidebar above this region).
    expect(slide).not.toContain("--duration-250");
  });

  it("settles inert/repaint itself for every path that suppresses the transition", () => {
    // reduce-animations, performance mode, OS prefers-reduced-motion, and an
    // in-flight drag-resize all strip the transform transition, so no
    // transitionend arrives — the effect must settle inert + repaint on its own.
    const settle = source.match(/const settle = \(\) => \{([\s\S]*?)\n {4}\};/);
    expect(settle).not.toBeNull();
    expect(settle![1]).toContain("reduceAnimations");
    expect(settle![1]).toContain("layout.performanceMode");
    expect(settle![1]).toContain("isAssistantResizing");
    expect(settle![1]).toContain("mql?.matches === true");
    // This path only ever runs on a show, so it settles the obligation as shown —
    // but NOT during a drag-resize. A drag also strips the transition, and the
    // reveal repaint's reconcileGeometryFresh is lock-exempt, so settling there
    // would assert geometry mid-drag against the lock that keeps the handle
    // tracking the cursor 1:1. The drag owns its own geometry.
    expect(settle![1]).toContain(
      "if (noTransition && !isAssistantResizing) assistantReveal.settleAfterTransition(true)"
    );
    // The media query is subscribed so an OS reduced-motion flip mid-slide still
    // parks the wrapper inert (the read alone would not re-run).
    expect(source).toContain('mql?.addEventListener("change", settle)');
    expect(source).toContain('mql?.removeEventListener("change", settle)');
  });
});
