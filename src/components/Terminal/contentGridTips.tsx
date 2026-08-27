import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Kbd } from "@/components/ui/Kbd";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
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
  /** The fallback message hardcodes a key combo — skip the tip when the binding is gone. */
  requiresShortcut?: boolean;
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
    actionLabel: "Open quick switcher",
    requiresShortcut: true,
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
    actionLabel: "New terminal",
    requiresShortcut: true,
  },
  {
    id: "panel-palette",
    message: (
      <>
        Press <Kbd>⌘N</Kbd> to open the panel palette — add terminals, file browsers, web browsers,
        or dev previews
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the panel palette — add terminals, file browsers, web
        browsers, or dev previews
      </>
    ),
    actionId: "panel.palette",
    actionLabel: "Open panel palette",
    requiresShortcut: true,
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
    actionLabel: "Launch agent",
    requiresShortcut: true,
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
    actionLabel: "Launch agent",
    requiresShortcut: true,
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
    actionLabel: "Inject context",
    requiresShortcut: true,
  },
  {
    id: "action-palette",
    message: (
      <>
        Press <Kbd>⌘⇧P</Kbd> to open the command palette and search all available commands
      </>
    ),
    messageWithShortcut: (shortcut) => (
      <>
        Press <Kbd>{shortcut}</Kbd> to open the command palette and search all available commands
      </>
    ),
    actionId: "action.palette.open",
    actionLabel: "Open command palette",
    requiresShortcut: true,
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
    actionLabel: "Open worktree palette",
    requiresShortcut: true,
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
    actionLabel: "Open worktrees overview",
    requiresShortcut: true,
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
    actionLabel: "Open agent switcher",
    requiresShortcut: true,
  },
  {
    id: "recipes",
    message: <>Create a recipe to run multi-terminal workflows with a single click</>,
    actionId: "recipe.manager.open",
    actionLabel: "Open recipes",
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
    actionLabel: "New worktree",
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
          (!tip.requiredAgents ||
            tip.requiredAgents.some((a) => isAgentLaunchable(availability[a]))) &&
          // Mirrors WelcomeScreen's SHORTCUT_TIPS filter: never teach a combo
          // the user has unbound or rebound away.
          (!tip.requiresShortcut ||
            Boolean(keybindingService.getDisplayCombo(tip.shortcutActionId ?? tip.actionId ?? "")))
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

  if (tip) {
    return (
      // `motion-safe:` + the shared entry tier fed to the ANIMATION's own slot.
      // The bare `duration-200` this used to carry compiled to
      // `transition-duration` on an element with no `transition-property`,
      // landing on CSS's `all` default — an every-property transition nobody
      // asked for — while the keyframe animation it was meant to time ignored
      // it entirely. Exactly the trap `.lessons/11180.md` documents for the
      // sections above. The marker class is what lets Daintree's own
      // reduce-animations toggle reach this fade; `motion-safe:` only covers
      // the OS preference.
      <div className="launcher-section-enter flex flex-col items-center gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]">
        <p className="text-xs text-text-secondary text-center">
          Tip: <LiveTipMessage tip={tip} />
        </p>
        {tip.actionId && tip.actionLabel && (
          <button
            type="button"
            onClick={() =>
              void actionService.dispatch(tip.actionId!, undefined, { source: "user" })
            }
            // A standing underline, not a hover-only one. Rendered as bare
            // centred text at the same size and colour as the sentence above
            // it, the only control that names the user's actual goal read as a
            // second sentence — an affordance nobody could see was there.
            className="text-xs text-text-secondary underline decoration-text-muted underline-offset-2 hover:text-daintree-text hover:decoration-current transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 rounded px-1"
          >
            {tip.actionLabel}
          </button>
        )}
      </div>
    );
  }

  // No tip will ever appear (no agent tips survive filtering, no fallback). Stay quiet.
  if (hydrated && filteredTips.length === 0) return null;

  // Reserve the tip slot before hydration completes so the empty-state column
  // doesn't reflow when `shortcutHintStore.hydrated` flips a few ticks after
  // first paint (#7671). `invisible` keeps the box in layout flow without
  // showing skeleton noise — the tip is sub-Doherty so a flash isn't needed.
  return (
    <div className="flex flex-col items-center gap-2 invisible" aria-hidden="true">
      <p className="text-xs">&nbsp;</p>
      <span className="text-xs px-1">&nbsp;</span>
    </div>
  );
}
