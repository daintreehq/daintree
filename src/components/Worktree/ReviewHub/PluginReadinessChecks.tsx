import { useEffect, useRef, useSyncExternalStore } from "react";
import { isOwnPluginAction } from "@shared/utils/remotePluginContributions";
import type { ActionId } from "@shared/types/actions";
import type { PluginWorktreeReviewCheck } from "@shared/types/plugin";
import { Button } from "@/components/ui/button";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { actionService } from "@/services/ActionService";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import { useProjectStore } from "@/store/projectStore";
import { FocusHandoffGuard } from "../FocusHandoffGuard";
import {
  usePluginWorktreeReviewChecksStore,
  worktreeReviewChecksFor,
  type WorktreeReviewPluginChecks,
} from "@/store/pluginWorktreeReviewChecksStore";

// `secondary`, not `muted`, for the same reason the rail gives: the glyph is the
// only visual severity carrier and owes the 3:1 non-text floor.
const SEVERITY = {
  warning: { Icon: SEVERITY_GLYPH.warning, toneClass: "text-status-warning" },
  info: { Icon: SEVERITY_GLYPH.info, toneClass: "text-text-secondary" },
} as const;

const CTA_CLASS = "h-6 px-2 text-2xs";

/** Every plugin's checks on one worktree, subscribing the store on first use. */
export function useWorktreeReviewPluginChecks(worktreeId: string): WorktreeReviewPluginChecks[] {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const byPlugin = usePluginWorktreeReviewChecksStore((s) =>
    projectId ? s.checksByProject[projectId] : undefined
  );
  useEffect(() => {
    usePluginWorktreeReviewChecksStore.getState().init();
  }, []);
  return worktreeReviewChecksFor(byPlugin, worktreeId);
}

function PluginCheckRow({
  pluginId,
  worktreeId,
  check,
  registeredActions,
  onFocusLeaving,
}: {
  pluginId: string;
  worktreeId: string;
  check: PluginWorktreeReviewCheck;
  registeredActions: ReadonlyMap<string, string>;
  onFocusLeaving: () => void;
}) {
  const { name } = usePluginAttribution(pluginId);
  const { Icon, toneClass } = SEVERITY[check.severity];
  // Runs only the plugin's own action, and only while it is registered; until
  // then the row is the plain text it always was.
  const command =
    check.command !== undefined && isOwnPluginAction(pluginId, check.command)
      ? check.command
      : undefined;
  const actionTitle = command !== undefined ? registeredActions.get(command) : undefined;
  const fullText = check.detail ? `${check.label} — ${check.detail}` : check.label;

  return (
    <li
      data-testid="plugin-readiness-check"
      data-severity={check.severity}
      className="flex items-center gap-2 min-w-0"
    >
      <Icon data-severity-glyph="" className={cn("w-3.5 h-3.5 shrink-0", toneClass)} aria-hidden />
      <span className="sr-only">{`${name}, ${check.severity}: `}</span>
      <TruncatedTooltip content={fullText}>
        <span className="min-w-0 truncate">
          <span className="font-medium text-text-primary">{check.label}</span>
          {check.detail && <span className="ml-1 text-text-secondary"> {check.detail}</span>}
        </span>
      </TruncatedTooltip>
      <span aria-hidden className="max-w-32 shrink-0 truncate text-text-secondary">
        {name}
      </span>
      {command !== undefined && actionTitle !== undefined && (
        // Guarded on the button alone: it goes with its row, and also when
        // the action unregisters while the row stays.
        <FocusHandoffGuard onFocusLeaving={onFocusLeaving}>
          <Button
            variant="subtle"
            size="xs"
            data-testid="plugin-readiness-check-command"
            onClick={() =>
              void actionService.dispatch(command as ActionId, { worktreeId }, { source: "user" })
            }
            className={cn("max-w-40 shrink-0 truncate", CTA_CLASS)}
          >
            {actionTitle.length > 0 ? actionTitle : "Run"}
          </Button>
        </FocusHandoffGuard>
      )}
    </li>
  );
}

/**
 * Advisory checks plugins published for this worktree (#13806), each named
 * after its plugin. Separate from the readiness rail on purpose: nothing here
 * feeds `deriveReviewReadiness`, so a plugin can never change whether commit or
 * push is ready. Renders nothing when no plugin has published any.
 */
export function PluginReadinessChecks({
  worktreeId,
  plugins,
}: {
  worktreeId: string;
  plugins: readonly WorktreeReviewPluginChecks[];
}) {
  // Subscribed, not read from ActionService: a command registering after its
  // check arrived must still make the row's button appear.
  const registeredActions = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );
  const listRef = useRef<HTMLUListElement>(null);
  if (plugins.length === 0) return null;
  // A row whose button had focus can go (the plugin clears its checks, or its
  // action unregisters): the list takes focus rather than leaving the keyboard
  // on the document.
  const handOffFocus = () => listRef.current?.focus({ preventScroll: true });
  return (
    // Bounded: ten checks from several plugins must not push the header and the
    // commit panel out of a short pane.
    <ul
      ref={listRef}
      tabIndex={-1}
      data-testid="plugin-readiness-checks"
      aria-label="Plugin checks"
      className="flex max-h-32 flex-col gap-1 overflow-y-auto px-3 py-1.5 border-b border-divider text-2xs"
    >
      {plugins.flatMap(({ pluginId, checks }) =>
        checks.map((check, index) => (
          // Keyed on what the row is, with the position only to tell identical
          // rows apart, so a removed earlier check cannot hand its focused
          // button to a different command.
          <PluginCheckRow
            key={`${pluginId}:${check.label}:${check.command ?? ""}:${checks.slice(0, index).filter((c) => c.label === check.label && c.command === check.command).length}`}
            pluginId={pluginId}
            worktreeId={worktreeId}
            check={check}
            registeredActions={registeredActions}
            onFocusLeaving={handOffFocus}
          />
        ))
      )}
    </ul>
  );
}
