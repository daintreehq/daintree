// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

interface FakeAction {
  id: string;
  title: string;
  danger: "safe" | "confirm" | "restricted";
  enabled: boolean;
  disabledReason?: string;
  denyPlugin?: boolean;
  selfNotifies?: boolean;
}

const actions = vi.hoisted(() => new Map<string, FakeAction>());
const dispatch = vi.hoisted(() =>
  vi.fn(
    (): Promise<
      { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
    > => Promise.resolve({ ok: true, result: undefined })
  )
);
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch,
    get: (id: string) => {
      const action = actions.get(id);
      return action
        ? {
            id: action.id,
            title: action.title,
            danger: action.danger,
            enabled: action.enabled,
            disabledReason: action.disabledReason,
          }
        : null;
    },
    getTitle: (id: string) => actions.get(id)?.title ?? "",
    deniesPluginDispatch: (id: string) => actions.get(id)?.denyPlugin === true,
    selfNotifiesOnExecutionError: (id: string) => actions.get(id)?.selfNotifies === true,
  },
}));

import * as kit from "@daintreehq/plugin-ui";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import { snapshotLines } from "@/components/PluginKit/PluginKitNativeAgents";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keybindingService } from "@/services/KeybindingService";
import { useNotificationStore } from "@/store/notificationStore";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

const combos = new Map<string, string>();

