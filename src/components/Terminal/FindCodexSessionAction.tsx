import { Fragment, useCallback, useId, useRef, useState, type ReactNode } from "react";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useShallow } from "zustand/react/shallow";
import { Search, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { buildResumeCommand } from "@shared/types";
import { reconcileResumeLaunchFlags } from "@/services/agentResume";
import { logWarn, logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { codexClient } from "@/clients/codexClient";
import type {
  AgentSubagentUnavailableReason,
  CodexFolderSession,
  CodexFolderSessionsResult,
} from "@shared/types/ipc/agentSubagents";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import {
  POPOVER_HEADER_ACTION_CLASS,
  POPOVER_HEADER_CLASS,
  POPOVER_ROW_HOVER_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { resolveConversationSearchCwd } from "@/utils/restoreRecovery";
import { Button } from "@/components/ui/button";
import {
  siblingHeldSessionIds,
  type RestoreRecoveryLaunchResult,
} from "@/services/terminal/restoreRecoveryLaunch";

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

const SKELETON_PREVIEW_WIDTHS = ["w-4/5", "w-3/5", "w-2/3"] as const;

/**
 * Bounds what a row carries — a pasted log as a first message is still text
 * every row lays out. Far past where two sessions with one opening diverge;
 * the tooltip scrolls rather than growing to fit it.
 */
const PREVIEW_MAX_CHARS = 4000;

/**
 * Where an unnamed row's accessible name stops. More than two lines of the
 * popover can ever show, so everything visible is in the name (WCAG 2.5.3)
 * while the rest of a long message describes the row instead of naming it.
 */
const LEAD_MAX_CHARS = 160;

/**
 * A first message as it reads rather than as it was typed: blank lines and
 * code-fence markers dropped and whitespace collapsed, so a row's two lines are
 * words, not an empty line or a bare ```ts. Everything after the first line is
 * kept — sessions that open with the same sentence are told apart further on.
 */
function sessionPreviewText(value: string): string {
  const text = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(```|~~~)/.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…` : text;
}

/**
 * Split off a short lead to name the row by; the rest describes it. The cut
 * moves forward to the next word, never back: a long path straddling the limit
 * would otherwise pull the name back to before it, leaving visible words out.
 * A token that runs on past a few more words is cut mid-token instead.
 */
function splitLead(text: string): [lead: string, rest: string] {
  if (text.length <= LEAD_MAX_CHARS) return [text, ""];
  const next = text.indexOf(" ", LEAD_MAX_CHARS);
  const at = next !== -1 && next - LEAD_MAX_CHARS <= 40 ? next : LEAD_MAX_CHARS;
  return [text.slice(0, at), text.slice(at)];
}

/**
 * Lets a path wrap after each `/`. First messages are full of them, and an
 * unbroken `src/components/…` otherwise drops whole to the next line, leaving
 * the first line half empty in exactly the rows that need the room.
 */
function breakAfterSlashes(text: string): ReactNode {
  if (!text.includes("/")) return text;
  return text.split(/(?<=\/)/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

/** Whether an element's text is cut off, by a single-line ellipsis or a line clamp. */
function useClipped<T extends HTMLElement>(): [(el: T | null) => (() => void) | void, boolean] {
  const [clipped, setClipped] = useState(false);
  const ref = useCallback((el: T | null) => {
    if (!el) return;
    const check = () =>
      setClipped(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, clipped];
}

/** The popover's width (`w-80`) and how far it keeps from its pane's edges. */
const POPOVER_WIDTH = 320;
const PANE_INSET = 4;

interface PanePlacement {
  align: "start" | "end";
  alignOffset: number;
  width: number | undefined;
}

/**
 * Open toward the pane's interior and stay inside it. The trigger sits at the
 * left of the session-lost banner, at the right of the quit-to-shell banner on
 * a wide pane (and back at the left once its controls wrap), and at the right
 * of the restore gate — so one fixed alignment always hangs the list over a
 * neighbouring pane somewhere. Only the horizontal is held to the pane: a short
 * pane would squash or flip the list, and below it is the popover's to use.
 */
function placeWithinPane(trigger: HTMLElement | null): PanePlacement {
  const pane = trigger?.closest("[data-panel-id]");
  if (!trigger || !pane) return { align: "end", alignOffset: 0, width: undefined };
  const t = trigger.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  const width = Math.min(POPOVER_WIDTH, p.width - PANE_INSET * 2);
  if (t.left + t.width / 2 < p.left + p.width / 2) {
    const overflow = t.left + width - (p.right - PANE_INSET);
    return { align: "start", alignOffset: overflow > 0 ? -overflow : 0, width };
  }
  // Radix reverses the offset for `end`, so a negative one moves it right here.
  const overflow = p.left + PANE_INSET - (t.right - width);
  return { align: "end", alignOffset: overflow > 0 ? -overflow : 0, width };
}

function SessionRow({
  session,
  onOpen,
}: {
  session: CodexFolderSession;
  onOpen: (session: CodexFolderSession) => void;
}) {
  const rowId = useId();
  const [nameRef, nameClipped] = useClipped<HTMLSpanElement>();
  const [previewRef, previewClipped] = useClipped<HTMLSpanElement>();
  const name = session.name?.trim() || undefined;
  const preview = sessionPreviewText(session.preview);
  const [lead, rest] = name ? [name, preview] : splitLead(preview);
  const leadId = `${rowId}-lead`;
  const restId = `${rowId}-rest`;
  const ageId = `${rowId}-age`;
  const hasAge = session.updatedAt > 0;

  return (
    // The tooltip IS the content of a clipped row — the first message in full,
    // which is what tells two sessions with the same opening apart — so it stays
    // while it is read (no auto-dismiss) and can be hovered (WCAG 1.4.13). On
    // the row button rather than its text, so keyboard focus opens it too.
    <Tooltip
      open={nameClipped || previewClipped ? undefined : false}
      autoDismiss={false}
      disableHoverableContent={false}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen(session)}
          // Named by the name, or the first words of an unnamed session's
          // message, and its age; the rest of the message describes it. The
          // whole message as the name would make every row a paragraph.
          aria-labelledby={hasAge ? `${leadId} ${ageId}` : leadId}
          aria-describedby={rest ? restId : undefined}
          className={cn(
            "w-full flex items-baseline gap-3 px-3 py-2 text-left",
            POPOVER_ROW_HOVER_CLASS,
            PALETTE_ROW_FOCUS_CLASS
          )}
        >
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            {name ? (
              <>
                <span
                  ref={nameRef}
                  id={leadId}
                  className="truncate text-xs font-medium text-text-primary"
                >
                  {name}
                </span>
                {preview && (
                  // One line under a name: the name is what the user chose to
                  // tell this session apart by, so every row stays two lines.
                  <span
                    ref={previewRef}
                    id={restId}
                    className="line-clamp-1 wrap-anywhere text-xs text-text-secondary"
                  >
                    {breakAfterSlashes(preview)}
                  </span>
                )}
              </>
            ) : preview ? (
              <span
                ref={previewRef}
                className="line-clamp-2 wrap-anywhere text-xs text-text-primary"
              >
                <span id={leadId}>{breakAfterSlashes(lead)}</span>
                {rest && <span id={restId}>{breakAfterSlashes(rest)}</span>}
              </span>
            ) : (
              <span id={leadId} className="text-xs text-text-secondary">
                No preview
              </span>
            )}
          </span>
          {hasAge && (
            // Its own column, so recency runs down one edge the eye can scan
            // whatever each preview's length — and it never truncates.
            <span id={ageId} className="shrink-0 text-2xs text-text-secondary">
              <span className="sr-only">last active </span>
              <TimeAgo timestamp={session.updatedAt} />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        // Hoverable, so a message longer than the card scrolls under the pointer.
        className="flex max-h-72 flex-col gap-1 overflow-y-auto wrap-anywhere"
      >
        {name && <span className="font-medium">{name}</span>}
        {preview && (
          <span className={cn(name && "text-text-secondary")}>{breakAfterSlashes(preview)}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export interface FindCodexSessionActionProps {
  panelId: string;
  /**
   * Replace "open in a new pane" with the caller's own launch — a pane held for
   * recovery opens the pick in place (#12434). Answering `held-elsewhere` drops
   * that row from the list.
   */
  onOpenSession?: (sessionId: string) => Promise<RestoreRecoveryLaunchResult>;
}

/**
 * "Find session" action on the lost-session banner (#12182): lists the Codex
 * sessions filed under this pane's conversation folder and reopens the chosen
 * one in a new pane.
 *
 * Codex-only — the other agents have no equivalent read-only index to ask,
 * so this renders nothing for them. Read-only throughout: picking a session
 * opens it in a NEW pane via the ordinary `codex resume <id>` launch path,
 * the same one restore itself uses. Nothing here writes to Codex's own
 * config, and a session's `preview` (conversation text) never leaves this
 * component — it is rendered, not logged.
 */
export function FindCodexSessionAction({ panelId, onOpenSession }: FindCodexSessionActionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<PanePlacement>({
    align: "end",
    alignOffset: 0,
    width: undefined,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  // Keyed by the folder it was listed for: a held pane moved onto another
  // worktree keeps its conversation folder, but one whose folder did change
  // must not keep offering the old folder's list.
  const [listing, setListing] = useState<{
    searchCwd: string;
    result: CodexFolderSessionsResult;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Sibling-held session ids at the moment sessions were last fetched — see
  // the load() callback below for why this is computed there rather than
  // read here at render time.
  const [heldElsewhere, setHeldElsewhere] = useState<ReadonlySet<string>>(new Set());
  const showSpinner = useDohertyGate(isLoading);
  // With motion off the spin never runs, so the refresh icon steps down to muted.
  const skipMotion = useShouldSkipMotion();
  const addPanel = usePanelStore((state) => state.addPanel);

  const {
    agentId,
    cwd,
    searchCwd,
    codexHome,
    worktreeId,
    env,
    agentLaunchFlags,
    agentModelId,
    agentPresetId,
    agentPresetColor,
    originalPresetId,
    isUsingFallback,
    fallbackChainIndex,
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
        // Where the conversation began, which a moved pane no longer runs in —
        // Codex files it under that folder (#12434).
        searchCwd: pty ? resolveConversationSearchCwd(pty) : undefined,
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
        // Carried too, or a lost pane already running on a fallback preset
        // would present the fallback as though it were the original choice,
        // losing the "was X → now Y" state the fallback chain tracks.
        originalPresetId: pty?.originalPresetId,
        isUsingFallback: pty?.isUsingFallback,
        fallbackChainIndex: pty?.fallbackChainIndex,
      };
    })
  );

  const result = listing !== null && listing.searchCwd === searchCwd ? listing.result : null;

  const load = useCallback(() => {
    if (!searchCwd || isLoading) return;
    const listedFor = searchCwd;
    setIsLoading(true);
    void codexClient
      .findSessions({ cwd: listedFor, codexHome })
      .then((response) => {
        setListing({ searchCwd: listedFor, result: response });
        // A sibling pane already holding one of these conversations isn't
        // worth offering back — reopening it would put two writers on one
        // transcript, exactly the collision restore's own suppression exists
        // to prevent (#11461). Snapshotted here, at fetch time, rather than
        // read live during render: a render body reading the store outside
        // its subscribed selector is impure and the React Compiler bails out
        // on it, and this list only matters while the popover is open anyway
        // — it doesn't need to track panes that open or close in the
        // background. `openSession` below re-checks right before opening, so
        // this snapshot going stale only ever costs a still-listed row, never
        // a duplicate resume.
        setHeldElsewhere(
          siblingHeldSessionIds(usePanelStore.getState().panelsById, panelId, "codex")
        );
      })
      .catch((error: unknown) => {
        logWarn(
          `[FindCodexSessionAction] query failed: ${formatErrorMessage(error, "unknown error")}`
        );
        setListing({
          searchCwd: listedFor,
          result: { status: "unavailable", reason: "protocol-error" },
        });
      })
      .finally(() => setIsLoading(false));
  }, [searchCwd, codexHome, isLoading, panelId]);

  if (agentId !== "codex") return null;

  const sessions: CodexFolderSession[] =
    result?.status === "ok"
      ? result.sessions.filter((session) => !heldElsewhere.has(session.id))
      : [];

  const openSession = async (session: CodexFolderSession) => {
    if (!cwd) return;
    // A sibling can claim this exact conversation in the gap between the list
    // loading and the user picking a row — the popover can sit open for a
    // while. Re-check right before opening rather than trusting the snapshot
    // the list was filtered against (#11461).
    if (
      siblingHeldSessionIds(usePanelStore.getState().panelsById, panelId, "codex").has(session.id)
    ) {
      setHeldElsewhere((prev) => new Set(prev).add(session.id));
      return;
    }
    if (onOpenSession) {
      const outcome = await onOpenSession(session.id);
      if (outcome === "held-elsewhere") {
        setHeldElsewhere((prev) => new Set(prev).add(session.id));
      } else {
        setIsOpen(false);
      }
      return;
    }
    const command = buildResumeCommand(
      "codex",
      session.id,
      reconcileResumeLaunchFlags({ agentId: "codex", agentLaunchFlags })
    );
    if (!command) return;
    setIsOpen(false);
    try {
      await addPanel({
        kind: "terminal",
        cwd,
        worktreeId,
        launchAgentId: "codex",
        agentSessionId: session.id,
        // The picked conversation was filed under the folder it was listed
        // from; keep pointing there if it runs somewhere else (#12434).
        conversationCwd: searchCwd && searchCwd !== cwd ? searchCwd : undefined,
        command,
        agentLaunchFlags,
        agentModelId,
        agentPresetId,
        agentPresetColor,
        originalPresetId,
        isUsingFallback,
        fallbackChainIndex,
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
        if (open) setPlacement(placeWithinPane(triggerRef.current));
        setIsOpen(open);
        if (open && result === null) load();
      }}
    >
      <PopoverTrigger asChild>
        {/* The host's own control: the banner's other actions and the gate's
            buttons are all ghost `sm` Buttons. The fill stays while the list is
            open, so the trigger reads as the thing that opened it. */}
        <Button
          ref={triggerRef}
          size="sm"
          variant="ghost"
          className="aria-expanded:bg-overlay-hover aria-expanded:text-text-primary"
        >
          <Search aria-hidden="true" />
          Find session
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={placement.align}
        alignOffset={placement.alignOffset}
        style={placement.width === undefined ? undefined : { width: placement.width }}
        className="w-80 p-0"
        aria-labelledby={headingId}
      >
        <div className={POPOVER_HEADER_CLASS}>
          <span id={headingId} className={POPOVER_TITLE_CLASS}>
            Codex sessions in this folder
          </span>
          <Button
            ref={refreshRef}
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              if (!isLoading) load();
            }}
            // Not `disabled`: pressing it would drop keyboard focus to the page.
            // The spin is the busy state.
            aria-disabled={isLoading}
            className={POPOVER_HEADER_ACTION_CLASS}
            aria-label="Refresh sessions"
          >
            <SpinningIcon
              icon={RefreshCw}
              active={isLoading}
              className={cn(isLoading && skipMotion && "text-text-muted")}
              aria-hidden
            />
          </Button>
        </div>
        {showSpinner && (result === null || result.status === "unavailable") ? (
          // The rows' own shape — a preview beside its age — so the list lands
          // where the wait was instead of replacing a sentence. A retry after a
          // failure waits here too, rather than under the failure it retries.
          <Skeleton label="Looking for sessions" className="flex flex-col">
            {SKELETON_PREVIEW_WIDTHS.map((width) => (
              <div
                key={width}
                className="flex items-start gap-3 px-3 py-2 border-b border-divider last:border-b-0"
              >
                <div className="flex flex-1 flex-col gap-1.5 py-0.5">
                  <SkeletonBone immediate className="h-3 w-full" />
                  <SkeletonBone immediate className={cn("h-3", width)} />
                </div>
                <SkeletonBone immediate className="h-2.5 w-8 mt-0.5" />
              </div>
            ))}
          </Skeleton>
        ) : result === null ? null : result.status === "unavailable" ? (
          <EmptyState
            variant="zero-data"
            scale="popover"
            title={findSessionsErrorMessage(result.reason)}
            className="py-6"
            action={
              <Button
                variant="link"
                // Retry goes away with the failure, so focus moves to the refresh
                // button it stands in for rather than falling to the page; ringed
                // only when the retry came from the keyboard.
                onClick={(event) => {
                  load();
                  refreshRef.current?.focus({
                    preventScroll: true,
                    focusVisible: event.detail === 0,
                  });
                }}
                className="text-xs"
              >
                Retry
              </Button>
            }
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            variant="zero-data"
            scale="popover"
            title="No other sessions found here"
            className="py-6"
          />
        ) : (
          <ScrollShadow compact className="max-h-80">
            <ul>
              {sessions.map((session) => (
                <li key={session.id} className="border-b border-divider last:border-b-0">
                  <SessionRow session={session} onOpen={(picked) => void openSession(picked)} />
                </li>
              ))}
            </ul>
          </ScrollShadow>
        )}
      </PopoverContent>
    </Popover>
  );
}
