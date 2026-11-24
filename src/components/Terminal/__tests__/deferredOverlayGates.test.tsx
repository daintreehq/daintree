// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@shared/types";

const h = vi.hoisted(() => ({
  loads: { cwd: 0, artifacts: 0, empty: 0 },
  mounts: 0,
}));

vi.mock("../UpdateCwdDialog", () => {
  h.loads.cwd++;
  return {
    UpdateCwdDialog: (props: { isOpen: boolean; currentCwd: string }) => (
      <div data-testid="cwd-dialog" data-open={String(props.isOpen)} data-cwd={props.currentCwd} />
    ),
  };
});
vi.mock("../ArtifactOverlay", async () => {
  h.loads.artifacts++;
  const { useState } = await import("react");
  return {
    ArtifactOverlay: ({ terminalId }: { terminalId: string }) => {
      const [mount] = useState(() => ++h.mounts);
      return <div data-testid="artifact-overlay" data-mount={mount} data-terminal={terminalId} />;
    },
  };
});
vi.mock("../ContentGridEmptyState", () => {
  h.loads.empty++;
  return {
    ContentGridEmptyState: (props: { workspaceName: string | null }) => (
      <div data-testid="empty-state" data-workspace={props.workspaceName ?? ""} />
    ),
  };
});

import { UpdateCwdDialogGate } from "../UpdateCwdDialogGate";
import { ArtifactOverlayGate } from "../ArtifactOverlayGate";
import { ContentGridEmptyStateGate } from "../ContentGridEmptyStateGate";
import { __test_resetArtifactStore, removeArtifactsForTerminal } from "@/hooks/useArtifacts";

// Read before any test mounts a gate: the mocks count module evaluations, and a
// module evaluates once per file.
const loadedWithGates = { ...h.loads };

type Detected = (payload: { terminalId: string; artifacts: Artifact[] }) => void;
let detected: Detected | null = null;

beforeEach(() => {
  detected = null;
  vi.stubGlobal("electron", {
    artifact: {
      onDetected: (callback: Detected) => {
        detected = callback;
        return () => {};
      },
    },
  });
});

afterEach(() => {
  cleanup();
  __test_resetArtifactStore();
  vi.unstubAllGlobals();
});

it("loads none of the three with their gates", () => {
  expect(loadedWithGates).toEqual({ cwd: 0, artifacts: 0, empty: 0 });
});

describe("UpdateCwdDialogGate", () => {
  const props = { terminalId: "t1", currentCwd: "/gone", onClose: () => {} };

  it("loads nothing while closed, and the dialog on first open", async () => {
    const loadsBefore = h.loads.cwd;
    const view = render(<UpdateCwdDialogGate {...props} isOpen={false} />);
    await act(async () => {});
    expect(screen.queryByTestId("cwd-dialog")).toBeNull();
    expect(h.loads.cwd).toBe(loadsBefore);

    view.rerender(<UpdateCwdDialogGate {...props} isOpen />);

    const dialog = await screen.findByTestId("cwd-dialog");
    expect(dialog.dataset.open).toBe("true");
    expect(dialog.dataset.cwd).toBe("/gone");
  });

  it("keeps the dialog through a close, so it renders closed rather than vanishing", async () => {
    const view = render(<UpdateCwdDialogGate {...props} isOpen />);
    const dialog = await screen.findByTestId("cwd-dialog");

    view.rerender(<UpdateCwdDialogGate {...props} isOpen={false} />);

    expect(screen.getByTestId("cwd-dialog")).toBe(dialog);
    expect(dialog.dataset.open).toBe("false");
  });
});

describe("ArtifactOverlayGate", () => {
  it("loads the overlay with the terminal's first artifact, not another's", async () => {
    const loadsBefore = h.loads.artifacts;
    render(<ArtifactOverlayGate terminalId="t1" />);
    await act(async () => {});
    act(() => detected?.({ terminalId: "t2", artifacts: [{ id: "x" } as Artifact] }));
    await act(async () => {});
    expect(screen.queryByTestId("artifact-overlay")).toBeNull();
    expect(h.loads.artifacts).toBe(loadsBefore);

    act(() => detected?.({ terminalId: "t1", artifacts: [{ id: "y" } as Artifact] }));

    expect((await screen.findByTestId("artifact-overlay")).dataset.terminal).toBe("t1");
  });

  it("keeps the overlay mounted once its artifacts are gone", async () => {
    render(<ArtifactOverlayGate terminalId="t1" />);
    act(() => detected?.({ terminalId: "t1", artifacts: [{ id: "y" } as Artifact] }));
    const overlay = await screen.findByTestId("artifact-overlay");

    act(() => removeArtifactsForTerminal("t1"));

    expect(screen.getByTestId("artifact-overlay")).toBe(overlay);
  });
});

describe("ContentGridEmptyStateGate", () => {
  it("renders the launcher with the props it was given once loaded", async () => {
    render(
      <ContentGridEmptyStateGate
        hasLaunchTarget
        hasProjectContext
        hasWorktrees={false}
        isWorktreeInitialized={false}
        showProjectPulse={false}
        workspaceName="daintree"
      />
    );

    expect((await screen.findByTestId("empty-state")).dataset.workspace).toBe("daintree");
  });
});
