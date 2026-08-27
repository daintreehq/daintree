import { useCallback, useMemo, useRef, useState } from "react";
// `FolderTree` is the file browser's own icon, imported from lucide directly
// the same way `FileBrowserPane` does — it has no alias in the icons index.
import { SquareTerminal, Search, FolderTree } from "lucide-react";
import { KbdChord } from "@/components/ui/Kbd";
import { useEffectiveCombo, useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { notify } from "@/lib/notify";
import { getLaunchOptions, type LaunchOption } from "@/components/TerminalPalette/launchOptions";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { isToolbarButtonVisible } from "@/components/Layout/toolbarButtonMetadata";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { ActionId } from "@shared/types/actions";

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  /** Action whose live keybinding is shown as a chip (and, for agents, dispatched). */
  actionId: ActionId;
  onClick: () => void;
  /** Roving tab stop: only the active chip is reachable with Tab. */
  tabIndex: number;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

// No fill at rest. The chips and the palette button used to share a surface
// only 1.018:1 apart in luminance, which is not a hierarchy — it is two of the
// same control, and the wider one happened to be the important one. Letting the
// chips sit on the canvas until hover leaves exactly one filled, bordered
// control in the group, without spending accent to say so.
function QuickAction({
  icon,
  label,
  actionId,
  onClick,
  tabIndex,
  buttonRef,
  onFocus,
  onKeyDown,
}: QuickActionProps) {
  const combo = useEffectiveCombo(actionId);
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      aria-keyshortcuts={ariaKeyshortcuts}
      className="launcher-press group inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle px-2.5 py-1.5 text-sm text-daintree-text/80 transition-colors active:scale-[0.98] active:duration-[1ms] hover:bg-overlay-soft hover:border-border-default hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
      {/* Decorative chip — the binding is exposed to AT via aria-keyshortcuts
          above, so the sr-only chord text stays out of the button's name
          (otherwise "Claude" reads as "Claude Cmd Alt C"). */}
      {combo && (
        <span aria-hidden="true">
          <KbdChord shortcut={combo} className="ml-0.5" />
        </span>
      )}
    </button>
  );
}

/**
 * Search-shaped entry into the panel palette (⌘N) — the launcher's "find
 * anything" affordance, and its single most capable control: it reaches every
 * agent, panel kind and resumable session, which is exactly why it is the
 * canvas home's invariant anchor and sits at the top of this group rather than
 * beneath the chips.
 *
 * It is the launcher's one visually-weighted control, and the weight is
 * neutral, never accent: a raised surface, a stronger border and a taller box
 * against chips that carry no fill at rest. Those two used to be one step apart
 * on a token scale whose adjacent steps differ by 0.01 alpha — 1.018:1 in
 * luminance, which the eye cannot resolve, so "the weighted one" was really
 * just "the wide one". The palette itself is the real search field.
 */
function PaletteSearchButton() {
  const combo = useEffectiveCombo("panel.palette");
  const ariaKeyshortcuts = useAriaKeyshortcuts("panel.palette");
  const handleClick = () => {
    // The palette's open transition clears the shortcut hint globally
    // (AppPaletteDialog overlay clearing, issue #11030).
    void actionService.dispatch("panel.palette", undefined, { source: "user" });
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-keyshortcuts={ariaKeyshortcuts}
      className="launcher-press flex w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-border-default bg-overlay-medium px-3 py-3 text-sm text-daintree-text/70 transition-colors active:scale-[0.98] active:duration-[1ms] hover:bg-overlay-strong hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
    >
      <Search className="h-4 w-4 shrink-0 text-daintree-text/55" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">Search agents &amp; panels…</span>
      {combo && (
        <span aria-hidden="true">
          <KbdChord shortcut={combo} />
        </span>
      )}
    </button>
  );
}

/**
 * The canvas home's launch anchor: the panel palette, then the built-in agents
 * the user keeps on their toolbar plus "new terminal" and "browse files" as
 * one-press shortcuts beneath it.
 *
 * This group renders directly under project identity and above every
 * conditional band (recipes, resume, pulse, tip), so its position depends on
 * nothing the user did not choose — see the ordering note in
 * `ContentGridEmptyState`. Recipes are a contextual shortcut below it, not the
 * hero above it.
 *
 * Agent visibility mirrors the toolbar exactly: only ids the toolbar renders as
 * agent buttons (built-in launchable agents) count, resolved through the same
 * `isToolbarButtonVisible` tri-state and walked in the toolbar's own left→right
 * order, so the canvas and toolbar never disagree. Plugin/user agents live in
 * the agent tray, never as toolbar buttons, so they don't surface here — the
 * palette (⌘N) reaches them. No cap: the pinned set is already user-curated.
 */
