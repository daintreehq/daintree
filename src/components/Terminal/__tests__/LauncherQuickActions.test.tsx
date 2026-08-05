// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Hoisted so the vi.mock factories can reference this shared, mutable state.
// Every mock reads its slice at call time, so a test can reshape the toolbar
// (layout, which ids are built-in agents, and which buttons are visible) before
// rendering.
const h = vi.hoisted(() => ({
  // dispatch resolves to an ActionDispatchResult, matching the real signature:
  // it reports a thrown `run()` as `ok: false` rather than rejecting.
  dispatch: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; error?: Error }>>(() =>
    Promise.resolve({ ok: true })
  ),
  notify: vi.fn(),
  avail: { availability: {} as Record<string, unknown> },
  options: [] as Array<{
    id: string;
    launchAgentId?: string;
    label: string;
    description: string;
    icon: null;
  }>,
  layout: {
    leftButtons: [] as string[],
    rightButtons: [] as string[],
    pinnedButtons: {} as Record<string, boolean>,
  },
  settings: { agents: {} as Record<string, unknown> } as Record<string, unknown> | null,
  // Ids treated as built-in agents — drives the `isBuiltInAgentId` mock (the
  // gate that keeps non-agent toolbar buttons and plugin/user agents out).
  builtIn: new Set<string>(),
  // Ids treated as visible on the toolbar — drives the `isToolbarButtonVisible`
  // mock so tests set toolbar visibility without rebuilding the real
  // pin/availability tri-state.
  visible: new Set<string>(),
}));

vi.mock("@/components/TerminalPalette/launchOptions", () => ({
  getLaunchOptions: () => h.options,
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (sel: (s: typeof h.avail) => unknown) => sel(h.avail),
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (sel: (s: { settings: unknown }) => unknown) =>
    sel({ settings: h.settings }),
}));
vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (sel: (s: { layout: typeof h.layout }) => unknown) =>
    sel({ layout: h.layout }),
}));
vi.mock("@/components/Layout/toolbarButtonMetadata", () => ({
  isToolbarButtonVisible: (id: string) => h.visible.has(id),
}));
vi.mock("@shared/config/agentIds", () => ({
  isBuiltInAgentId: (id: unknown) => typeof id === "string" && h.builtIn.has(id),
}));
vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: (actionId: string) => (actionId === "agent.claude" ? "Cmd+Alt+C" : undefined),
  useAriaKeyshortcuts: (actionId: string) =>
    actionId === "agent.claude" ? "Meta+Alt+C" : undefined,
}));
vi.mock("@/lib/notify", () => ({ notify: h.notify }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: h.dispatch },
}));
vi.mock("@/components/ui/Kbd", () => ({
  KbdChord: ({ shortcut }: { shortcut: string }) => <span data-testid="kbd">{shortcut}</span>,
}));

import { LauncherQuickActions } from "../LauncherQuickActions";
import {
  basePressTreatment,
  reduceMotionSelectors,
  transitionWideners,
} from "./launcherMotionContract";

beforeEach(() => {
  h.dispatch.mockClear();
  h.dispatch.mockResolvedValue({ ok: true });
  h.notify.mockClear();
  h.avail.availability = {};
  h.options = [
    { id: "claude", launchAgentId: "claude", label: "Claude", description: "", icon: null },
    { id: "gemini", launchAgentId: "gemini", label: "Gemini", description: "", icon: null },
    // Non-agent option (no launchAgentId) — never an agent chip.
    { id: "terminal", label: "Terminal", description: "", icon: null },
  ];
  h.layout = {
    leftButtons: ["agent-tray", "claude", "gemini", "terminal"],
    rightButtons: [],
    pinnedButtons: {},
  };
  h.settings = { agents: {} };
  h.builtIn = new Set<string>(["claude", "gemini"]);
  // Claude visible on the toolbar; Gemini hidden.
  h.visible = new Set<string>(["claude"]);
});

