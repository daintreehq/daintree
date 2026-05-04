import React, { useMemo, useRef } from "react";
import { Kbd } from "@/components/ui/Kbd";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import type { ActionId } from "@shared/types/actions";
import type { BuiltInAgentId } from "@shared/config/agentIds";

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

let tipMountCount = 0;

export function RotatingTip() {
  "use memo";
  const mountIndex = useRef(tipMountCount++);
  const availability = useCliAvailabilityStore((s) => s.availability);

  const filteredTips = useMemo(
    () =>
      TIPS.filter(
        (tip) =>
          !tip.requiredAgents || tip.requiredAgents.some((a) => isAgentLaunchable(availability[a]))
      ),
    [availability]
  );

  if (filteredTips.length === 0) return null;

  const tip = filteredTips[mountIndex.current % filteredTips.length]!;

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
