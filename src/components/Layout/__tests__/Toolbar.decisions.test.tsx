// @vitest-environment jsdom
/**
 * The Decisions inbox button (#17236) through the real Toolbar: absent while
 * Decisions is off or not yet known, and while the person has hidden it, and
 * in none of those does it read any question; on, it counts those waiting on
 * the person, in a Remote Host's window too (#18049), and warns of deliveries
 * stopped.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CliAvailability } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import type { DecisionsHostsResult } from "@shared/types/decisionsHosts";
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
  hosts: { result: "not-set-up" } as DecisionsHostsResult,
}));

const REMOTE_HOST = "studio";

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
    listHosts: async () => decisions.hosts,
  },
}));

vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return {
    ...actual,
    isRemoteWindow: () => decisions.remote,
    currentHostId: () => (decisions.remote ? REMOTE_HOST : "local"),
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { actionService } from "@/services/ActionService";
import type { ActionRegistry } from "@/services/actions/actionTypes";
import { registerDecisionsActions } from "@/services/actions/definitions/decisionsActions";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
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
    hosts: { result: "not-set-up" },
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
    // The stopped delivery is named apart and never joins the count (#18045).
    expect(button.getAttribute("aria-label")).toBe(
      "Decisions inbox — 3 questions waiting, 1 delivery stopped"
    );
    const badge = button.querySelector(".toolbar-count")!;
    expect(badge.getAttribute("data-visible")).toBe("true");
    expect(badge.textContent).toBe("3");
    const warning = button.querySelector('[data-testid="decisions-stopped-badge"]')!;
    expect(warning.getAttribute("data-visible")).toBe("true");

    // One answered: it leaves the count, and with no stop left the warning goes.
    await listQuestions(
      2,
      { kind: "settled", outcome: "answered", handled: false },
      { kind: "waiting", reason: "reply" }
    );
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox — 1 question waiting");
    expect(warning.getAttribute("data-visible")).toBe("false");

    await listQuestions(3);
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");
    expect(inboxButton()!.querySelector(".toolbar-count")!.getAttribute("data-visible")).toBe(
      "false"
    );
  });

  it("warns while a delivery stopped on the person's answer, apart from the count (#18045)", async () => {
    await mount();
    await reportStatus("connected");
    const warning = inboxButton()!.querySelector('[data-testid="decisions-stopped-badge"]')!;
    expect(warning.getAttribute("data-visible")).toBe("false");

    // Nothing to answer, only a delivery stopped: the warning without a count.
    await listQuestions(
      1,
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "to-type" }
    );
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox — 1 delivery stopped");
    expect(warning.getAttribute("data-visible")).toBe("true");
    expect(inboxButton()!.querySelector(".toolbar-count")!.getAttribute("data-visible")).toBe(
      "false"
    );

    // Both: the count says the questions, the warning the deliveries, and the name says both.
    await listQuestions(
      2,
      { kind: "waiting", reason: "open" },
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" }
    );
    expect(inboxButton()!.getAttribute("aria-label")).toBe(
      "Decisions inbox — 1 question waiting, 2 deliveries stopped"
    );
    expect(inboxButton()!.querySelector(".toolbar-count")!.textContent).toBe("1");
    expect(warning.getAttribute("data-visible")).toBe("true");
    // The count's top corner is the questions'; the warning takes the bottom one.
    expect(warning.getAttribute("data-pip-corner")).toBe("bottom");

    // Open, the inbox shows them itself, and both marks stand down.
    act(() => useDecisionsInboxStore.setState({ isOpen: true }));
    try {
      await settle();
      expect(warning.getAttribute("data-visible")).toBe("false");
      expect(inboxButton()!.querySelector(".toolbar-count")!.getAttribute("data-visible")).toBe(
        "false"
      );
    } finally {
      cleanup();
      useDecisionsInboxStore.setState({ isOpen: false });
    }
  });

  it("opens the inbox through its action, which the switch the toolbar holds lets run", async () => {
    const registry: ActionRegistry = new Map();
    registerDecisionsActions(registry);
    for (const factory of registry.values()) actionService.register(factory());
    const inboxBefore = useDecisionsInboxStore.getState();
    try {
      const dispatch = vi.spyOn(actionService, "dispatch");
      await mount();
      await reportStatus("connected");
      fireEvent.click(inboxButton()!);
      await settle();
      expect(dispatch).toHaveBeenCalledWith("decisions.openInbox", undefined, { source: "user" });
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    } finally {
      // Unmounted first, so restoring the store re-renders nothing.
      cleanup();
      for (const id of registry.keys()) actionService.unregister(id);
      useDecisionsInboxStore.setState({ isOpen: inboxBefore.isOpen, request: inboxBefore.request });
    }
  });

  it("reads no questions while the person has hidden it, and keeps the hide through on and off", async () => {
    await mount();
    await setPinned(false);
    await reportStatus("connected");
    expect(slot()).toBeNull();
    expect(decisions.questionWatches).toBe(0);

    // Off and back on while hidden: still nothing read.
    await reportStatus("off");
    await reportStatus("connected");
    expect(slot()).toBeNull();
    expect(decisions.questionWatches).toBe(0);

    await setPinned(true);
    expect(inboxButton()).not.toBeNull();
    expect(decisions.questionWatches).toBe(1);
    expect(decisions.onList).not.toBeNull();

    await setPinned(false);
    expect(slot()).toBeNull();
    expect(decisions.onList).toBeNull();
  });

  it("shows in a Remote Host's window, counting every machine's questions and opening once the inbox lists its Host's (#18049)", async () => {
    decisions.remote = true;
    const registry: ActionRegistry = new Map();
    registerDecisionsActions(registry);
    for (const factory of registry.values()) actionService.register(factory());
    const inboxBefore = useDecisionsInboxStore.getState();
    const studio = { hostId: REMOTE_HOST, name: "Studio", connected: true };
    /** This computer's question and Studio's, each waiting or answered. */
    const pushBoth = (revision: number, ownWaits: boolean, studioWaits: boolean) => {
      const answered: DecisionQuestionStanding = {
        kind: "settled",
        outcome: "answered",
        handled: false,
      };
      const open: DecisionQuestionStanding = { kind: "waiting", reason: "open" };
      act(() =>
        decisions.onList?.({
          revision,
          questions: [
            question(1, ownWaits ? open : answered),
            { ...question(2, studioWaits ? open : answered), remoteHost: studio },
          ],
        })
      );
      return settle();
    };
    try {
      await mount();
      expect(slot()).toBeNull();
      await reportStatus("connected");
      await pushBoth(1, true, true);
      expect(inboxButton()!.getAttribute("aria-label")).toBe(
        "Decisions inbox — 2 questions waiting"
      );
      await pushBoth(2, false, true);
      expect(inboxButton()!.getAttribute("aria-label")).toBe(
        "Decisions inbox — 1 question waiting"
      );
      await pushBoth(3, false, false);
      expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");

      // Only another Host's questions listed: nothing opens.
      decisions.hosts = { result: "listed", autoEnroll: true, hosts: [], inboxHostIds: ["lab"] };
      fireEvent.click(inboxButton()!);
      await settle();
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);

      decisions.hosts = {
        result: "listed",
        autoEnroll: true,
        hosts: [],
        inboxHostIds: ["lab", REMOTE_HOST],
      };
      fireEvent.click(inboxButton()!);
      await settle();
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    } finally {
      cleanup();
      for (const id of registry.keys()) actionService.unregister(id);
      useDecisionsInboxStore.setState({ isOpen: inboxBefore.isOpen, request: inboxBefore.request });
    }
  });

  it("holds the switch in a Remote Host's window while the button is hidden, so its actions can run", async () => {
    decisions.remote = true;
    decisions.hosts = {
      result: "listed",
      autoEnroll: true,
      hosts: [],
      inboxHostIds: [REMOTE_HOST],
    };
    const registry: ActionRegistry = new Map();
    registerDecisionsActions(registry);
    for (const factory of registry.values()) actionService.register(factory());
    const inboxBefore = useDecisionsInboxStore.getState();
    try {
      // Hidden before the toolbar mounts, as a saved layout would have it.
      await setPinned(false);
      await mount();
      await reportStatus("connected");
      expect(slot()).toBeNull();
      expect(decisions.statusWatches).toBe(1);
      expect(readDecisionsSwitch()).toBe("on");
      expect(decisions.questionWatches).toBe(0);

      expect(
        (await actionService.dispatch("decisions.openInbox", undefined, { source: "keybinding" }))
          .ok
      ).toBe(true);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    } finally {
      cleanup();
      for (const id of registry.keys()) actionService.unregister(id);
      useDecisionsInboxStore.setState({ isOpen: inboxBefore.isOpen, request: inboxBefore.request });
    }
  });
});

