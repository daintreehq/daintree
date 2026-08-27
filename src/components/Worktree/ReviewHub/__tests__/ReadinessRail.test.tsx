/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReadinessRail } from "../ReadinessRail";
import type { ReviewReadinessItem, ReviewReadinessSummary } from "../reviewReadiness";

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The app mounts a single `TooltipProvider` in `App.tsx`; the rail's truncation
 *  tooltip relies on it, so an isolated render has to supply one too. */
const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const makeSummary = (overrides?: Partial<ReviewReadinessSummary>): ReviewReadinessSummary => ({
  level: "ready",
  commitReady: true,
  pushReady: false,
  prReady: "unknown",
  blockers: [],
  warnings: [],
  infos: [],
  nextActions: [],
  ...overrides,
});

const item = (overrides: Partial<ReviewReadinessItem> & Pick<ReviewReadinessItem, "id">) =>
  ({
    severity: "info",
    label: `label ${overrides.id}`,
    ...overrides,
  }) as ReviewReadinessItem;

/** The severity glyph the strip leads with, as markup — so a test can ask whether two
 *  severities are distinguishable without reading a colour off a class name. */
function leadGlyph(): string {
  const svg = screen.getByTestId("review-readiness-level").querySelector("svg");
  expect(svg, "the strip must lead with a severity glyph").not.toBeNull();
  return svg!.innerHTML;
}

function openDisclosure() {
  fireEvent.click(screen.getByTestId("review-readiness-overflow"));
}

