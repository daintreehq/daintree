// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

const { useAgentClustersMock } = vi.hoisted(() => ({
  useAgentClustersMock: vi.fn(),
}));

vi.mock("@/hooks/useAgentClusters", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useAgentClusters")>(
    "@/hooks/useAgentClusters"
  );
  return {
    ...actual,
    useAgentClusters: useAgentClustersMock,
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="fleet-smart-arm-bar-tooltip">{children}</div>
  ),
}));

import { FleetSmartArmBar } from "../FleetSmartArmBar";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import type { ClusterGroup, ClusterType } from "@/hooks/useAgentClusters";

function makeCluster(overrides: Partial<ClusterGroup> = {}): ClusterGroup {
  const type: ClusterType = overrides.type ?? "prompt";
  const memberIds = overrides.memberIds ?? ["a", "b"];
  return {
    type,
    memberIds,
    count: overrides.count ?? memberIds.length,
    headline: overrides.headline ?? `${memberIds.length} agents need input`,
    priority: overrides.priority ?? 1,
    latestStateChange: overrides.latestStateChange ?? 1,
    signature: overrides.signature ?? `${type}:${memberIds.join(",")}:1`,
  };
}

function resetStore() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
}

describe("FleetSmartArmBar", () => {
  beforeEach(() => {
    resetStore();
    useAgentClustersMock.mockReset();
    document.body.innerHTML = "";
  });

  it("renders nothing when no cluster is active", () => {
    useAgentClustersMock.mockReturnValue(null);
    render(<FleetSmartArmBar />);
    expect(document.querySelector('[data-testid="fleet-smart-arm-bar"]')).toBeNull();
  });

  it("portals the pill to document.body when a cluster is active", () => {
    useAgentClustersMock.mockReturnValue(makeCluster({ type: "prompt", memberIds: ["a", "b"] }));
    const { container } = render(<FleetSmartArmBar />);
    // Component is portaled — its pill should not appear inside the renderer's container.
    expect(container.querySelector('[data-testid="fleet-smart-arm-bar"]')).toBeNull();
    // It should appear inside document.body.
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button).not.toBeNull();
    cleanup();
  });

  it("uses 'Arm N waiting' label for prompt clusters", () => {
    useAgentClustersMock.mockReturnValue(
      makeCluster({ type: "prompt", memberIds: ["a", "b", "c"] })
    );
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button?.getAttribute("aria-label")).toBe("Arm 3 waiting");
    expect(button?.textContent).toContain("Arm 3 waiting");
    cleanup();
  });

  it("uses 'Arm N with errors' label for error clusters", () => {
    useAgentClustersMock.mockReturnValue(
      makeCluster({ type: "error", memberIds: ["a", "b"], priority: 2 })
    );
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button?.getAttribute("aria-label")).toBe("Arm 2 with errors");
    cleanup();
  });

  it("uses 'Arm N finished' label for completion clusters", () => {
    useAgentClustersMock.mockReturnValue(
      makeCluster({ type: "completion", memberIds: ["a", "b"], priority: 3 })
    );
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button?.getAttribute("aria-label")).toBe("Arm 2 finished");
    cleanup();
  });

  it("calls armIds with exactly the cluster member ids on click (does not arm-all)", () => {
    const armIdsSpy = vi.spyOn(useFleetArmingStore.getState(), "armIds");
    useAgentClustersMock.mockReturnValue(
      makeCluster({ type: "prompt", memberIds: ["pane-1", "pane-2", "pane-3"] })
    );
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(armIdsSpy).toHaveBeenCalledTimes(1);
    expect(armIdsSpy).toHaveBeenCalledWith(["pane-1", "pane-2", "pane-3"]);
    expect(useFleetArmingStore.getState().armedIds).toEqual(
      new Set(["pane-1", "pane-2", "pane-3"])
    );
    cleanup();
  });

  it("renders tooltip content describing the heuristic", () => {
    useAgentClustersMock.mockReturnValue(makeCluster({ type: "prompt", memberIds: ["a", "b"] }));
    render(<FleetSmartArmBar />);
    const tooltip = document.body.querySelector('[data-testid="fleet-smart-arm-bar-tooltip"]');
    expect(tooltip?.textContent).toBe("2 terminals waiting for input");
    cleanup();
  });

  it("exposes cluster type and count as data attributes", () => {
    useAgentClustersMock.mockReturnValue(
      makeCluster({ type: "error", memberIds: ["a", "b", "c"], priority: 2 })
    );
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button?.getAttribute("data-cluster-type")).toBe("error");
    expect(button?.getAttribute("data-cluster-count")).toBe("3");
    cleanup();
  });

  it("the always-mounted root has pointer-events disabled to let terminal clicks pass through", () => {
    useAgentClustersMock.mockReturnValue(null);
    render(<FleetSmartArmBar />);
    const root = document.body.querySelector('[data-testid="fleet-smart-arm-bar-root"]');
    expect(root).not.toBeNull();
    expect(root?.className).toContain("pointer-events-none");
    cleanup();
  });

  it("the pill button restores pointer-events so it remains clickable", () => {
    useAgentClustersMock.mockReturnValue(makeCluster({ type: "prompt", memberIds: ["a", "b"] }));
    render(<FleetSmartArmBar />);
    const button = document.body.querySelector('[data-testid="fleet-smart-arm-bar"]');
    expect(button?.className).toContain("pointer-events-auto");
    cleanup();
  });
});
