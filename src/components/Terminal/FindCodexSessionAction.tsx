import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { buildResumeCommand } from "@shared/types";
import { formatTimeAgo } from "@/utils/timeAgo";
import { logWarn, logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { codexClient } from "@/clients/codexClient";
import type {
  AgentSubagentUnavailableReason,
  CodexFolderSession,
  CodexFolderSessionsResult,
} from "@shared/types/ipc/agentSubagents";

// Only the reasons `listCodexSessionsForCwd` can actually surface: it queries
// the app-server directly rather than resolving a terminal, so the
// terminal/session-attribution reasons in the shared taxonomy never reach here.
function findSessionsErrorMessage(reason: AgentSubagentUnavailableReason): string {
  switch (reason) {
    case "cli-missing":
      return "Codex CLI isn't available";
    case "timeout":
      return "Codex took too long to respond";
    default:
      return "Couldn't check for Codex sessions";
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * "Find session" action on the lost-session banner (#12182): lists this
 * pane's folder's Codex sessions and reopens the chosen one in a new pane.
 *
 * Codex-only — the other agents have no equivalent read-only index to ask,
 * so this renders nothing for them. Read-only throughout: picking a session
 * opens it in a NEW pane via the ordinary `codex resume <id>` launch path,
 * the same one restore itself uses. Nothing here writes to Codex's own
 * config, and a session's `preview` (conversation text) never leaves this
 * component — it is rendered, not logged.
 */
export function FindCodexSessionAction({ panelId }: { panelId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [result, setResult] = useState<CodexFolderSessionsResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Sibling-held session ids at the moment sessions were last fetched — see
  // the load() callback below for why this is computed there rather than
  // read here at render time.
  const [heldElsewhere, setHeldElsewhere] = useState<ReadonlySet<string>>(new Set());
  const showSpinner = useDohertyGate(isLoading);
  const addPanel = usePanelStore((state) => state.addPanel);

  const {
    agentId,
    cwd,
    codexHome,
    worktreeId,
    env,
    agentLaunchFlags,
    agentModelId,
    agentPresetId,
    agentPresetColor,
  } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[panelId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      const env = pty?.env;
      const codexHomeKey = env
        ? Object.keys(env).find((key) => key.toUpperCase() === "CODEX_HOME")
        : undefined;
      return {
        // Live detection wins, launch affinity as the fallback — matches
        // `SubagentChip`, so a pane relaunched onto another agent stops
        // offering this the same way it stops answering for the old one.
        agentId: pty?.runtimeIdentity?.agentId ?? pty?.launchAgentId,
        cwd: pty?.cwd,
        codexHome: codexHomeKey ? env?.[codexHomeKey] : undefined,
        // The reopened pane inherits this pane's launch shape: `worktreeId`
        // because the grid only renders the active worktree's bucket, so a
        // worktree-less pane is invisible whenever one is active (#11290),
        // and `env` because the sessions were listed under this pane's
        // CODEX_HOME — resuming under main's default profile wouldn't find them.
        worktreeId: pty?.worktreeId,
        env,
        agentLaunchFlags: pty?.agentLaunchFlags,
        agentModelId: pty?.agentModelId,
        agentPresetId: pty?.agentPresetId,
        agentPresetColor: pty?.agentPresetColor,
      };
    })
  );

  const load = useCallback(() => {
    if (!cwd || isLoading) return;
    setIsLoading(true);
    void codexClient
      .findSessions({ cwd, codexHome })
      .then((response) => {
        setResult(response);
        // A sibling pane already holding one of these conversations isn't
        // worth offering back — reopening it would put two writers on one
        // transcript, exactly the collision restore's own suppression exists
        // to prevent (#11461). Snapshotted here, at fetch time, rather than
        // read live during render: a render body reading the store outside
        // its subscribed selector is impure and the React Compiler bails out
        // on it, and this list only matters while the popover is open anyway
        // — it doesn't need to track panes that open or close in the
        // background.
        const held = new Set<string>();
        for (const panel of Object.values(usePanelStore.getState().panelsById)) {
          if (panel.id === panelId || !isPtyPanel(panel)) continue;
          const heldAgentId = panel.runtimeIdentity?.agentId ?? panel.launchAgentId;
          if (heldAgentId === "codex" && panel.agentSessionId) held.add(panel.agentSessionId);
        }
        setHeldElsewhere(held);
      })
      .catch((error: unknown) => {
        logWarn(
          `[FindCodexSessionAction] query failed: ${formatErrorMessage(error, "unknown error")}`
        );
        setResult({ status: "unavailable", reason: "protocol-error" });
      })
      .finally(() => setIsLoading(false));
  }, [cwd, codexHome, isLoading, panelId]);

  if (agentId !== "codex") return null;

  const sessions: CodexFolderSession[] =
    result?.status === "ok"
      ? result.sessions.filter((session) => !heldElsewhere.has(session.id))
      : [];

  const openSession = async (session: CodexFolderSession) => {
    if (!cwd) return;
    const command = buildResumeCommand("codex", session.id, agentLaunchFlags);
    if (!command) return;
    setIsOpen(false);
    try {
      await addPanel({
        kind: "terminal",
        cwd,
        worktreeId,
        launchAgentId: "codex",
        agentSessionId: session.id,
        command,
        agentLaunchFlags,
        agentModelId,
        agentPresetId,
        agentPresetColor,
        env,
      });
    } catch (error) {
      logError("[FindCodexSessionAction] failed to open session", error);
    }
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open && result === null) load();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-border-default/50 transition-colors outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <Search className="w-3 h-3" aria-hidden="true" />
          Find session
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
          <span className="text-xs font-medium text-text-primary">
            Codex sessions in this folder
          </span>
          <button
            type="button"
            onClick={load}
            disabled={isLoading}
            className="text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:pointer-events-none"
            aria-label="Refresh sessions"
          >
            <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} aria-hidden="true" />
          </button>
        </div>
        {result === null ? (
          showSpinner ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-secondary">
              <Spinner size="sm" />
              Looking for sessions
            </div>
          ) : null
        ) : result.status === "unavailable" ? (
          <p className="px-3 py-3 text-xs text-text-secondary">
            {findSessionsErrorMessage(result.reason)}
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-3 text-xs text-text-secondary">No other sessions found here</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {sessions.map((session) => (
              <li key={session.id} className="border-b border-divider last:border-b-0">
                <button
                  type="button"
                  onClick={() => void openSession(session)}
                  className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-overlay-subtle transition-colors"
                >
                  <span className="text-xs text-text-primary truncate w-full">
                    {firstLine(session.preview).slice(0, 80) || session.id.slice(0, 8)}
                  </span>
                  {session.updatedAt > 0 && (
                    <span className="text-3xs text-text-placeholder tabular-nums">
                      {formatTimeAgo(session.updatedAt)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