describe("ReadinessRail", () => {
  it("renders nothing while readiness is unknown", () => {
    render(<ReadinessRail summary={makeSummary({ level: "unknown" })} onCta={vi.fn()} />);
    expect(screen.queryByTestId("review-readiness-rail")).toBeNull();
  });

  it("renders nothing when no condition is worth reporting", () => {
    // A clean worktree is announced by the hub's own empty state. The strip must not
    // spend a row — or a success colour — restating it.
    render(<ReadinessRail summary={makeSummary({ level: "ready" })} onCta={vi.fn()} />);
    expect(screen.queryByTestId("review-readiness-rail")).toBeNull();
  });

  it("leads with the highest-priority condition whatever order the summary lists", () => {
    const summary = makeSummary({
      level: "blocked",
      infos: [item({ id: "no-remote" })],
      warnings: [item({ id: "behind-remote", severity: "warning" })],
      blockers: [item({ id: "conflicts", severity: "blocker" })],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);

    const rail = screen.getByTestId("review-readiness-rail");
    const onStrip = within(rail)
      .queryAllByTestId(/^readiness-item-/)
      .map((el) => el.dataset.testid ?? el.getAttribute("data-testid"));
    expect(onStrip).toEqual(["readiness-item-conflicts"]);
  });

  it("keeps every other condition reachable, with its action, from the disclosure", () => {
    // The regression this pins: the overflow used to be a `title` attribute, so a
    // hidden condition's CTA could not be reached at all.
    const onCta = vi.fn();
    const summary = makeSummary({
      level: "blocked",
      blockers: [item({ id: "conflicts", severity: "blocker" })],
      warnings: [
        item({ id: "behind-remote", severity: "warning", action: { kind: "pull-rebase" } }),
      ],
      infos: [item({ id: "no-remote", label: "No remote configured" })],
    });
    render(<ReadinessRail summary={summary} onCta={onCta} />);

    expect(screen.queryByTestId("readiness-item-behind-remote")).toBeNull();

    openDisclosure();

    expect(screen.getByTestId("readiness-item-behind-remote")).toBeDefined();
    expect(screen.getByText("No remote configured")).toBeDefined();

    fireEvent.click(screen.getByTestId("readiness-cta-behind-remote"));
    expect(onCta).toHaveBeenCalledWith({ kind: "pull-rebase" });
  });

  it("gives the disclosure a real control and an accessible name that counts the rest", () => {
    const summary = makeSummary({
      level: "blocked",
      blockers: [item({ id: "conflicts", severity: "blocker" })],
      infos: [item({ id: "no-remote" }), item({ id: "pr-missing" })],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);

    const trigger = screen.getByTestId("review-readiness-overflow");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toContain("2 more");

    openDisclosure();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("omits the disclosure when the leading condition is the only one", () => {
    const summary = makeSummary({
      level: "needs-review",
      warnings: [item({ id: "generated-only", severity: "warning" })],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);
    expect(screen.queryByTestId("review-readiness-overflow")).toBeNull();
  });

  it("distinguishes severities by shape, not by colour alone", () => {
    // Colour is erased by `forced-colors: active`; a glyph stroked in currentColor
    // is not. Two severities that render the same markup would be indistinguishable
    // there, so the shapes must actually differ.
    const glyphs = new Set<string>();
    for (const [level, severity] of [
      ["blocked", "blocker"],
      ["needs-review", "warning"],
      ["ready", "info"],
    ] as const) {
      render(
        <ReadinessRail
          summary={makeSummary({ level, [`${severity}s`]: [item({ id: "conflicts", severity })] })}
          onCta={vi.fn()}
        />
      );
      glyphs.add(leadGlyph());
      cleanup();
    }
    expect(glyphs.size).toBe(3);
  });

  it("keeps the condition and its detail in separate elements", () => {
    // They are separated by weight and colour rather than punctuation, which means
    // they must be separately styleable — and it is the weight difference that
    // survives `prefers-contrast: more`.
    const summary = makeSummary({
      level: "needs-review",
      warnings: [
        item({
          id: "behind-remote",
          severity: "warning",
          label: "Behind remote",
          detail: "2 commits",
        }),
      ],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);

    const row = screen.getByTestId("readiness-item-behind-remote");
    const label = screen.getByText("Behind remote");
    const detail = screen.getByText("2 commits");
    expect(label).not.toBe(detail);
    expect(row.textContent).toContain("2 commits");
  });

  it("dispatches the leading condition's own action and omits the button when absent", () => {
    const onCta = vi.fn();
    render(
      <ReadinessRail
        summary={makeSummary({
          level: "needs-review",
          warnings: [
            item({ id: "behind-remote", severity: "warning", action: { kind: "pull-rebase" } }),
          ],
        })}
        onCta={onCta}
      />
    );
    fireEvent.click(screen.getByTestId("readiness-cta-behind-remote"));
    expect(onCta).toHaveBeenCalledWith({ kind: "pull-rebase" });

    cleanup();
    render(
      <ReadinessRail
        summary={makeSummary({
          level: "needs-review",
          warnings: [item({ id: "generated-only", severity: "warning" })],
        })}
        onCta={onCta}
      />
    );
    expect(screen.queryByTestId("readiness-cta-generated-only")).toBeNull();
  });

  it("labels the rail as a group and announces each level through a status region", () => {
    const announced = new Set<string>();
    for (const [level, severity] of [
      ["blocked", "blocker"],
      ["needs-review", "warning"],
      ["ready", "info"],
    ] as const) {
      render(
        <ReadinessRail
          summary={makeSummary({ level, [`${severity}s`]: [item({ id: "conflicts", severity })] })}
          onCta={vi.fn()}
        />
      );
      const rail = screen.getByTestId("review-readiness-rail");
      expect(rail.getAttribute("role")).toBe("group");
      expect(rail.getAttribute("aria-label")).toBe("Review readiness");

      const status = screen.getByTestId("review-readiness-level");
      expect(status.getAttribute("role")).toBe("status");
      expect(status.dataset.level).toBe(level);
      // The level must be *announced* even though the strip no longer paints a
      // verdict chip — and each level must announce something different.
      expect(status.textContent?.trim()).toBeTruthy();
      announced.add(status.textContent!.trim());
      cleanup();
    }
    expect(announced.size).toBe(3);
  });
});
