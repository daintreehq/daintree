// @vitest-environment jsdom
/**
 * The Decisions inbox button (#17236) through the real Toolbar: absent while
 * Decisions is off or not yet known, in a Remote Host's window, and while the
 * person has hidden it, and in none of those does it read any question; on,
 * it counts those waiting on the person.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CliAvailability } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

const decisions = vi.hoisted(() => ({
  onStatus: null as ((status: DecisionsStatus) => void) | null,
  statusWatches: 0,
  onList: null as ((list: DecisionQuestionList) => void) | null,
  questionWatches: 0,
  remote: false,
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: {
    watchStatus: (onStatus: (status: DecisionsStatus) => void) => {
      decisions.statusWatches += 1;
      decisions.onStatus = onStatus;
      return () => {
        decisions.onStatus = null;
      };
    },
    watchQuestions: (onList: (list: DecisionQuestionList) => void) => {
      decisions.questionWatches += 1;
      decisions.onList = onList;
      return () => {
        decisions.onList = null;
      };
    },
  },
}));

vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return { ...actual, isRemoteWindow: () => decisions.remote };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { actionService } from "@/services/ActionService";
import { PREVIEW_PROJECT } from "../__preview__/toolbarShims";
import { Toolbar } from "../Toolbar";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";

const noop = () => {};
const initialLayout = useToolbarPreferencesStore.getState().layout;

function Harness() {
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <Toolbar
      onLaunchAgent={noop}
      onSettings={noop}
      hasWorkspace
      agentAvailability={{} as CliAvailability}
      projectSwitcherPalette={projectSwitcherPalette}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  initBuiltInPanelKinds();
  const worktreeStore = createWorktreeStore();
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Harness />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
}

function reportStatus(state: DecisionsStatus["state"]): Promise<void> {
  act(() => decisions.onStatus?.({ state }));
  return settle();
}

function question(index: number, standing: DecisionQuestionStanding): DecisionQuestionListItem {
  return {
    reference: { hostId: "local", projectId: "p1", terminalId: "t1", questionId: `q${index}` },
    alias: index,
    agentKind: "claude",
    projectLabel: "Project",
    worktreeId: "wt",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-18T00:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
  };
}

function listQuestions(revision: number, ...standings: DecisionQuestionStanding[]): Promise<void> {
  act(() =>
    decisions.onList?.({
      revision,
      questions: standings.map((standing, index) => question(index + 1, standing)),
    })
  );
  return settle();
}

/** The slot the strip gives the button, measuring copy included: null when it has none. */
const slot = () => document.querySelector('[data-toolbar-button-id="decisions-inbox"]');
/** The button as the person reaches it, on the strip. */
const inboxButton = () => screen.queryByRole("button", { name: /^Decisions inbox/ });

function setPinned(shown: boolean): Promise<void> {
  act(() => {
    useToolbarPreferencesStore.setState((state) => ({
      layout: {
        ...state.layout,
        pinnedButtons: { ...state.layout.pinnedButtons, "decisions-inbox": shown },
      },
    }));
  });
  return settle();
}

beforeEach(() => {
  // Room for every button, so the strip holds the inbox button rather than
  // folding it into `…`. A divider keeps its hairline width.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = this.classList.contains("toolbar-divider") ? 1 : 5000;
    return {
      width,
      height: 40,
      top: 0,
      left: 0,
      right: width,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
  Object.assign(decisions, {
    onStatus: null,
    statusWatches: 0,
    onList: null,
    questionWatches: 0,
    remote: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToolbarPreferencesStore.setState({ layout: initialLayout });
});

describe("Toolbar's Decisions inbox button", () => {
  it("has no slot and reads no questions until Decisions is on, and again once it is off", async () => {
    await mount();
    expect(slot()).toBeNull();

    await reportStatus("off");
    expect(slot()).toBeNull();
    expect(decisions.questionWatches).toBe(0);

    await reportStatus("connected");
    expect(inboxButton()).not.toBeNull();
    expect(decisions.onList).not.toBeNull();

    await reportStatus("off");
    expect(slot()).toBeNull();
    expect(decisions.onList).toBeNull();
  });

  it("counts the questions waiting on the person, and nothing else", async () => {
    await mount();
    await reportStatus("connected");
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");

    await listQuestions(
      1,
      { kind: "waiting", reason: "open" },
      { kind: "waiting", reason: "reply" },
      { kind: "queued" },
      { kind: "to-type" },
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "send-failed" },
      { kind: "settled", outcome: "answered", handled: false }
    );
    const button = inboxButton()!;
    expect(button.getAttribute("aria-label")).toBe("Decisions inbox — 3 questions waiting");
    const badge = button.querySelector(".toolbar-count")!;
    expect(badge.getAttribute("data-visible")).toBe("true");
    expect(badge.textContent).toBe("3");

    // One answered: it leaves the count.
    await listQuestions(
      2,
      { kind: "settled", outcome: "answered", handled: false },
      { kind: "waiting", reason: "reply" }
    );
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox — 1 question waiting");

    await listQuestions(3);
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");
    expect(inboxButton()!.querySelector(".toolbar-count")!.getAttribute("data-visible")).toBe(
      "false"
    );
  });

  it("opens the inbox through its action", async () => {
    const dispatch = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true, result: undefined });
    await mount();
    await reportStatus("connected");
    fireEvent.click(inboxButton()!);
    expect(dispatch).toHaveBeenCalledWith("decisions.openInbox", undefined, { source: "user" });
  });

  it("reads no questions while the person has hidden it, and keeps the hide through on and off", async () => {
    await mount();
    await setPinned(false);
    await reportStatus("connected");
    expect(slot()).toBeNull();
    expect(decisions.questionWatches).toBe(0);

    await setPinned(true);
    expect(inboxButton()).not.toBeNull();
    expect(decisions.onList).not.toBeNull();

    await setPinned(false);
    expect(slot()).toBeNull();
    expect(decisions.onList).toBeNull();
  });

  it("is absent from a Remote Host's window, which watches neither the switch nor the questions", async () => {
    decisions.remote = true;
    await mount();
    expect(slot()).toBeNull();
    expect(decisions.statusWatches).toBe(0);
    expect(decisions.questionWatches).toBe(0);
  });
});