beforeEach(() => {
  actions.clear();
  combos.clear();
  dispatch.mockClear();
  dispatch.mockImplementation(() => Promise.resolve({ ok: true, result: undefined }));
  vi.spyOn(keybindingService, "getEffectiveCombo").mockImplementation((id: string) =>
    combos.get(id)
  );
  useNotificationStore.setState({ notifications: [] });
  // A toast only shows in a focused window; jsdom's never is.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function inView(children: ReactNode, owner = "acme.board") {
  return createElement(
    PluginKitOwnerContext.Provider,
    { value: owner },
    createElement(TooltipProvider, null, children)
  );
}

function addAction(action: Partial<FakeAction> & { id: string }) {
  actions.set(action.id, {
    title: "Refresh worktrees",
    danger: "safe",
    enabled: true,
    ...action,
  });
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function toastMessages(): string[] {
  return useNotificationStore.getState().notifications.map((n) => String(n.message));
}

describe("ActionButton", () => {
  it("labels itself with the action's title and runs it as a plugin dispatch", async () => {
    addAction({ id: "worktree.refresh" });
    const onDispatched = vi.fn();
    render(
      inView(
        createElement(kit.ActionButton, {
          actionId: "worktree.refresh",
          args: { force: true },
          onDispatched,
        })
      )
    );
    const button = screen.getByRole("button", { name: "Refresh worktrees" });
    fireEvent.click(button);
    await flush();
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.refresh",
      { force: true },
      { source: "plugin" }
    );
    expect(onDispatched).toHaveBeenCalledWith({ ok: true });
  });

  it("names the user's binding for it to assistive tech", () => {
    addAction({ id: "worktree.refresh" });
    combos.set("worktree.refresh", "Cmd+Shift+R");
    render(inView(createElement(kit.ActionButton, { actionId: "worktree.refresh" })));
    expect(screen.getByRole("button").getAttribute("aria-keyshortcuts")).toMatch(/Shift\+R$/);
  });

  it("draws a disabled action focusable and unavailable, with its reason, and never runs it", async () => {
    addAction({ id: "worktree.refresh", enabled: false, disabledReason: "No worktree is open" });
    render(inView(createElement(kit.ActionButton, { actionId: "worktree.refresh" })));
    const button = screen.getByRole("button", { name: "Refresh worktrees" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("No worktree is open");
    fireEvent.click(button);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses what a plugin cannot run, and keeps a restricted action out of sight", () => {
    addAction({ id: "worktree.delete", title: "Delete worktree", danger: "confirm" });
    addAction({ id: "app.quit", title: "Quit", danger: "restricted" });
    addAction({ id: "terminal.sendCommand", title: "Send command", denyPlugin: true });
    render(
      inView(
        createElement(
          "div",
          null,
          createElement(kit.ActionButton, { actionId: "worktree.delete" }),
          createElement(kit.ActionButton, { actionId: "app.quit" }),
          createElement(kit.ActionButton, { actionId: "terminal.sendCommand" })
        )
      )
    );
    const reasonOf = (name: string) => {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;
    };
    expect(reasonOf("Delete worktree")).toMatch(/confirmation/);
    expect(reasonOf("Send command")).toMatch(/Plugins can't run/);
    // host.actions.get answers null for a restricted action; so does the kit.
    expect(screen.queryByRole("button", { name: "Quit" })).toBeNull();
    expect(document.body.textContent).not.toContain("Quit");
  });

  it("keeps the author's own name and description beside the refusal reason", () => {
    addAction({ id: "worktree.refresh", enabled: false, disabledReason: "Offline" });
    render(
      inView(
        createElement(
          "div",
          null,
          createElement("span", { id: "hint" }, "Refreshes every worktree"),
          createElement(kit.ActionButton, {
            actionId: "worktree.refresh",
            "aria-label": "Refresh all",
            "aria-describedby": "hint",
          })
        )
      )
    );
    const button = screen.getByRole("button", { name: "Refresh all" });
    const described = (button.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Refreshes every worktree", "Offline"]);
  });

  it("leaves a failure the action reported itself alone, and reports nothing after unmount", async () => {
    addAction({ id: "files.open", title: "Open file", selfNotifies: true });
    addAction({ id: "worktree.refresh" });
    dispatch.mockImplementation(() =>
      Promise.resolve({ ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } })
    );
    const onDispatched = vi.fn();
    const { unmount } = render(
      inView(
        createElement(
          "div",
          null,
          createElement(kit.ActionButton, { actionId: "files.open" }),
          createElement(kit.ActionButton, { actionId: "worktree.refresh", onDispatched })
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await flush();
    expect(toastMessages()).toEqual([]);

    let settle: (value: { ok: true; result: unknown }) => void = () => {};
    dispatch.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Refresh worktrees" }));
    unmount();
    settle({ ok: true, result: undefined });
    await flush();
    expect(onDispatched).not.toHaveBeenCalled();
  });

  it("contains a throwing onDispatched", async () => {
    addAction({ id: "worktree.refresh" });
    const onDispatched = vi.fn(() => {
      throw new Error("plugin bug");
    });
    render(inView(createElement(kit.ActionButton, { actionId: "worktree.refresh", onDispatched })));
    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(onDispatched).toHaveBeenCalledTimes(1);
    // The button settled rather than staying busy behind the throw.
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBeNull();
  });

  it("hides an unavailable action on request, and an unknown one with no label of its own", () => {
    addAction({ id: "worktree.refresh", enabled: false });
    render(
      inView(
        createElement(
          "div",
          { "data-testid": "row" },
          createElement(kit.ActionButton, {
            actionId: "worktree.refresh",
            whenUnavailable: "hide",
          }),
          createElement(kit.ActionButton, { actionId: "future.action" }),
          createElement(kit.ActionButton, { actionId: "future.labelled" }, "Open later")
        )
      )
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Open later");
    expect(buttons[0]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("disables on the plugin's own terms, and draws an icon-only button named by the title", () => {
    addAction({ id: "worktree.refresh" });
    render(
      inView(
        createElement(
          "div",
          null,
          createElement(kit.ActionButton, {
            actionId: "worktree.refresh",
            icon: "refresh",
            iconOnly: true,
          }),
          createElement(
            kit.ActionButton,
            { actionId: "worktree.refresh", disabled: true, disabledReason: "Still syncing" },
            "Sync"
          )
        )
      )
    );
    expect(screen.getByRole("button", { name: "Refresh worktrees" }).textContent).toBe("");
    const sync = screen.getByRole("button", { name: "Sync" });
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(sync.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Still syncing"
    );
  });

  it("says a failed run in the plugin's name when nobody asked for the outcome", async () => {
    addAction({ id: "worktree.refresh" });
    dispatch.mockImplementation(() =>
      Promise.resolve({ ok: false, error: { code: "EXECUTION_ERROR", message: "git is busy" } })
    );
    render(inView(createElement(kit.ActionButton, { actionId: "worktree.refresh" })));
    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(toastMessages().some((m) => m.includes("git is busy"))).toBe(true);
  });

  it("ignores hostile props rather than throwing", () => {
    addAction({ id: "worktree.refresh" });
    render(
      inView(
        createElement(
          "div",
          { "data-testid": "row" },
          untyped("ActionButton", { actionId: 42 }),
          untyped("ActionButton", {
            actionId: "worktree.refresh",
            variant: "neon",
            size: 9,
            whenUnavailable: "explode",
            onDispatched: "nope",
          })
        )
      )
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("action menu entries", () => {
  function menu(items: kit.DropdownMenuEntry[]) {
    return inView(
      createElement(kit.ContextMenu, {
        items,
        children: createElement("div", { "data-testid": "row" }, "Row"),
      })
    );
  }

  it("draws the action's title and binding, and runs it when chosen", async () => {
    addAction({ id: "worktree.refresh" });
    combos.set("worktree.refresh", "Cmd+R");
    render(menu([{ type: "action", actionId: "worktree.refresh", icon: "refresh" }]));
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 4, clientY: 4 });
    const item = await screen.findByRole("menuitem", { name: /Refresh worktrees/ });
    expect(item.querySelector("[data-menu-icon]")).not.toBeNull();
    fireEvent.click(item);
    await flush();
    expect(dispatch).toHaveBeenCalledWith("worktree.refresh", undefined, { source: "plugin" });
  });

  it("disables a row the action refuses, with the reason as its second line", async () => {
    addAction({
      id: "panel.close",
      title: "Close panel",
      enabled: false,
      disabledReason: "Nothing to close",
    });
    addAction({ id: "worktree.refresh", enabled: false });
    render(
      menu([
        { type: "action", actionId: "panel.close" },
        { type: "action", actionId: "worktree.refresh", whenUnavailable: "hide" },
        { type: "action", actionId: "unknown.action" },
      ])
    );
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 4, clientY: 4 });
    const item = await screen.findByRole("menuitem", { name: /Close panel/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("Nothing to close");
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    // The row's name fades with the refusal; the reason itself stays readable.
    const faded = (el: Element | null | undefined) =>
      el?.closest("[class*='opacity-50']") !== null &&
      item.contains(el?.closest("[class*='opacity-50']") ?? null);
    const reason = [...item.querySelectorAll("span")].find(
      (span) => span.textContent === "Nothing to close"
    );
    const name = [...item.querySelectorAll("span")].find(
      (span) => span.textContent === "Close panel"
    );
    expect(faded(name)).toBe(true);
    expect(faded(reason)).toBe(false);
  });

  it("leaves out a submenu whose action rows would all be hidden", async () => {
    addAction({ id: "worktree.refresh", enabled: false });
    render(
      menu([
        { label: "Rename", onSelect: () => {} },
        {
          type: "submenu",
          label: "Worktree",
          items: [
            { type: "action", actionId: "worktree.refresh", whenUnavailable: "hide" },
            { type: "action", actionId: "unknown.action" },
          ],
        },
      ])
    );
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 4, clientY: 4 });
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("menuitem", { name: /Worktree/ })).toBeNull();
  });
});

describe("AgentAvatar and AgentBadge", () => {
  it("names the agent from the registry and pips a live state", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.AgentAvatar, { agentId: "claude", state: "waiting", "data-testid": "a" }),
        createElement(kit.AgentAvatar, { agentId: "codex", state: "idle", "data-testid": "b" })
      )
    );
    const waiting = screen.getByTestId("a");
    expect(waiting.getAttribute("aria-label")).toBe("Claude, prompt on screen");
    expect(waiting.querySelector("[data-agent-pip]")?.getAttribute("data-agent-pip")).toBe(
      "waiting"
    );
    const idle = screen.getByTestId("b");
    expect(idle.getAttribute("aria-label")).toBe("Codex");
    expect(idle.querySelector("[data-agent-pip]")).toBeNull();
  });

  it("falls back to the id and the terminal glyph for an agent the registry lacks", () => {
    render(createElement(kit.AgentAvatar, { agentId: "homebrew-cli", "data-testid": "a" }));
    const avatar = screen.getByTestId("a");
    expect(avatar.getAttribute("aria-label")).toBe("homebrew-cli");
    expect(avatar.querySelector("svg")).not.toBeNull();
  });

  it("hides a decorative mark, and draws nothing without an id", () => {
    render(
      createElement(
        "div",
        { "data-testid": "row" },
        createElement(kit.AgentAvatar, { agentId: "claude", decorative: true }),
        untyped("AgentAvatar", { agentId: null })
      )
    );
    const row = screen.getByTestId("row");
    expect(row.children).toHaveLength(1);
    expect(row.children[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the name beside the mark", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.AgentBadge, { agentId: "gemini", state: "waiting", "data-testid": "b" }),
        createElement(kit.AgentBadge, { agentId: "codex", state: "working", "data-testid": "w" })
      )
    );
    const badge = screen.getByTestId("b");
    expect(badge.textContent).toContain("Gemini");
    expect(badge.textContent).toContain("prompt on screen");
    // Only a state that wants a human earns the pip, as on the host toolbar.
    expect(screen.getByTestId("w").querySelector("[data-agent-pip]")).toBeNull();
  });
});

describe("AgentStateIndicator", () => {
  it("words each state as what was seen, never as a conclusion", () => {
    const now = Date.now();
    render(
      createElement(
        "div",
        null,
        createElement(kit.AgentStateIndicator, {
          state: "completed",
          since: now - 2 * 60_000,
          "data-testid": "a",
        }),
        createElement(kit.AgentStateIndicator, {
          state: "working",
          since: now - 5 * 60_000,
          "data-testid": "b",
        }),
        createElement(kit.AgentStateIndicator, {
          state: "working",
          since: now - 5_000,
          "data-testid": "c",
        }),
        createElement(kit.AgentStateIndicator, { state: "exited", "data-testid": "d" })
      )
    );
    expect(screen.getByTestId("a").textContent).toBe("Output stopped 2m ago");
    expect(screen.getByTestId("b").textContent).toBe("Output active for 5m");
    // Under a minute a duration says nothing yet.
    expect(screen.getByTestId("c").textContent).toBe("Output active");
    expect(screen.getByTestId("d").textContent).toBe("Process exited");
    for (const id of ["a", "b", "c", "d"]) {
      expect(screen.getByTestId(id).textContent).not.toMatch(/\bdone\b/i);
    }
  });

  it("names the glyph alone, and takes an unknown state as idle", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.AgentStateIndicator, {
          state: "waiting",
          variant: "glyph",
          "data-testid": "g",
        }),
        untyped("AgentStateIndicator", { state: "thinking", "data-testid": "u" })
      )
    );
    const glyph = screen.getByTestId("g");
    expect(glyph.getAttribute("role")).toBe("img");
    expect(glyph.getAttribute("aria-label")).toBe("Prompt on screen");
    expect(screen.getByTestId("u").getAttribute("data-agent-state")).toBe("idle");
  });
});

describe("AgentPicker", () => {
  const panes = [
    {
      terminalId: "t1",
      title: "Claude: fix auth",
      agentId: "claude",
      worktree: { id: "w-main", name: "main" },
      observedState: "working" as const,
      isFocused: true,
      canDraft: true,
    },
    {
      terminalId: "t2",
      title: "Codex: docs",
      agentId: "codex",
      worktree: { id: "w-feat", name: "feature/login" },
      observedState: "waiting" as const,
      isFocused: false,
      canDraft: true,
    },
    {
      terminalId: "t3",
      title: "Gemini: tests",
      agentId: "gemini",
      worktree: { id: "w-feat", name: "feature/login" },
      isFocused: false,
      canDraft: false,
      draftRefusal: "input-locked",
    },
  ];

  function picker(extra: Record<string, unknown> = {}) {
    const onSelect = vi.fn();
    render(
      inView(
        createElement(kit.AgentPicker, {
          agents: panes,
          onSelect,
          defaultOpen: true,
          "aria-label": "Send to agent",
          ...extra,
        })
      )
    );
    return onSelect;
  }

  it("groups the panes by worktree, the asked-for one first, with its agent preselected", () => {
    const onSelect = picker({ worktreeId: "w-feat" });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-terminal-id"))).toEqual(["t2", "t3", "t1"]);
    expect(options[0]!.getAttribute("aria-label")).toBe(
      "feature/login, Codex: docs, Codex, Last seen waiting"
    );
    // The heading is drawn once per worktree but every row is named with it.
    expect(options[1]!.getAttribute("aria-label")).toBe(
      "feature/login, Gemini: tests, Input locked"
    );
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.textContent).toContain("Last seen waiting");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      kind: "agent",
      terminalId: "t2",
      agentId: "codex",
      worktreeId: "w-feat",
    });
  });

  it("lists a pane that can't take a draft, disabled with its reason, and steps past it", () => {
    const onSelect = picker({ worktreeId: "w-feat" });
    const locked = screen.getAllByRole("option")[1]!;
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.textContent).toContain("Input locked");
    fireEvent.click(locked);
    expect(onSelect).not.toHaveBeenCalled();
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2]!.id);
  });

  it("searches, keeps the launch rows whatever is typed, and reports a launch", () => {
    const onSelect = picker({ launchAgents: ["claude", "claude", 7], worktreeId: "w-main" });
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "docs" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-label"))).toEqual([
      "Codex: docs, Codex, Last seen waiting",
      "New Claude, Starts in main",
    ]);
    fireEvent.click(options[1]!);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "launch",
      agentId: "claude",
      worktreeId: "w-main",
    });
  });

  it("leaves Enter to an IME composition", () => {
    const onSelect = picker();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says when there is nothing to pick, and survives junk panes", () => {
    picker({ agents: [null, { terminalId: "x" }, "pane"] });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("No agents in this project");
  });
});