describe("Toolbar's Decisions inbox button folded into `…` (#18045)", () => {
  /** The right-hand row's trigger, which the inbox button folds into. */
  const trigger = () =>
    document.querySelector<HTMLElement>(
      '[data-toolbar-overflow-trigger][data-toolbar-overflow-side="right"]'
    )!;
  const triggerBadge = () => trigger().querySelector('[data-testid="toolbar-overflow-badge"]')!;
  const triggerWarning = () =>
    trigger().querySelector('[data-testid="toolbar-overflow-decisions-warning"]')!;
  const folded = () => slot()?.getAttribute("aria-hidden") === "true";

  /** Every button 40px wide, and the right-hand row `rowWidth` wide. */
  function squeezeRightRow(rowWidth: number): void {
    vi.restoreAllMocks();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const right =
        this.classList.contains("toolbar-measured-row") && this.classList.contains("justify-end");
      const width = this.classList.contains("toolbar-divider") ? 1 : right ? rowWidth : 5000;
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
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.hasAttribute("data-toolbar-button-id") ? 40 : 0;
    });
  }

  afterEach(() => {
    useDecisionsInboxStore.setState({ isOpen: false });
  });

  it("carries the warning to the trigger, and keeps it beside a louder waiting mark", async () => {
    squeezeRightRow(1);
    await mount();
    await reportStatus("connected");
    expect(folded()).toBe(true);
    expect(trigger().getAttribute("aria-label")).not.toMatch(/question|delivery/);

    await listQuestions(1, { kind: "needs-attention", deliveryStatus: "needs-attention" });
    expect(trigger().getAttribute("aria-label")).toMatch(/, 1 delivery stopped(,|$)/);
    expect(triggerBadge().getAttribute("data-severity")).toBe("warning");
    expect(triggerBadge().getAttribute("data-visible")).toBe("true");
    expect(triggerWarning().getAttribute("data-visible")).toBe("false");

    await listQuestions(
      2,
      { kind: "waiting", reason: "open" },
      { kind: "needs-attention", deliveryStatus: "needs-attention" }
    );
    expect(trigger().getAttribute("aria-label")).toMatch(
      /, 1 question waiting, 1 delivery stopped(,|$)/
    );
    expect(triggerBadge().getAttribute("data-severity")).toBe("waiting");
    expect(triggerWarning().getAttribute("data-visible")).toBe("true");

    // The inbox open shows them itself: the trigger says nothing of them.
    act(() => useDecisionsInboxStore.setState({ isOpen: true }));
    await settle();
    expect(trigger().getAttribute("aria-label")).not.toMatch(/question|delivery/);
    expect(triggerWarning().getAttribute("data-visible")).toBe("false");
  });

  it("holds its place on a squeezed strip while a delivery stopped, as a waiting question does", async () => {
    // Room for two buttons: the voice slot's, which outranks every signal, and one more.
    squeezeRightRow(82);
    await mount();
    await reportStatus("connected");
    await listQuestions(1);
    expect(folded()).toBe(true);

    await listQuestions(2, { kind: "needs-attention", deliveryStatus: "needs-attention" });
    expect(folded()).toBe(false);

    await listQuestions(3);
    expect(folded()).toBe(true);
  });
});
