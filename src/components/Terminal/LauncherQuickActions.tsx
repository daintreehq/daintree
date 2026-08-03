import { useMemo } from "react";
// `FolderTree` is the file browser's own icon, imported from lucide directly
// the same way `FileBrowserPane` does — it has no alias in the icons index.
import { SquareTerminal, Search, FolderTree } from "lucide-react";
import { KbdChord } from "@/components/ui/Kbd";
import { useEffectiveCombo, useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
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
}

function QuickAction({ icon, label, actionId, onClick }: QuickActionProps) {
  const combo = useEffectiveCombo(actionId);
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={ariaKeyshortcuts}
      className="launcher-press group inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-overlay-subtle px-2.5 py-1.5 text-sm text-daintree-text/80 transition-colors active:scale-[0.98] active:duration-[1ms] hover:bg-overlay-soft hover:border-border-default hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
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
 * anything" affordance, and its single most capable control (it reaches every
 * agent, panel kind, and resumable session). Carries a slightly raised surface
 * so it reads as the deliberate escape hatch rather than blending into the
 * quieter chips above — the launcher's one visually-weighted control (neutral,
 * never accent). The palette itself is the real search field.
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
      className="launcher-press flex w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-border-default bg-overlay-soft px-3 py-2.5 text-sm text-daintree-text/70 transition-colors active:scale-[0.98] active:duration-[1ms] hover:bg-overlay-medium hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
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
 * Compact launch row for the empty grid — the built-in agents the user keeps on
 * their toolbar plus the core "new terminal" action, with the panel palette one
 * step below. Recipes are the hero above this; these are the fallback launches
 * when no recipe fits.
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
    // drops every non-agent button (terminal, browser, agent-tray, settings, …)
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

  // The only chip whose action can legitimately refuse: it resolves its own
  // target, and a workspace with nothing to browse makes it throw. `dispatch`
  // turns that into `ok: false` rather than a rejection, so without this the
  // press would do nothing at all — the silent failure the throw exists to end.
  // A function declaration so the retry action can name it.
  function openFileBrowser() {
    void actionService
      .dispatch("worktree.openFileBrowser", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) return;
        notify({
          type: "error",
          title: "Couldn't open the file browser",
          // Purpose-written rather than the raw error: both refusals this can
          // hit ("No folder to browse", a worktree that no longer exists) come
          // down to the same thing for the user, and the recovery is the same.
          message: "No folder resolved for this workspace. Select a worktree and try again.",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: openFileBrowser },
        });
      });
  }

  return (
    <div className="flex w-full max-w-[38rem] flex-col items-center gap-2.5">
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        {agents.map((agent) => {
          // Every launcher agent is a built-in toolbar agent, so it carries a
          // canonical `agent.<id>` action (keybinding + label).
          const actionId = `agent.${agent.launchAgentId!}` as ActionId;
          return (
            <QuickAction
              key={agent.id}
              icon={agent.icon}
              label={agent.label}
              actionId={actionId}
              onClick={() => dispatch(actionId)}
            />
          );
        })}
        <QuickAction
          icon={<SquareTerminal className="h-4 w-4" />}
          label="New terminal"
          actionId="terminal.new"
          onClick={() => dispatch("terminal.new")}
        />
        {/* No args: the action resolves its own target — the focused worktree,
            or the workspace root in a scratch or worktree-less project
            (#11482), which is exactly where this launcher is shown. */}
        <QuickAction
          icon={<FolderTree className="h-4 w-4" />}
          label="Browse files"
          actionId="worktree.openFileBrowser"
          onClick={openFileBrowser}
        />
      </div>
      <PaletteSearchButton />
    </div>
  );
}