describe("SendToAgentButton", () => {
  const invoke = vi.fn();
  beforeEach(() => {
    invoke.mockReset();
    Reflect.set(window, "electron", { plugin: { invoke } });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("asks the worker's sendToAgent handler with the request", async () => {
    invoke.mockResolvedValue({ status: "drafted", terminalId: "t1" });
    const onResult = vi.fn();
    render(
      inView(
        createElement(kit.SendToAgentButton, {
          text: "Fix the login redirect",
          title: "Login redirect",
          worktreeId: "w-main",
          onResult,
        })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to agent…" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("acme.board", "sendToAgent", {
      text: "Fix the login redirect",
      title: "Login redirect",
      worktreeId: "w-main",
    });
    expect(onResult).toHaveBeenCalledWith({ status: "drafted", terminalId: "t1" });
  });

  it("speaks up for the refusals only the plugin hears about, and not the rest", async () => {
    invoke.mockResolvedValueOnce({ status: "refused", reason: "prompt-open" });
    invoke.mockResolvedValueOnce({ status: "refused", reason: "input-locked" });
    render(inView(createElement(kit.SendToAgentButton, { text: "Body", channel: "handOff" })));
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await flush();
    expect(invoke.mock.calls[0]![1]).toBe("handOff");
    expect(toastMessages()).toHaveLength(1);
    expect(toastMessages()[0]).toMatch(/already open/);
    fireEvent.click(button);
    await flush();
    expect(toastMessages()).toHaveLength(1);
  });

  it("uses the plugin's own send, and reports a throw to onError", async () => {
    const send = vi.fn(() => Promise.reject(new Error("worker gone")));
    const onError = vi.fn();
    render(inView(createElement(kit.SendToAgentButton, { text: "Body", send, onError })));
    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(toastMessages()).toHaveLength(0);
  });

  it("stays unavailable, and says why, for text the host would refuse", async () => {
    render(
      inView(
        createElement(
          "div",
          null,
          createElement(kit.SendToAgentButton, { text: "   ", "data-testid": "blank" }),
          createElement(kit.SendToAgentButton, { text: "\u0007\u001b", "data-testid": "controls" }),
          createElement(kit.SendToAgentButton, { text: "x".repeat(40_000), "data-testid": "long" }),
          createElement(kit.SendToAgentButton, {
            text: "Body",
            disabled: true,
            disabledReason: "Pick a card first",
            "data-testid": "author",
          })
        )
      )
    );
    for (const id of ["blank", "controls", "long", "author"]) {
      const button = screen.getByTestId(id);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect(reason?.textContent).toBeTruthy();
      fireEvent.click(button);
    }
    expect(
      document.getElementById(screen.getByTestId("author").getAttribute("aria-describedby")!)
        ?.textContent
    ).toBe("Pick a card first");
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops a title and ids the host would refuse rather than failing the send", async () => {
    invoke.mockResolvedValue({ status: "cancelled" });
    render(
      inView(
        createElement(kit.SendToAgentButton, {
          text: "Body",
          title: "t".repeat(200),
          terminalId: "x".repeat(600),
          onResult: () => {},
        })
      )
    );
    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(invoke.mock.calls[0]![2]).toEqual({ text: "Body" });
  });

  it("keeps a throwing onResult from reading as a failed send, and reports nothing after unmount", async () => {
    invoke.mockResolvedValueOnce({ status: "drafted", terminalId: "t1" });
    const onError = vi.fn();
    const onResult = vi.fn(() => {
      throw new Error("plugin bug");
    });
    const first = render(
      inView(createElement(kit.SendToAgentButton, { text: "Body", onResult, onError }))
    );
    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    first.unmount();

    let settle: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    const later = vi.fn();
    const second = render(
      inView(createElement(kit.SendToAgentButton, { text: "Body", onResult: later }))
    );
    fireEvent.click(screen.getByRole("button"));
    second.unmount();
    settle({ status: "refused", reason: "busy" });
    await flush();
    expect(later).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([]);
  });
});

describe("ContextDragSource", () => {
  function dataTransfer() {
    const data = new Map<string, string>();
    return {
      data,
      setData: (type: string, value: string) => data.set(type, value),
      effectAllowed: "none",
    };
  }

  it("puts the daintree-context payload and plain text on a drag", () => {
    const onDragStart = vi.fn();
    render(
      createElement(
        kit.ContextDragSource,
        {
          text: "Card body",
          title: "Card",
          sourceLabel: "Kanban",
          onDragStart,
          "data-testid": "s",
        },
        createElement("span", null, "Card")
      )
    );
    const source = screen.getByTestId("s");
    expect(source.getAttribute("draggable")).toBe("true");
    const transfer = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(JSON.parse(transfer.data.get("application/x-daintree-agent-context")!)).toEqual({
      v: 1,
      text: "Card body",
      title: "Card",
      source: { label: "Kanban" },
    });
    expect(transfer.data.get("text/plain")).toBe("Card body");
    expect(transfer.effectAllowed).toBe("copy");
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("starts no drag for a payload the drop would refuse", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.ContextDragSource, { text: "  ", "data-testid": "blank" }),
        createElement(kit.ContextDragSource, {
          text: "ok",
          title: "x".repeat(121),
          "data-testid": "long",
        }),
        createElement(kit.ContextDragSource, { text: "ok", disabled: true, "data-testid": "off" })
      )
    );
    for (const id of ["blank", "long", "off"]) {
      const source = screen.getByTestId(id);
      // Still marked draggable, so a kit drag around it never starts from it;
      // the drag itself is cancelled.
      expect(source.getAttribute("draggable")).toBe("true");
      expect(source.getAttribute("aria-disabled")).toBe("true");
      const transfer = dataTransfer();
      fireEvent.dragStart(source, { dataTransfer: transfer });
      expect(transfer.data.size).toBe(0);
    }
  });

  it("draws the grip chip when it has no children", () => {
    render(createElement(kit.ContextDragSource, { text: "Body", "data-testid": "s" }));
    expect(screen.getByTestId("s").textContent).toBe("Drag to an agent");
  });
});

