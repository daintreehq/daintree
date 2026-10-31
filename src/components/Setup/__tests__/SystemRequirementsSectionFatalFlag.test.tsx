// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import type { PrerequisiteCheckResult, PrerequisiteSpec } from "@shared/types";
import { SystemRequirementsSection } from "../SystemRequirementsSection";

const { getHealthCheckSpecs, checkTool } = vi.hoisted(() => ({
  getHealthCheckSpecs: vi.fn(),
  checkTool: vi.fn(),
}));

vi.mock("@/clients", () => ({ systemClient: { getHealthCheckSpecs, checkTool } }));

vi.mock("framer-motion", () => {
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

vi.mock("../SystemToolsStep", () => ({
  PrerequisiteCard: () => <div data-testid="prerequisite-card-stub" />,
}));

// The real hook and section run against these: the wizard's Continue gate is
// whatever `onFatalFailureChange` last reported, so this is the path an
// "only Node is missing" machine takes.
const GIT: PrerequisiteSpec = {
  tool: "git",
  label: "Git",
  versionArgs: ["--version"],
  severity: "fatal",
};
const NODE: PrerequisiteSpec = {
  tool: "node",
  label: "Node.js",
  versionArgs: ["--version"],
  severity: "warn",
  minVersion: "18.0.0",
};

function result(spec: PrerequisiteSpec, available: boolean): PrerequisiteCheckResult {
  return {
    tool: spec.tool,
    label: spec.label,
    available,
    version: available ? "20.0.0" : null,
    severity: spec.severity,
    meetsMinVersion: available,
    minVersion: spec.minVersion,
  };
}

function machine(present: Record<string, boolean>) {
  getHealthCheckSpecs.mockResolvedValue([GIT, NODE]);
  checkTool.mockImplementation(async (spec: PrerequisiteSpec) =>
    result(spec, present[spec.tool] ?? false)
  );
}

async function settledFatalFlag(): Promise<boolean | undefined> {
  const onFatalFailureChange = vi.fn();
  const view = render(
    <SystemRequirementsSection
      onFatalFailureChange={onFatalFailureChange}
      onCheckingChange={vi.fn()}
    />
  );
  await waitFor(() => expect(view.container.textContent).toMatch(/\d+ of \d+ tools ready/));
  return onFatalFailureChange.mock.calls.at(-1)?.[0];
}

describe("SystemRequirementsSection — what blocks the wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("reports no fatal failure when only Node.js is missing", async () => {
    machine({ git: true, node: false });

    expect(await settledFatalFlag()).toBe(false);
    expect(document.body.textContent).toContain("Warning: 1 of 2 tools ready");
  });

  it("reports a fatal failure when Git is missing, even with Node.js present", async () => {
    machine({ git: false, node: true });

    expect(await settledFatalFlag()).toBe(true);
    expect(document.body.textContent).toContain("Action required: 1 of 2 tools ready");
  });
});
