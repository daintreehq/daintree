// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { ClusterAttentionPill } from "../ClusterAttentionPill";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useClusterAttentionStore } from "@/store/clusterAttentionStore";
import type { ClusterGroup } from "@/hooks/useAgentClusters";

const { useAgentClustersMock } = vi.hoisted(() => ({
  useAgentClustersMock: vi.fn(),
}));

vi.mock("@/hooks/useAgentClusters", () => ({
  useAgentClusters: useAgentClustersMock,
}));

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useClusterAttentionStore.setState({ dismissedSignatures: new Set<string>() });
  useAgentClustersMock.mockReset();
}

function makeCluster(overrides: Partial<ClusterGroup> = {}): ClusterGroup {
  return {
    type: "prompt",
    signature: "prompt:a,b:100",
    memberIds: ["a", "b"],
    count: 2,
    headline: "2 agents need input",
    priority: 1,
    latestStateChange: 100,
    ...overrides,
  };
}

describe("ClusterAttentionPill", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when there is no active cluster", () => {
    useAgentClustersMock.mockReturnValue(null);
    const { container } = render(<ClusterAttentionPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the headline when a cluster is active", () => {
    useAgentClustersMock.mockReturnValue(makeCluster());
    render(<ClusterAttentionPill />);
    expect(screen.getByTestId("cluster-attention-pill")).toBeTruthy();
    expect(screen.getByText("2 agents need input")).toBeTruthy();
  });

  it("exposes cluster type on the pill element", () => {
    useAgentClustersMock.mockReturnValue(makeCluster({ type: "error" }));
    render(<ClusterAttentionPill />);
    const pill = screen.getByTestId("cluster-attention-pill");
    expect(pill.getAttribute("data-cluster-type")).toBe("error");
  });

  it("renders nothing when the cluster's signature is already dismissed", () => {
    useClusterAttentionStore.setState({
      dismissedSignatures: new Set(["prompt:a,b:100"]),
    });
    useAgentClustersMock.mockReturnValue(makeCluster());
    const { container } = render(<ClusterAttentionPill />);
    expect(container.firstChild).toBeNull();
  });

  it("arm button calls armIds with the cluster members", () => {
    useAgentClustersMock.mockReturnValue(makeCluster({ memberIds: ["a", "b", "c"], count: 3 }));
    render(<ClusterAttentionPill />);
    fireEvent.click(screen.getByRole("button", { name: /arm 3 agents/i }));
    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed].sort()).toEqual(["a", "b", "c"]);
  });

  it("dismiss button adds the cluster signature to dismissed set and hides the pill", () => {
    const cluster = makeCluster({ signature: "prompt:x,y:999" });
    useAgentClustersMock.mockReturnValue(cluster);
    const { rerender } = render(<ClusterAttentionPill />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss cluster/i }));

    expect(useClusterAttentionStore.getState().dismissedSignatures.has("prompt:x,y:999")).toBe(
      true
    );

    rerender(<ClusterAttentionPill />);
    expect(screen.queryByTestId("cluster-attention-pill")).toBeNull();
  });

  it("re-surfaces when the cluster signature changes after a prior dismissal", () => {
    const first = makeCluster({ signature: "prompt:a,b:100" });
    useAgentClustersMock.mockReturnValue(first);
    const { rerender } = render(<ClusterAttentionPill />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss cluster/i }));

    rerender(<ClusterAttentionPill />);
    expect(screen.queryByTestId("cluster-attention-pill")).toBeNull();

    const next = makeCluster({ signature: "prompt:a,b:500", latestStateChange: 500 });
    useAgentClustersMock.mockReturnValue(next);
    rerender(<ClusterAttentionPill />);

    expect(screen.getByTestId("cluster-attention-pill")).toBeTruthy();
  });
});
