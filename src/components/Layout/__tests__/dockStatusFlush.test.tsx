// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

import { usePanelStore } from "@/store/panelStore";
import { useBackgroundedTerminals } from "@/hooks/useTerminalSelectors";

function backgrounded(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "background",
    ...overrides,
  } as PtyPanelData;
}

function seed(panels: PanelInstance[]) {
  usePanelStore.setState({
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  });
}

// What `flushPanelStatusBuffer` does for a streaming agent: a new map and a new
// record for the panel, with only the buffer's fields touched.
function flushActivity(id: string, headline: string) {
  act(() => {
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        [id]: { ...state.panelsById[id]!, activityHeadline: headline } as PanelInstance,
      },
    }));
  });
}

describe("closed pill lists across status flushes (#17053)", () => {
  let renders = 0;
  let latest: PanelInstance[] = [];

  function Probe({ live }: { live: boolean }) {
    renders += 1;
    latest = useBackgroundedTerminals(live);
    return null;
  }

  beforeEach(() => {
    renders = 0;
    latest = [];
    seed([backgrounded("a"), backgrounded("b")]);
  });

  it("does not render a closed pill when a member's activity is rewritten", () => {
    render(<Probe live={false} />);
    const settled = renders;

    flushActivity("a", "Reading files");
    flushActivity("a", "Editing files");
    flushActivity("b", "Running tests");

    expect(renders).toBe(settled);
  });

  it("renders an open pill on the same writes, so its rows stay live", () => {
    render(<Probe live />);
    const settled = renders;

    flushActivity("a", "Reading files");

    expect(renders).toBeGreaterThan(settled);
    expect((latest[0] as PtyPanelData).activityHeadline).toBe("Reading files");
  });

  it("still tracks membership while closed", () => {
    render(<Probe live={false} />);
    const settled = renders;

    act(() => seed([backgrounded("a"), backgrounded("b"), backgrounded("c")]));

    expect(renders).toBeGreaterThan(settled);
    expect(latest.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("hands the open pill the latest records when it opens", () => {
    const view = render(<Probe live={false} />);
    flushActivity("a", "Reading files");

    view.rerender(<Probe live />);

    expect((latest[0] as PtyPanelData).activityHeadline).toBe("Reading files");
  });
});