export function LauncherQuickActions() {
  const availability = useCliAvailabilityStore((state) => state.availability);
  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);

  const agents = useMemo(() => {
    // Icon/label for each launchable agent, indexed by id.
    const byId = new Map<string, LaunchOption>(
      getLaunchOptions()
        .filter((option) => Boolean(option.launchAgentId))
        .map((option) => [option.launchAgentId!, option])
    );
    // Walk the toolbar's own left→right order (deduped defensively, #10937) and
    // keep the built-in agents whose toolbar button is currently visible. The
    // `isBuiltInAgentId` gate is what makes this an exact toolbar mirror: it
    // drops every non-agent button (terminal, browser, launcher, settings, …)
    // so a plugin/user agent whose id happens to collide with a toolbar button
    // id can never sneak in — only built-in agents are ever toolbar buttons.
    const order = Array.from(
      new Set([...toolbarLayout.leftButtons, ...toolbarLayout.rightButtons])
    );
    const result: LaunchOption[] = [];
    for (const id of order) {
      if (!isBuiltInAgentId(id)) continue;
      const option = byId.get(id);
      if (!option) continue;
      if (!isToolbarButtonVisible(id, toolbarLayout.pinnedButtons, agentSettings, availability)) {
        continue;
      }
      result.push(option);
    }
    return result;
  }, [availability, agentSettings, toolbarLayout]);

  const dispatch = (actionId: ActionId, args?: Record<string, unknown>) => {
    void actionService.dispatch(actionId, args, { source: "user" });
  };

  // Roving tab stop over the chip row. Clamped on read rather than reset on
  // change: the pinned set can shrink between renders (an agent uninstalled, a
  // toolbar button hidden), and a stale index would silently leave the group
  // with no `tabIndex={0}` at all — i.e. unreachable by Tab.
  const [activeChipRaw, setActiveChip] = useState(0);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const setChipRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      chipRefs.current[index] = el;
    },
    []
  );

  // The only chip whose action can legitimately refuse: it resolves its own
  // target, and a workspace with nothing to browse makes it throw. `dispatch`
  // turns that into `ok: false` rather than a rejection, so without this the
  // press would do nothing at all — the silent failure the throw exists to end.
  // A function declaration so the retry action can name it.
  function openFileBrowser() {
    void actionService
      .dispatch("worktree.openFileBrowserPanel", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) return;
        // A full grid is the one refusal `addPanel` has already reported, with
        // an accurate message and the actual recovery. Saying "no folder
        // resolved" on top of it would name the wrong cause (#11666).
        if (isPanelLimitError(result.error.message)) return;
        notify({
          type: "error",
          title: "Couldn't open the file browser",
          // Purpose-written rather than the raw error: both refusals this can
          // hit ("No folder to browse", a worktree that no longer exists) come
          // down to the same thing for the user, and the recovery is the same.
          message: "No folder resolved for this workspace. Select a worktree and try again.",
          // `uiFeedback` is a passive kind that resolves to `priority: "low"`
          // (inbox only), which would leave this refusal — and its Retry — with
          // no visible signal at all.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: openFileBrowser },
        });
      });
  }

  // Every chip in one line, so the roving tab stop can be indexed.
  const chips: Array<{
    key: string;
    icon: React.ReactNode;
    label: string;
    actionId: ActionId;
    onClick: () => void;
  }> = [
    ...agents.map((agent) => {
      // Every launcher agent is a built-in toolbar agent, so it carries a
      // canonical `agent.<id>` action (keybinding + label).
      const actionId = `agent.${agent.launchAgentId!}` as ActionId;
      return {
        key: agent.id,
        icon: agent.icon,
        label: agent.label,
        actionId,
        onClick: () => dispatch(actionId),
      };
    }),
    {
      key: "terminal.new",
      icon: <SquareTerminal className="h-4 w-4" />,
      label: "New terminal",
      actionId: "terminal.new" as ActionId,
      onClick: () => dispatch("terminal.new"),
    },
    {
      // No args: the action resolves its own target — the focused worktree,
      // or the workspace root in a scratch or worktree-less project
      // (#11482), which is exactly where this launcher is shown.
      key: "browse-files",
      icon: <FolderTree className="h-4 w-4" />,
      label: "Browse files",
      actionId: "worktree.openFileBrowserPanel" as ActionId,
      onClick: openFileBrowser,
    },
  ];

  const activeChip = Math.min(activeChipRaw, Math.max(0, chips.length - 1));

  const moveChipFocus = (next: number) => {
    setActiveChip(next);
    chipRefs.current[next]?.focus();
  };

  const handleChipKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Modified chords belong to the app's global keybindings, not to us.
    if (e.altKey || e.ctrlKey || e.metaKey || chips.length === 0) return;
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % chips.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (index - 1 + chips.length) % chips.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = chips.length - 1;
    else return;
    e.preventDefault();
    if (next !== index) moveChipFocus(next);
  };

  // Arrow keys pressed on the container itself (nothing inside focused yet)
  // still enter the group, which is what makes it behave like a toolbar rather
  // than a div that happens to contain buttons.
  const handleToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    moveChipFocus(e.key === "ArrowRight" ? 0 : Math.max(0, chips.length - 1));
  };

  return (
    <div className="flex w-full flex-col items-center gap-2.5">
      {/* The palette comes FIRST. It is the only control here that reaches
          every agent, panel kind and resumable session, and it is the one whose
          position must not move — putting it above an uncapped, user-curated
          chip row is what makes that true, since the row's height is a function
          of how many agents the user pinned. It also drops the Tab cost to
          reach it from "however many chips there are" to one. */}
      <PaletteSearchButton />
      {/* One tab stop, arrows inside — the same roving model the real toolbar
          these chips mirror already uses (`Toolbar.tsx`), so a keyboard user
          who has learned one has learned the other, and an uncapped pinned set
          can never turn into an uncapped run of tab stops. */}
      <div
        role="toolbar"
        aria-label="Quick launch"
        aria-orientation="horizontal"
        onKeyDown={handleToolbarKeyDown}
        className="flex w-full flex-wrap items-center justify-center gap-2"
      >
        {chips.map((chip, index) => (
          <QuickAction
            key={chip.key}
            icon={chip.icon}
            label={chip.label}
            actionId={chip.actionId}
            onClick={chip.onClick}
            tabIndex={index === activeChip ? 0 : -1}
            buttonRef={setChipRef(index)}
            onFocus={() => setActiveChip(index)}
            onKeyDown={(e) => handleChipKeyDown(e, index)}
          />
        ))}
      </div>
    </div>
  );
}
