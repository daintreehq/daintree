import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Kbd } from "@/components/ui/Kbd";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import type { ActionId } from "@shared/types/actions";
import type { BuiltInAgentId } from "@shared/config/agentIds";

// HCI: surface 3–5 unlearned tips at a time; 4 balances variety vs cognitive load.
const ROTATING_TIP_SUBSET_SIZE = 4;

export interface TipEntry {
  id: string;
  message: React.ReactNode;
  messageWithShortcut?: (shortcut: string) => React.ReactNode;
  actionId?: ActionId;
  shortcutActionId?: ActionId;
  actionLabel?: string;
  requiredAgents?: BuiltInAgentId[];
}

export const TIPS: TipEntry[] = [
  {
    id: "quick-switcher",
    message: (
      <>
        Press <Kbd>⌘P</Kbd> to jump between open panels
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to jump between open panels
      </>
    ),
    actionId: "nav.quickSwitcher",
    actionLabel: "Open Quick Switcher",
  },
  {
    id: "new-terminal",
    message: (
      <>
        Press <Kbd>⌘⌥T</Kbd> to open a new terminal in this worktree
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open a new terminal in this worktree
      </>
    ),
    actionId: "terminal.new",
    actionLabel: "New Terminal",
  },
  {
    id: "panel-palette",
    message: (
      <>
        Press <Kbd>⌘N</Kbd> to open the panel palette — add terminals, browsers, or dev previews
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the panel palette — add terminals, browsers, or dev
        previews
      </>
    ),
    actionId: "panel.palette",
    actionLabel: "Open Panel Palette",
  },
  {
    id: "launch-claude",
    message: (
      <>
        Press <Kbd>⌘⌥N</Kbd> to launch a Claude agent in this worktree
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to launch a Claude agent in this worktree
      </>
    ),
    actionId: "agent.terminal",
    actionLabel: "Launch Agent",
    requiredAgents: ["claude"],
  },
  {
    id: "launch-gemini",
    message: (
      <>
        Press <Kbd>⌘⌥N</Kbd> to launch a Gemini agent in this worktree
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to launch a Gemini agent in this worktree
      </>
    ),
    actionId: "agent.terminal",
    actionLabel: "Launch Agent",
    requiredAgents: ["gemini"],
  },
  {
    id: "context-injection",
    message: (
      <>
        Press <Kbd>⌘⇧I</Kbd> to inject the project file tree into the focused terminal
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to inject the project file tree into the focused terminal
      </>
    ),
    actionId: "terminal.inject",
    actionLabel: "Inject Context",
  },
  {
    id: "action-palette",
    message: (
      <>
        Press <Kbd>⌘⇧P</Kbd> to open the action palette and search all available commands
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the action palette and search all available commands
      </>
    ),
    actionId: "action.palette.open",
    actionLabel: "Open Action Palette",
  },
  {
    id: "worktree-palette",
    message: (
      <>
        Press <Kbd>⌘K</Kbd> then <Kbd>W</Kbd> to open the worktree palette and switch branches
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the worktree palette and switch branches
      </>
    ),
    actionId: "worktree.openPalette",
    actionLabel: "Open Worktree Palette",
  },
  {
    id: "worktree-overview",
    message: (
      <>
        Press <Kbd>⌘⇧O</Kbd> to open the worktrees overview and manage all your branches
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the worktrees overview and manage all your branches
      </>
    ),
    actionId: "worktree.overview.open",
    shortcutActionId: "worktree.overview",
    actionLabel: "Open Worktrees Overview",
  },
  {
    id: "agent-switcher",
    message: (
      <>
        Press <Kbd>⌘⇧A</Kbd> to quickly switch between available AI agents
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to quickly switch between available AI agents
      </>
    ),
    actionId: "agent.palette",
    actionLabel: "Open Agent Switcher",
  },
  {
    id: "recipes",
    message: <>Create a recipe to run multi-terminal workflows with a single click</>,
    actionId: "recipe.manager.open",
    actionLabel: "Open Recipes",
  },
  {
    id: "new-worktree",
    message: <>Create a new worktree to isolate each task on its own branch</>,
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to create a new worktree
      </>
    ),
    actionId: "worktree.createDialog.open",
    actionLabel: "New Worktree",
  },
];

export function LiveTipMessage({ tip }: { tip: TipEntry }) {
  "use memo";
  const lookupId = tip.shortcutActionId ?? tip.actionId ?? "";
  const shortcut = useKeybindingDisplay(lookupId);
  if (tip.messageWithShortcut && shortcut) {
    return <>{tip.messageWithShortcut(shortcut)}</>;
  }
  return <>{tip.message}</>;
}

export function RotatingTip() {
  "use memo";
  const availability = useCliAvailabilityStore((s) => s.availability);
  // Subscribe to `hydrated` only — `counts` are read once via getState() when we
  // pick the tip, so subsequent increments don't churn or swap the visible tip.
  const hydrated = useStore(shortcutHintStore, (s) => s.hydrated);

  const filteredTips = useMemo(
    () =>
      TIPS.filter(
        (tip) =>
          !tip.requiredAgents || tip.requiredAgents.some((a) => isAgentLaunchable(availability[a]))
      ),
    [availability]
  );

  const [tip, setTip] = useState<TipEntry | null>(null);

  useEffect(() => {
    if (tip || !hydrated || filteredTips.length === 0) return;
    const counts = shortcutHintStore.getState().counts;
    // Use shortcutActionId when present (mirrors LiveTipMessage lookup) so a tip
    // whose kbd shortcut dispatches a different action than its label-click
    // (e.g. worktree-overview: ⌘⇧O → "worktree.overview", click → ".open") still
    // counts toward "used" when the user invokes it via keyboard.
    const lookupKey = (tipEntry: TipEntry) => tipEntry.shortcutActionId ?? tipEntry.actionId ?? "";
    const prioritized = [...filteredTips]
      .sort((a, b) => (counts[lookupKey(a)] ?? 0) - (counts[lookupKey(b)] ?? 0))
      .slice(0, ROTATING_TIP_SUBSET_SIZE);
    // Pick randomly within the unused-bias subset so per-mount variety doesn't
    // require a module-level counter (which leaks between tests, see #4754).
    const index = Math.floor(Math.random() * prioritized.length);
    const picked = prioritized[index] ?? null;
    if (picked) setTip(picked);
  }, [tip, hydrated, filteredTips]);

  if (!tip) return null;

  return (
    <div className="flex flex-col items-center gap-2 animate-in fade-in duration-200">
      <p className="text-xs text-daintree-text/70 text-center">
        Tip: <LiveTipMessage tip={tip} />
      </p>
      {tip.actionId && tip.actionLabel && (
        <button
          type="button"
          onClick={() => void actionService.dispatch(tip.actionId!, undefined, { source: "user" })}
          className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 rounded px-1"
        >
          {tip.actionLabel}
        </button>
      )}
    </div>
  );
}