describe("LauncherQuickActions", () => {
  it("shows the toolbar agents, the fixed chips, and the palette search entry", () => {
    render(<LauncherQuickActions />);
    expect(screen.getByRole("button", { name: /Claude/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New terminal/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Browse files/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search agents & panels/i })).toBeTruthy();
  });

  it("hides agents whose toolbar button isn't visible", () => {
    render(<LauncherQuickActions />);
    expect(screen.queryByRole("button", { name: /Gemini/i })).toBeNull();
  });

  it("omits agents that aren't on the toolbar layout at all", () => {
    // Gemini is launchable, built-in, and visible — but drop it from the layout
    // and it must not appear: the launcher mirrors the toolbar, not the full
    // launchable set.
    h.layout = {
      leftButtons: ["agent-tray", "claude", "terminal"],
      rightButtons: [],
      pinnedButtons: {},
    };
    h.visible = new Set<string>(["claude", "gemini"]);
    render(<LauncherQuickActions />);
    expect(screen.getByRole("button", { name: /Claude/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gemini/i })).toBeNull();
  });

  it("never shows a plugin/user agent whose id collides with a non-agent toolbar button", () => {
    // A user agent literally named "terminal" is launchable and its id sits in
    // the toolbar layout — but as the *terminal* button, not an agent. Only
    // built-in agents are toolbar agent buttons, so it must not be pulled in.
    h.options = [
      {
        id: "terminal",
        launchAgentId: "terminal",
        label: "My Terminal Agent",
        description: "",
        icon: null,
      },
      { id: "claude", launchAgentId: "claude", label: "Claude", description: "", icon: null },
    ];
    h.layout = { leftButtons: ["terminal", "claude"], rightButtons: [], pinnedButtons: {} };
    h.builtIn = new Set<string>(["claude"]); // "terminal" agent id is NOT built-in
    h.visible = new Set<string>(["terminal", "claude"]); // both "visible" per the resolver
    render(<LauncherQuickActions />);
    expect(screen.queryByRole("button", { name: /My Terminal Agent/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Claude/i })).toBeTruthy();
  });

  it("renders agents in the toolbar's own left→right order", () => {
    h.layout = { leftButtons: ["gemini"], rightButtons: ["claude"], pinnedButtons: {} };
    h.visible = new Set<string>(["gemini", "claude"]);
    render(<LauncherQuickActions />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const geminiIdx = labels.findIndex((t) => /Gemini/i.test(t));
    const claudeIdx = labels.findIndex((t) => /Claude/i.test(t));
    expect(geminiIdx).toBeGreaterThanOrEqual(0);
    expect(geminiIdx).toBeLessThan(claudeIdx);
  });

  it("shows every pinned agent with no arbitrary cap", () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
    h.options = ids.map((id) => ({
      id,
      launchAgentId: id,
      label: id.toUpperCase(),
      description: "",
      icon: null,
    }));
    h.layout = { leftButtons: [...ids], rightButtons: [], pinnedButtons: {} };
    h.builtIn = new Set<string>(ids);
    h.visible = new Set<string>(ids);
    render(<LauncherQuickActions />);
    for (const id of ids) {
      expect(screen.getByRole("button", { name: new RegExp(id.toUpperCase(), "i") })).toBeTruthy();
    }
  });

  it("dispatches the canonical agent shortcut action for a built-in agent", () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /Claude/i }));
    expect(h.dispatch).toHaveBeenCalledWith("agent.claude", undefined, { source: "user" });
  });

  it("dispatches terminal.new for the chip and panel.palette from the search entry", () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /New terminal/i }));
    fireEvent.click(screen.getByRole("button", { name: /Search agents & panels/i }));
    expect(h.dispatch).toHaveBeenCalledWith("terminal.new", undefined, { source: "user" });
    expect(h.dispatch).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
  });

  it("dispatches the file browser with no args so it resolves its own target", () => {
    // Args-free is the contract: the action picks the focused worktree, or the
    // workspace root in a scratch or worktree-less project (#11482).
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /Browse files/i }));
    expect(h.dispatch).toHaveBeenCalledWith("worktree.openFileBrowserPanel", undefined, {
      source: "user",
    });
  });

  it("surfaces a refused file-browser dispatch instead of pressing into nothing", async () => {
    // `dispatch` reports a thrown `run()` as `ok: false` rather than rejecting,
    // so discarding the result would restore exactly the silent failure the
    // action's throw exists to end.
    h.dispatch.mockResolvedValue({ ok: false, error: new Error("No folder to browse") });
    render(<LauncherQuickActions />);

    fireEvent.click(screen.getByRole("button", { name: /Browse files/i }));
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalled());

    const toast = h.notify.mock.calls[0]?.[0] as {
      type: string;
      action?: { label: string; onClick: () => void };
    };
    expect(toast.type).toBe("error");
    // The recovery action re-runs the same dispatch, so a transient refusal is
    // recoverable without hunting for the chip again.
    h.dispatch.mockResolvedValue({ ok: true });
    toast.action?.onClick();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the file browser opens", async () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /Browse files/i }));
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("leaves a full grid to report itself instead of blaming the workspace", async () => {
    // `addPanel` has already shown "Panel limit reached" with the real recovery
    // by the time this refusal arrives. The chip's own message names a
    // different cause entirely, so adding it would contradict the accurate one
    // the user is already looking at (#11666).
    h.dispatch.mockResolvedValue({
      ok: false,
      error: new Error("Could not open file browser panel: panel limit reached"),
    });
    render(<LauncherQuickActions />);

    fireEvent.click(screen.getByRole("button", { name: /Browse files/i }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.notify).not.toHaveBeenCalled();
  });

  // Shortcut-hint teardown around the palette open is now global — the
  // palette's own open transition clears it (AppPaletteDialog overlay
  // clearing, issue #11030) — so the palette button dispatches plainly,
  // asserted above.

  it("exposes an agent's binding via aria-keyshortcuts, not its accessible name", () => {
    render(<LauncherQuickActions />);
    const claude = screen.getByRole("button", { name: /Claude/i });
    // The binding is on aria-keyshortcuts; the accessible name stays "Claude"
    // (the visible chip is aria-hidden).
    expect(claude.getAttribute("aria-keyshortcuts")).toBe("Meta+Alt+C");
    expect(claude.getAttribute("aria-label")).toBeNull();
    expect(screen.getByTestId("kbd").textContent).toBe("Cmd+Alt+C");
  });

  // These are hand-rolled buttons, not the shared `Button`, so nothing makes
  // them inherit its press feedback — without this they drift back to feeling
  // inert on click while every other button in the app snaps.
  describe("press feedback", () => {
    const launcherButtons = () => [
      screen.getByRole("button", { name: /Claude/i }),
      screen.getByRole("button", { name: /New terminal/i }),
      screen.getByRole("button", { name: /Browse files/i }),
      screen.getByRole("button", { name: /Search agents & panels/i }),
    ];

    it("carries exactly the press treatment the shared Button owns", () => {
      const press = basePressTreatment();
      // Guard: if the shared recipe ever loses its `active:` classes there is
      // nothing left to enforce, and the comparison below would pass vacuously.
      expect(press.length).toBeGreaterThan(0);

      render(<LauncherQuickActions />);

      for (const button of launcherButtons()) {
        // Exact, not superset: a class the shared recipe has dropped must not
        // linger here either.
        const pressed = button.className.split(/\s+/).filter((c) => c.startsWith("active:"));
        expect(new Set(pressed)).toEqual(new Set(press));
      }
    });

    it("keeps transform out of its transition set, so the press snaps", () => {
      render(<LauncherQuickActions />);

      for (const button of launcherButtons()) {
        // Anything that pulls a transform into the transition set would ease
        // the scale back over the shared 150ms instead of snapping it.
        expect(transitionWideners(button.className)).toEqual([]);
      }
    });

    // `active:scale-*` emits the individual `scale` property, which the app's
    // `transform: none` reduced-motion button reset cannot neutralize. Without
    // a class the reduce-motion block actually names, the press scale keeps
    // animating for users who asked for no motion.
    it("registers the press scale with the reduce-animations kill switch", () => {
      const suppressed = reduceMotionSelectors();
      expect(suppressed.size).toBeGreaterThan(0);

      render(<LauncherQuickActions />);

      for (const button of launcherButtons()) {
        const covered = button.className.split(/\s+/).filter((c) => suppressed.has(c));
        expect(covered.length).toBeGreaterThan(0);
      }
    });
  });
});