describe("TerminalSnapshot", () => {
  it("keeps the last rows, in the theme's ANSI colours, with escapes other than colour dropped", () => {
    const lines = snapshotLines(
      "one\ntwo\n\u001b]0;title\u0007\u001b[31mred\u001b[0m \u001b[1;92mok\u001b[0m\nprogress 10%\rprogress 100%\n\n",
      2
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((span) => span.text).join("")).toBe("red ok");
    expect(lines[0]![0]!.style?.color).toBe("var(--theme-terminal-red)");
    expect(lines[0]![2]!.style).toEqual({
      color: "var(--theme-terminal-bright-green)",
      fontWeight: 600,
    });
    expect(lines[1]!.map((span) => span.text).join("")).toBe("progress 100%");
  });

  it("maps the 256-colour cube and true colour, and ignores a malformed one", () => {
    const [line] = snapshotLines("\u001b[38;5;196ma\u001b[0m\u001b[38;2;1;2;3mb\u001b[0m", 5);
    expect(line![0]!.style?.color).toBe("rgb(255, 0, 0)");
    expect(line![1]!.style?.color).toBe("rgb(1, 2, 3)");
  });

  it("reads the output as one stream, so a colour set above the kept lines still applies", () => {
    const lines = snapshotLines("\u001b[31mfirst\nsecond\nthird\u001b[0m\nplain", 3);
    expect(lines.map((line) => line[0]!.style?.color)).toEqual([
      "var(--theme-terminal-red)",
      "var(--theme-terminal-red)",
      undefined,
    ]);
  });

  it("keeps a colour change made in the part a carriage return overwrote", () => {
    const [line] = snapshotLines("\u001b[32mold\rnew", 1);
    expect(line).toEqual([{ text: "new", style: { color: "var(--theme-terminal-green)" } }]);
  });

  it("draws reverse video once", () => {
    const [line] = snapshotLines("\u001b[31;44;7mX", 1);
    // Swapped a single time: red on blue reads as blue text on red.
    expect(line![0]!.style).toEqual({
      color: "var(--theme-terminal-blue)",
      backgroundColor: "var(--theme-terminal-red)",
    });
  });

  it("drops device-control and application strings, and an escape cut off at the end", () => {
    const lines = snapshotLines(
      "a\u001bPq#0;2;0;0;0\u001b\\b\u001b_payload\u001b\\c\u001b^pm\u0007d\u001b[2Je\u001b[",
      5
    );
    expect(lines.map((line) => line.map((span) => span.text).join(""))).toEqual(["abcde"]);
  });

  it("keeps only plain SGR: other CSI ending in m, cut-off and multi-line strings go", () => {
    const text = (input: string) =>
      snapshotLines(input, 10).map((line) => line.map((span) => span.text).join(""));
    expect(text("a\u001b[>4;2mz")).toEqual(["az"]);
    expect(text("a\u001b[1 mz")).toEqual(["az"]);
    expect(text("a\u001b]0;secret\u001b")).toEqual(["a"]);
    expect(text("a\u001b]0;secret\ncontinued\u0007z")).toEqual(["az"]);
  });

  it("is a named, static figure, and a button only when it has somewhere to go", () => {
    const onClick = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(kit.TerminalSnapshot, {
          text: "hello",
          title: "Claude: fix auth",
          agentId: "claude",
          state: "waiting",
          "data-testid": "still",
        }),
        createElement(kit.TerminalSnapshot, { text: "hi", title: "Shell", onClick })
      )
    );
    const still = screen.getByTestId("still");
    expect(still.tagName).toBe("FIGURE");
    expect(still.getAttribute("aria-label")).toBe("Claude: fix auth, Prompt on screen");
    expect(still.textContent).toContain("hello");
    fireEvent.click(screen.getByRole("button", { name: "Shell" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ShortcutHint and KeyHints", () => {
  it("shows an action's title and binding, and nothing while it has none", () => {
    addAction({ id: "palette.open", title: "Open palette" });
    combos.set("palette.open", "Cmd+K");
    render(
      createElement(
        "div",
        { "data-testid": "row" },
        createElement(kit.ShortcutHint, { actionId: "palette.open", "data-testid": "h" }),
        createElement(kit.ShortcutHint, { actionId: "unbound.action" }),
        createElement(kit.ShortcutHint, { shortcut: "Escape", label: "Close", variant: "inline" })
      )
    );
    const hint = screen.getByTestId("h");
    expect(hint.textContent).toContain("Open palette");
    expect(hint.querySelector("kbd")).not.toBeNull();
    expect(screen.getByTestId("row").children).toHaveLength(2);
  });

  it("hides a restricted action's title, and draws a hostile combo as text", () => {
    addAction({ id: "app.quit", title: "Quit", danger: "restricted" });
    combos.set("app.quit", "Cmd+Q");
    render(
      createElement(
        "div",
        null,
        createElement(kit.ShortcutHint, { actionId: "app.quit", "data-testid": "r" }),
        createElement(kit.ShortcutHint, { shortcut: "__proto__+constructor", "data-testid": "h" })
      )
    );
    expect(screen.getByTestId("r").textContent).not.toContain("Quit");
    expect(screen.getByTestId("h").querySelectorAll("kbd")).toHaveLength(2);
  });

  it("speaks literal glyph caps by name, not by symbol", () => {
    render(
      createElement(kit.KeyHints, {
        "data-testid": "k",
        hints: [{ keys: ["↑↓"], label: "Move" }],
      })
    );
    const chip = screen.getByTestId("k").querySelector("[data-key-hint]")!;
    const spoken = [...chip.querySelectorAll(".sr-only")].map((el) => el.textContent).join(" ");
    expect(spoken).toBe("Up Down");
    for (const cap of chip.querySelectorAll("kbd")) {
      expect(cap.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("redraws when the user rebinds a hinted action", () => {
    combos.set("search.open", "Cmd+F");
    render(
      createElement(kit.KeyHints, {
        "data-testid": "k",
        hints: [
          { shortcut: "Enter", label: "Open" },
          { actionId: "search.open", label: "Search" },
        ],
      })
    );
    expect(screen.getByTestId("k").querySelectorAll("[data-key-hint]")).toHaveLength(2);
    combos.delete("search.open");
    act(() => {
      Reflect.apply(Reflect.get(keybindingService, "notifyListeners"), keybindingService, []);
    });
    expect(screen.getByTestId("k").querySelectorAll("[data-key-hint]")).toHaveLength(1);
  });

  it("keeps the first hint whatever the width, drops unbound actions and junk", () => {
    combos.set("search.open", "Cmd+F");
    render(
      untyped("KeyHints", {
        "data-testid": "k",
        hints: [
          { shortcut: "Enter", label: "Open" },
          { keys: ["↑↓"], label: "Move" },
          { actionId: "search.open", label: "Search" },
          { actionId: "unbound.action", label: "Never" },
          { label: "No keys" },
          null,
          { shortcut: "Escape", label: "Close" },
        ],
      })
    );
    const row = screen.getByTestId("k");
    const chips = [...row.querySelectorAll("[data-key-hint]")];
    expect(
      chips.map((chip) => chip.textContent?.replace(/^.*?(Open|Move|Search|Close)$/, "$1"))
    ).toEqual(["Open", "Move", "Search", "Close"]);
    // Only the hints after the first can drop out as the row narrows, and the
    // last drops out at the widest width of them all.
    const dropWidth = (chip: Element) =>
      Number(/max-\[(\d+)px\][^ ]*:hidden/.exec(chip.className)?.[1] ?? 0);
    expect(dropWidth(chips[0]!)).toBe(0);
    expect(dropWidth(chips[3]!)).toBeGreaterThan(dropWidth(chips[2]!));
    expect(dropWidth(chips[2]!)).toBeGreaterThan(0);
  });
});
