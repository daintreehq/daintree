// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Hoisted so the vi.mock factories can reference this shared, mutable state.
const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  avail: {
    availability: { claude: { installed: true }, gemini: { installed: false } } as Record<
      string,
      unknown
    >,
    isInitialized: true,
  },
}));

vi.mock("@/components/TerminalPalette/launchOptions", () => ({
  getLaunchOptions: () => [
    { id: "claude", launchAgentId: "claude", label: "Claude", description: "", icon: <span /> },
    { id: "gemini", launchAgentId: "gemini", label: "Gemini", description: "", icon: <span /> },
    // Plugin agent (not a built-in) — always shown, routed through agent.launch.
    { id: "acme", launchAgentId: "acme", label: "Acme", description: "", icon: <span /> },
    { id: "terminal", label: "Terminal", description: "", icon: <span /> },
  ],
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (sel: (s: typeof h.avail) => unknown) => sel(h.avail),
}));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: (sel: (s: { registry: unknown }) => unknown) =>
    sel({ registry: null }),
}));
vi.mock("@shared/config/pluginAgentRegistry", () => {
  // Snapshot MUST be a stable reference — useSyncExternalStore loops forever if
  // it changes every call (as the real cached snapshot does not).
  const snapshot = {};
  return {
    subscribeToPluginAgentRegistry: () => () => {},
    getPluginAgentRegistrySnapshot: () => snapshot,
  };
});
vi.mock("@shared/utils/agentAvailability", () => ({
  isAgentInstalled: (s: { installed?: boolean } | undefined) => Boolean(s?.installed),
}));
vi.mock("@shared/config/agentIds", () => ({
  isBuiltInAgentId: (id: unknown) => id === "claude" || id === "gemini",
}));
vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: (actionId: string) => (actionId === "agent.claude" ? "Cmd+Alt+C" : undefined),
  useAriaKeyshortcuts: (actionId: string) =>
    actionId === "agent.claude" ? "Meta+Alt+C" : undefined,
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: h.dispatch },
}));
vi.mock("@/components/ui/Kbd", () => ({
  KbdChord: ({ shortcut }: { shortcut: string }) => <span data-testid="kbd">{shortcut}</span>,
}));

import { LauncherQuickActions } from "../LauncherQuickActions";

beforeEach(() => {
  h.dispatch.mockClear();
  h.avail.availability = { claude: { installed: true }, gemini: { installed: false } };
  h.avail.isInitialized = true;
});

describe("LauncherQuickActions", () => {
  it("shows installed agents, a new-terminal chip, and the palette search entry", () => {
    render(<LauncherQuickActions />);
    expect(screen.getByRole("button", { name: /Claude/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New terminal/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search agents & panels/i })).toBeTruthy();
  });

  it("hides uninstalled built-in agents once availability is known", () => {
    render(<LauncherQuickActions />);
    expect(screen.queryByRole("button", { name: /Gemini/i })).toBeNull();
  });

  it("always shows plugin agents (not gated on built-in availability)", () => {
    render(<LauncherQuickActions />);
    expect(screen.getByRole("button", { name: /Acme/i })).toBeTruthy();
  });

  it("dispatches the canonical agent shortcut action for a built-in agent", () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /Claude/i }));
    expect(h.dispatch).toHaveBeenCalledWith("agent.claude", undefined, { source: "user" });
  });

  it("routes plugin agents through the generic agent.launch action with an agentId", () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /Acme/i }));
    expect(h.dispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "acme" },
      { source: "user" }
    );
  });

  it("dispatches terminal.new for the chip and panel.palette from the search entry", () => {
    render(<LauncherQuickActions />);
    fireEvent.click(screen.getByRole("button", { name: /New terminal/i }));
    fireEvent.click(screen.getByRole("button", { name: /Search agents & panels/i }));
    expect(h.dispatch).toHaveBeenCalledWith("terminal.new", undefined, { source: "user" });
    expect(h.dispatch).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
  });

  it("exposes an agent's binding via aria-keyshortcuts, not its accessible name", () => {
    render(<LauncherQuickActions />);
    const claude = screen.getByRole("button", { name: /Claude/i });
    // The binding is on aria-keyshortcuts; the accessible name stays "Claude"
    // (the visible chip is aria-hidden).
    expect(claude.getAttribute("aria-keyshortcuts")).toBe("Meta+Alt+C");
    expect(claude.getAttribute("aria-label")).toBeNull();
    expect(screen.getByTestId("kbd").textContent).toBe("Cmd+Alt+C");
  });
});
