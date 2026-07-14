// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UI_ANIMATION_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import { NavGroup, NavItem } from "../SettingsDialog";
import type { SettingsTab } from "../settingsTabRegistry";

interface MotionRecord {
  layoutId?: string;
  layout?: unknown;
  transition?: { duration?: number; ease?: unknown };
}

const recorded = vi.hoisted(() => ({ motion: [] as MotionRecord[] }));

// Mirrors the mock in Panel/__tests__/TabButton.test.tsx: render a plain div so
// the indicator is queryable in jsdom, capture the projection props (which
// framer-motion would otherwise swallow rather than forward to the DOM).
vi.mock("framer-motion", () => {
  const MotionSpan = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    ({ children, ...props }, ref) => {
      const { layoutId, layout, transition, ...rest } = props as MotionRecord &
        React.HTMLAttributes<HTMLSpanElement>;
      recorded.motion.push({ layoutId, layout, transition });
      return (
        <span ref={ref} {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>
          {children}
        </span>
      );
    }
  );
  MotionSpan.displayName = "MotionSpan";
  return {
    LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    m: { span: MotionSpan },
  };
});

const INDICATOR = "[data-settings-nav-indicator]";

function indicators(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(INDICATOR));
}

/** The nav tab that currently owns the indicator, or null if none does. */
function indicatorOwner(): string | null {
  const node = document.querySelector<HTMLElement>(INDICATOR);
  return node?.closest("button")?.getAttribute("data-tab") ?? null;
}

/** The projection props of the sole mounted indicator. */
function soleRecord(): MotionRecord {
  expect(recorded.motion).toHaveLength(1);
  return recorded.motion[0]!;
}

/**
 * Two nav groups, mirroring the real dialog: NavItems live in separate NavGroup
 * subtrees rather than as flat siblings, which is exactly the case a shared
 * layoutId has to survive.
 */
function Nav({
  activeTab,
  isSearching = false,
}: {
  activeTab: SettingsTab;
  isSearching?: boolean;
}) {
  const item = (tab: SettingsTab, label: string) => (
    <NavItem
      key={tab}
      tab={tab}
      icon={<svg />}
      label={label}
      activeTab={activeTab}
      isSearching={isSearching}
      onSelect={() => {}}
    />
  );
  return (
    <div role="tablist">
      <NavGroup label="Group one">
        {item("general", "General")}
        {item("keyboard", "Keyboard")}
      </NavGroup>
      <NavGroup label="Group two">
        {item("agents", "Agents")}
        {item("plugins", "Plugins")}
      </NavGroup>
    </div>
  );
}

describe("settings nav active indicator (issue #11164)", () => {
  beforeEach(() => {
    recorded.motion.length = 0;
    delete document.body.dataset.performanceMode;
  });

  afterEach(() => {
    delete document.body.dataset.performanceMode;
  });

  it("mounts a single indicator, owned by the active item", () => {
    render(<Nav activeTab="general" />);

    expect(indicators()).toHaveLength(1);
    expect(indicatorOwner()).toBe("general");
  });

  it("reuses one indicator node across groups rather than one per item", () => {
    // The bug: a per-item marker meant every item could own one. Rendering four
    // items across two groups must still yield exactly one indicator.
    render(<Nav activeTab="agents" />);

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(indicators()).toHaveLength(1);
    expect(indicatorOwner()).toBe("agents");
  });

  it("keeps one shared layoutId when the selection crosses a group boundary", () => {
    // This is the fix. The marker slides only because the node projected out of
    // the old item and the node projected into the new one are the *same*
    // layoutId — a per-item id would unmount and remount instead (the blink).
    const { rerender } = render(<Nav activeTab="general" />);
    const before = soleRecord().layoutId;

    recorded.motion.length = 0;
    rerender(<Nav activeTab="agents" />);
    const after = soleRecord().layoutId;

    expect(indicatorOwner()).toBe("agents");
    expect(after).toBe(before);
  });

  it("gives the global and project scopes separate layoutIds", () => {
    // Search results are not scope-restricted, so activating a project hit can
    // swap scope and tab together. Distinct ids stop the marker from sliding
    // between two unrelated nav trees.
    render(<Nav activeTab="general" />);
    const globalId = soleRecord().layoutId;

    recorded.motion.length = 0;
    render(
      <div role="tablist">
        <NavGroup label="Project">
          <NavItem
            tab="project:general"
            icon={<svg />}
            label="Project general"
            activeTab="project:general"
            isSearching={false}
            onSelect={() => {}}
          />
        </NavGroup>
      </div>
    );
    const projectId = soleRecord().layoutId;

    expect(projectId).not.toBe(globalId);
  });

  it("drops the indicator while searching but leaves the tab selected", () => {
    // `active` is suppressed during search; `selected` is not. The marker keys
    // off the former, ARIA off the latter.
    render(<Nav activeTab="general" isSearching />);

    expect(indicators()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /general/i }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("projects position only, on the shared motion tier", () => {
    // layout="position" keeps the move on the compositor (translate only, no
    // width/height writes). Duration and easing track the shared constants, so
    // retuning the tier moves this with it.
    render(<Nav activeTab="general" />);
    const record = soleRecord();

    expect(record.layout).toBe("position");
    expect(record.transition?.duration).toBe(UI_ANIMATION_DURATION / 1000);
    expect(record.transition?.ease).toBe(EASE_OUT_EXPO_FM);
  });

  it("collapses the slide to zero under performance mode", () => {
    // Performance mode suppresses CSS transitions, but a projection animation
    // is JS writing transforms every frame — CSS can't reach it. The duration
    // has to come from the helper that zeroes out, not the raw tier constant.
    document.body.dataset.performanceMode = "true";

    render(<Nav activeTab="general" />);

    expect(soleRecord().transition?.duration).toBe(0);
  });
});
