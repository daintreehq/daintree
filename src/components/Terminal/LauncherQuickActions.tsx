import { useMemo, useSyncExternalStore } from "react";
import { SquareTerminal, Search } from "lucide-react";
import { KbdChord } from "@/components/ui/Kbd";
import { useEffectiveCombo, useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { getLaunchOptions } from "@/components/TerminalPalette/launchOptions";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { ActionId } from "@shared/types/actions";

// Cap the agent row so a user with many agents installed still gets a tight
// launcher rather than a wall of buttons — the rest stay one keystroke away in
// the panel palette ("New panel…", ⌘N).
const MAX_AGENTS = 5;

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
      className="group inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-overlay-subtle px-2.5 py-1.5 text-sm text-daintree-text/80 transition-colors hover:bg-overlay-soft hover:border-border-default hover:text-daintree-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
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
 * anything" affordance. Same quiet surface as the QuickAction chips (it's a
 * peer launch affordance, not an elevated input); only the shape and Search
 * icon say "search". The palette itself is the real search field.
 */
function PaletteSearchButton() {
  const combo = useEffectiveCombo("panel.palette");
  const ariaKeyshortcuts = useAriaKeyshortcuts("panel.palette");
  return (
    <button
      type="button"
      onClick={() => void actionService.dispatch("panel.palette", undefined, { source: "user" })}
      aria-keyshortcuts={ariaKeyshortcuts}
      className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-daintree-text/55 transition-colors hover:bg-overlay-soft hover:border-border-default hover:text-daintree-text/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
    >
      <Search className="h-4 w-4 shrink-0 text-daintree-text/40" aria-hidden="true" />
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
 * Compact launch row for the empty grid — installed agents plus the two core
 * "start something" actions (new terminal, panel palette). Recipes are the hero
 * above this; these are the fallback launches when no recipe fits. Agent
 * visibility mirrors the panel palette (installed built-ins + all plugin
 * agents) so the canvas and ⌘N never disagree about what's launchable.
 */
export function LauncherQuickActions() {
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isInitialized = useCliAvailabilityStore((state) => state.isInitialized);
  // Re-derive the roster when plugin- or user-contributed agents load/unload
  // mid-session, matching usePanelPalette — otherwise a freshly installed
  // plugin agent wouldn't appear until CLI availability happened to change.
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot
  );
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);

  const agents = useMemo(() => {
    void pluginAgentRegistry;
    void userRegistry;
    return getLaunchOptions()
      .filter((option) => Boolean(option.launchAgentId))
      .filter((option) => {
        const id = option.launchAgentId!;
        // Optimistically show until the first availability probe lands, then
        // hide only uninstalled built-ins — plugin agents are always shown
        // (their command may be unresolved; mirrors usePanelPalette #10560).
        if (!isInitialized) return true;
        if (!isBuiltInAgentId(id)) return true;
        return isAgentInstalled(availability[id]);
      })
      .slice(0, MAX_AGENTS);
  }, [availability, isInitialized, pluginAgentRegistry, userRegistry]);

  const dispatch = (actionId: ActionId, args?: Record<string, unknown>) => {
    void actionService.dispatch(actionId, args, { source: "user" });
  };

  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-2.5">
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        {agents.map((agent) => {
          const id = agent.launchAgentId!;
          // Built-ins carry a canonical `agent.<id>` action (keybinding + label);
          // plugin agents have none, so route them through the generic launcher.
          const builtIn = isBuiltInAgentId(id);
          const actionId = (builtIn ? `agent.${id}` : "agent.launch") as ActionId;
          return (
            <QuickAction
              key={agent.id}
              icon={agent.icon}
              label={agent.label}
              actionId={actionId}
              onClick={() =>
                builtIn ? dispatch(actionId) : dispatch("agent.launch", { agentId: id })
              }
            />
          );
        })}
        <QuickAction
          icon={<SquareTerminal className="h-4 w-4" />}
          label="New terminal"
          actionId="terminal.new"
          onClick={() => dispatch("terminal.new")}
        />
      </div>
      <PaletteSearchButton />
    </div>
  );
}
