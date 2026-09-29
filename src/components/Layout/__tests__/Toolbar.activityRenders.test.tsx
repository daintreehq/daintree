// @vitest-environment jsdom
/**
 * Activity/headline flushes replace a panel object in `panelsById` on every
 * frame while agents stream. None of those fields is drawn by the toolbar, so
 * they must not re-render it; an agent-state change the toolbar does draw
 * still must. Mounts the real Toolbar and drives the real panelStatusBuffer.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CliAvailability, AgentSettings } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

const toolbarRenders = vi.hoisted(() => ({ count: 0 }));

// Called exactly once per Toolbar render, so it doubles as the render counter.
vi.mock("@/hooks/useToolbarOverflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useToolbarOverflow")>();
  return {
    ...actual,
    useToolbarOverflow: (...args: Parameters<typeof actual.useToolbarOverflow>) => {
      toolbarRenders.count++;
      return actual.useToolbarOverflow(...args);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { enqueueActivityUpdate, flushPanelStatusBuffer } from "@/store/panelStatusBuffer";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PREVIEW_PROJECT } from "../__preview__/toolbarShims";
import { Toolbar } from "../Toolbar";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";

const AGENTS = ["claude", "codex", "gemini"] as const;

function agentPanel(id: string, agentId: string): PtyPanelData {
  return {
    id,
    title: agentId,
    kind: "terminal",
    cwd: PREVIEW_PROJECT.path,
    cols: 120,
    rows: 40,
    worktreeId: "wt-main",
    location: "grid",
    hasPty: true,
    detectedAgentId: agentId,
    launchAgentId: agentId,
    agentState: "working",
    runtimeStatus: "running",
  } as PtyPanelData;
}

const noop = () => {};

function Harness(props: { availability: CliAvailability; settings: AgentSettings }) {
  // The real hook, wired as AppLayout wires it.
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <Toolbar
      onLaunchAgent={noop}
      onSettings={noop}
      hasWorkspace
      agentAvailability={props.availability}
      agentSettings={props.settings}
      projectSwitcherPalette={projectSwitcherPalette}
    />
  );
}

beforeEach(async () => {
  initBuiltInPanelKinds();
  const worktreeStore = createWorktreeStore();
  worktreeStore.setState({
    worktrees: new Map([
      [
        "wt-main",
        {
          id: "wt-main",
          worktreeId: "wt-main",
          path: PREVIEW_PROJECT.path,
          name: "main",
          branch: "develop",
          isCurrent: true,
          isMainWorktree: true,
        },
      ],
    ]),
  } as never);
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
  const availability = Object.fromEntries(AGENTS.map((id) => [id, "ready"])) as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });
  const settings = {
    agents: Object.fromEntries(AGENTS.map((id) => [id, { pinned: true }])),
  } as AgentSettings;
  useAgentSettingsStore.setState({ settings });

  const panels = AGENTS.map((agentId, i) => agentPanel(`pane-${i}`, agentId));
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { "wt-main": panels.map((p) => p.id) },
  });

  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Harness availability={availability} settings={settings} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
  toolbarRenders.count = 0;
});

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Toolbar under activity-only panel churn", () => {
  it("does not re-render for activity headline flushes", async () => {
    for (let frame = 0; frame < 30; frame++) {
      act(() => {
        AGENTS.forEach((_, i) => {
          enqueueActivityUpdate(`pane-${i}`, `headline ${frame}`, "working", "interactive", "");
        });
        flushPanelStatusBuffer();
      });
    }
    await settle();

    expect(usePanelStore.getState().panelsById["pane-0"]).toMatchObject({
      activityHeadline: "headline 29",
    });
    expect(toolbarRenders.count).toBe(0);
  });

  // Proves the counter sees real renders, so the zero above is not vacuous. The
  // overflow hooks' outputs are covered in useOverflowBadgeSeverity.test.ts.
  it("still re-renders when an agent pip state changes", async () => {
    act(() => {
      usePanelStore.setState((s) => ({
        panelsById: {
          ...s.panelsById,
          "pane-0": { ...s.panelsById["pane-0"]!, agentState: "waiting" } as PtyPanelData,
        },
      }));
    });
    await settle();
    expect(toolbarRenders.count).toBeGreaterThan(0);
  });
});
