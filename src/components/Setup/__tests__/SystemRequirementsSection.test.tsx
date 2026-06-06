// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { SystemRequirementsSection } from "../SystemRequirementsSection";
import type { SystemHealthCheckState } from "../useSystemHealthCheck";

const { healthCheckState } = vi.hoisted(() => ({
  healthCheckState: {
    specs: [],
    checkStates: {},
    isChecking: false,
    error: null,
    visibleSpecs: [],
    allDone: true,
    hasFatalFailure: false,
    runCheck: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("framer-motion", () => {
  // Real <div> with forwarded props — a fragment passthrough would drop the
  // inert attribute and silently invalidate the assertions below.
  const Passthrough = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      animate?: unknown;
      initial?: unknown;
      transition?: unknown;
    }
  >(({ children, animate: _a, initial: _i, transition: _t, ...rest }, ref) => (
    <div ref={ref} {...rest}>
      {children}
    </div>
  ));
  return {
    LazyMotion: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
    domAnimation: {},
    useReducedMotion: () => true,
    m: { div: Passthrough },
    motion: { div: Passthrough },
  };
});

vi.mock("../useSystemHealthCheck", () => ({
  useSystemHealthCheck: () => healthCheckState as unknown as SystemHealthCheckState,
}));

vi.mock("../SystemToolsStep", () => ({
  PrerequisiteCard: () => <div data-testid="prerequisite-card-stub" />,
}));

function renderSection() {
  return render(
    <SystemRequirementsSection onFatalFailureChange={vi.fn()} onCheckingChange={vi.fn()} />
  );
}

function getPanel(): HTMLElement {
  const panel = document.getElementById("system-requirements-panel");
  if (!panel) throw new Error("panel not rendered");
  return panel;
}

function getToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(
    'button[aria-controls="system-requirements-panel"]'
  );
  if (!toggle) throw new Error("toggle not rendered");
  return toggle;
}

describe("SystemRequirementsSection collapsed panel inert", () => {
  beforeEach(() => {
    healthCheckState.hasFatalFailure = false;
  });

  it("marks the panel inert when collapsed by default", () => {
    renderSection();
    expect(getPanel().hasAttribute("inert")).toBe(true);
  });

  it("removes inert when the user expands the panel and restores it on re-collapse", () => {
    const { container } = renderSection();
    const toggle = getToggle(container);

    act(() => {
      toggle.click();
    });
    expect(getPanel().hasAttribute("inert")).toBe(false);

    act(() => {
      toggle.click();
    });
    expect(getPanel().hasAttribute("inert")).toBe(true);
  });

  it("keeps the panel interactive when a fatal failure forces it open", () => {
    healthCheckState.hasFatalFailure = true;
    renderSection();
    expect(getPanel().hasAttribute("inert")).toBe(false);
  });

  it("removes inert when a fatal failure arrives after mount", () => {
    const { container, rerender } = renderSection();
    expect(getPanel().hasAttribute("inert")).toBe(true);

    healthCheckState.hasFatalFailure = true;
    rerender(
      <SystemRequirementsSection onFatalFailureChange={vi.fn()} onCheckingChange={vi.fn()} />
    );
    expect(getPanel().hasAttribute("inert")).toBe(false);
    expect(getToggle(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("restores inert when a fatal failure clears and the user never expanded", () => {
    healthCheckState.hasFatalFailure = true;
    const { container, rerender } = renderSection();
    expect(getPanel().hasAttribute("inert")).toBe(false);

    healthCheckState.hasFatalFailure = false;
    rerender(
      <SystemRequirementsSection onFatalFailureChange={vi.fn()} onCheckingChange={vi.fn()} />
    );
    expect(getPanel().hasAttribute("inert")).toBe(true);
    expect(getToggle(container).getAttribute("aria-expanded")).toBe("false");
  });
});
