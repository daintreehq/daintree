import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useShallow } from "zustand/react/shallow";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  BlockedCircle,
  DoneCircle,
  HollowCircle,
  AskingCircle,
  IdleCircle,
  Network,
  SnoozedCircle,
  SpinnerCircle,
} from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Spinner } from "@/components/ui/Spinner";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { CopyButton } from "@/components/ui/CopyButton";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SUBAGENT_PROVIDERS, toSubagentProvider } from "@/clients/subagentProviders";
import { useSubagents } from "@/hooks/useSubagents";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { resolvePluginMarkdownPaths } from "@/components/Markdown/pluginMarkdownPaths";
import {
  subagentAttentionRank,
  subagentFacts,
  subagentFullTitle,
  subagentMatches,
  subagentStatusLabel,
  subagentStatusTone,
  subagentSubtitle,
  subagentUnavailableMessage,
} from "./subagentDisplay";
import {
  isLiveSubagentStatus,
  type AgentSubagent,
  type AgentSubagentMessage,
  type AgentSubagentStatus,
  type AgentSubagentTranscriptResult,
  type SubagentProvider,
} from "@shared/types/ipc/agentSubagents";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS as CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
  holdPaneSelection,
} from "./terminalHeaderChip";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  POPOVER_HEADER_ACTION_CLASS,
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_ROW_HOVER_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { pluralize } from "@/lib/pluralize";

// Replies are almost always markdown, and the renderer pulls react-markdown in,
// so it loads the first time a child is opened rather than with the header.
const LazyMarkdownDocument = lazy(() =>
  import("@/components/Markdown/MarkdownDocument").then((m) => ({ default: m.MarkdownDocument }))
);

const TRANSCRIPT_SKELETON_WIDTHS = ["w-4/5", "w-3/5"] as const;

/**
 * Both levels share one frame. Bounded by the room Radix measured below the
 * chip, so a tall transcript never pushes the popover into a flip.
 */
const FRAME_MAX_HEIGHT = "min(30rem, var(--radix-popover-content-available-height, 30rem))";

/** Past this many children the list grows a filter: a session that fans out wide repeats itself. */
const FILTER_THRESHOLD = 8;

/** A task longer than this opens folded, so the reply under it is on screen. */
const TASK_FOLD_CHARS = 480;
const TASK_FOLD_LINES = 8;

const TONE_CLASSES: Record<"error" | "waiting" | "muted", string> = {
  error: "text-status-error",
  waiting: "text-state-waiting",
  muted: "text-text-secondary",
};

const GLYPH_CLASS = "size-3.5 shrink-0";

/**
 * The child's state in the app's agent-state vocabulary, keyed the way Pilot's
 * run rows key theirs: the spinner and the amber ring are hued because they
 * are live, a failure takes the error hue, and every settled or unobserved
 * state stays neutral. The dashed ring is "nothing observed" — a child the
 * provider never loaded or one whose record stopped making sense — so it reads
 * apart from both the idle dot and the finished check.
 */
function SubagentStatusGlyph({ status }: { status: AgentSubagentStatus }) {
  switch (status.type) {
    case "working":
      return (
        <SpinnerCircle
          className={cn(
            GLYPH_CLASS,
            "text-state-working animate-spin-slow motion-reduce:animate-none"
          )}
        />
      );
    case "blocked":
      return status.reason === "input" ? (
        <AskingCircle className={cn(GLYPH_CLASS, "text-state-waiting")} />
      ) : (
        <HollowCircle className={cn(GLYPH_CLASS, "text-state-waiting")} />
      );
    case "error":
      return <BlockedCircle className={cn(GLYPH_CLASS, "text-status-error")} />;
    case "completed":
      return <DoneCircle className={cn(GLYPH_CLASS, "text-text-secondary")} />;
    case "idle":
      return <IdleCircle className={cn(GLYPH_CLASS, "text-text-secondary")} />;
    case "unknown":
    default:
      return <SnoozedCircle className={cn(GLYPH_CLASS, "text-text-secondary")} />;
  }
}

/**
 * Children that need the user first, the provider's order otherwise. Sorting
 * is stable, and the list only changes when a lookup answers, so nothing moves
 * under the pointer while the popover is being read.
 */
function byAttention(subagents: AgentSubagent[]): AgentSubagent[] {
  return subagents
    .map((subagent, index) => ({ subagent, index }))
    .sort(
      (a, b) =>
        subagentAttentionRank(a.subagent.status) - subagentAttentionRank(b.subagent.status) ||
        a.index - b.index
    )
    .map(({ subagent }) => subagent);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isLongTask(text: string): boolean {
  return text.length > TASK_FOLD_CHARS || text.split("\n").length > TASK_FOLD_LINES;
}

function MessageText({ text, cwd }: { text: string; cwd: string | undefined }) {
  const paths = resolvePluginMarkdownPaths(cwd, cwd);
  // The plain text holds the message's place while the renderer's chunk loads,
  // so the transcript doesn't open blank on the first child anyone looks at.
  const fallback = <p className="text-xs whitespace-pre-wrap break-words">{text}</p>;
  return (
    <Suspense fallback={fallback}>
      <LazyMarkdownDocument
        content={text}
        filePath={paths.filePath}
        rootPath={paths.rootPath}
        fontSize="xs"
        selectAllScope="self"
        className="markdown-message"
      />
    </Suspense>
  );
}

function TranscriptMessage({
  message,
  cwd,
}: {
  message: AgentSubagentMessage;
  cwd: string | undefined;
}) {
  const isTask = message.role === "task";
  const [unfolded, setUnfolded] = useState(false);
  const folded = isTask && !unfolded && isLongTask(message.text);
  const bodyRef = useRef<HTMLDivElement>(null);
  // "Show full task" goes away once pressed, so focus moves into the task it
  // revealed instead of falling to the page; ringed only from the keyboard.
  const unfold = (event: MouseEvent) => {
    setUnfolded(true);
    requestAnimationFrame(() =>
      bodyRef.current?.focus({ preventScroll: true, focusVisible: event.detail === 0 })
    );
  };
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className={LIST_LABEL_CLASS}>{isTask ? "Task" : "Reply"}</span>
        <CopyButton
          text={message.text}
          aria-label={isTask ? "Copy task" : "Copy reply"}
          className="-mr-1.5 text-text-secondary"
        />
      </div>
      {/* The task is what the parent wrote, the reply what the child said
          back: the inset sets the brief apart from the answer so a long
          transcript reads as a conversation rather than one wall of text. */}
      <div className={cn(isTask && "rounded-[var(--radius-md)] bg-overlay-subtle px-2.5 py-2")}>
        {/* Faded with a mask rather than a gradient overlay, so the fold
            matches the inset's fill in every theme without naming it. */}
        {/* Inert while folded: a link below the fold must not take focus
            the eye can't follow. The fade drops out at raised contrast and
            under forced colours, where a wash over real text is the problem. */}
        <div
          ref={bodyRef}
          tabIndex={-1}
          inert={folded}
          className={cn(
            "rounded-[var(--radius-xs)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
            folded &&
              "max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)] contrast-more:[mask-image:none] forced-colors:[mask-image:none]"
          )}
        >
          <MessageText text={message.text} cwd={cwd} />
        </div>
      </div>
      {folded && (
        <Button variant="link" onClick={unfold} className="self-start text-2xs">
          Show full task
        </Button>
      )}
    </li>
  );
}

function TranscriptBody({
  transcript,
  provider,
  cwd,
  onRetry,
}: {
  transcript: AgentSubagentTranscriptResult;
  provider: SubagentProvider;
  cwd: string | undefined;
  onRetry: (event: MouseEvent) => void;
}) {
  if (transcript.status === "unavailable") {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-xs text-text-secondary">
          {subagentUnavailableMessage(transcript.reason, SUBAGENT_PROVIDERS[provider].label)}
        </p>
        <Button variant="link" onClick={onRetry} className="text-xs">
          Retry
        </Button>
      </div>
    );
  }
  if (transcript.messages.length === 0) {
    return (
      <EmptyState
        variant="zero-data"
        scale="popover"
        title="No messages recorded yet"
        // In flow with the transcript it stands in for, not centred in the frame.
        className="items-start px-0 py-1 text-left"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {transcript.truncated && (
        <p className="text-3xs text-text-secondary">Earlier messages aren't shown</p>
      )}
      <ol className="flex flex-col gap-4">
        {transcript.messages.map((message, index) => (
          <TranscriptMessage
            key={`${transcript.subagentId}-${index}`}
            message={message}
            cwd={cwd}
          />
        ))}
      </ol>
    </div>
  );
}

type TranscriptCache = Map<string, { version: number; result: AgentSubagentTranscriptResult }>;

/**
 * One child's own page: who it is, what state it was last seen in, and the
 * conversation it had with the parent. Keyed by child, so moving between
 * children never shows one child's messages under another's name.
 */
function SubagentDetail({
  terminalId,
  provider,
  subagent,
  cwd,
  cache,
  headingId,
}: {
  terminalId: string;
  provider: SubagentProvider;
  subagent: AgentSubagent;
  cwd: string | undefined;
  cache: TranscriptCache;
  headingId: string;
}) {
  const cached = cache.get(subagent.id);
  const [transcript, setTranscript] = useState<AgentSubagentTranscriptResult | null>(
    cached?.result ?? null
  );
  const [isLoading, setIsLoading] = useState(false);
  // The child's `updatedAt` at the moment we last fetched. Holding the version
  // rather than a boolean is what makes a child that ran again reload instead
  // of showing messages from before its latest run.
  const [loadedFor, setLoadedFor] = useState<number | null>(cached?.version ?? null);
  const showSpinner = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);
  const facts = subagentFacts(subagent);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tone = subagentStatusTone(subagent.status);

  const load = useCallback(() => {
    if (isLoading) return;
    const version = subagent.updatedAt;
    setIsLoading(true);
    setLoadedFor(version);
    void SUBAGENT_PROVIDERS[provider]
      .readTranscript({ terminalId, subagentId: subagent.id })
      .then((result) => {
        if (result.status === "ok") cache.set(subagent.id, { version, result });
        setTranscript(result);
      })
      .catch((error: unknown) => {
        logWarn(
          `[SubagentChip] transcript read failed: ${formatErrorMessage(error, "unknown error")}`
        );
        setTranscript({
          status: "unavailable",
          reason: SUBAGENT_PROVIDERS[provider].fallbackReason,
        });
      })
      .finally(() => setIsLoading(false));
  }, [cache, isLoading, provider, terminalId, subagent.id, subagent.updatedAt]);

  // Fetch on open, and again if the child has run since we last looked.
  useEffect(() => {
    if (loadedFor === subagent.updatedAt) return;
    load();
  }, [loadedFor, subagent.updatedAt, load]);

  // Clearing the version is the retry: the effect above sees the mismatch and
  // refetches, so there is one load path rather than two. The failed answer is
  // dropped with it, so the retry shows its own progress.
  // Retry takes itself away, so focus moves to the child's heading.
  const retry = useCallback((event: MouseEvent) => {
    setTranscript(null);
    setLoadedFor(null);
    headingRef.current?.focus({ preventScroll: true, focusVisible: event.detail === 0 });
  }, []);

  return (
    <div className="flex flex-col gap-4 px-3 pt-3 pb-4">
      <div className="flex flex-col gap-1.5">
        <h3
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="rounded-[var(--radius-xs)] text-sm font-medium text-text-primary break-words outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          {subagentFullTitle(subagent)}
        </h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-secondary">
          <span className={cn("flex items-center gap-1.5 font-medium", TONE_CLASSES[tone])}>
            <SubagentStatusGlyph status={subagent.status} />
            {subagentStatusLabel(subagent.status)}
          </span>
          {subagent.updatedAt > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Updated <TimeAgo timestamp={subagent.updatedAt} />
              </span>
            </>
          )}
        </div>
        {facts.length > 0 && (
          <p className="text-2xs text-text-secondary break-words">{facts.join(" · ")}</p>
        )}
      </div>
      <div className="border-t border-divider pt-3">
        {showSpinner &&
          (transcript === null ? (
            // The first read has nothing to show yet, so it holds the
            // messages' own shape: a label over a line or two of text.
            <Skeleton label="Loading transcript" className="flex flex-col gap-3">
              {TRANSCRIPT_SKELETON_WIDTHS.map((width) => (
                <div key={width} className="flex flex-col gap-1.5">
                  <SkeletonBone immediate className="h-2.5 w-10" />
                  <SkeletonBone immediate className={cn("h-3", width)} />
                </div>
              ))}
            </Skeleton>
          ) : (
            // A refresh keeps the messages already read and says so above them.
            <span
              className="mb-3 flex items-center gap-2 text-2xs text-text-secondary"
              role="status"
            >
              <Spinner size="sm" />
              Loading newer messages
            </span>
          ))}
        {transcript !== null && (
          <TranscriptBody transcript={transcript} provider={provider} cwd={cwd} onRetry={retry} />
        )}
      </div>
    </div>
  );
}

function SubagentListRow({
  subagent,
  onOpen,
  rowRef,
}: {
  subagent: AgentSubagent;
  onOpen: (event: MouseEvent) => void;
  rowRef: (node: HTMLButtonElement | null) => void;
}) {
  const subtitle = subagentSubtitle(subagent);
  const tone = subagentStatusTone(subagent.status);
  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        ref={rowRef}
        type="button"
        data-subagent-row=""
        onClick={onOpen}
        className={cn(
          "group w-full flex items-start gap-2.5 px-3 py-2 text-left",
          POPOVER_ROW_HOVER_CLASS,
          PALETTE_ROW_FOCUS_CLASS
        )}
      >
        <span className="flex h-4 items-center">
          <SubagentStatusGlyph status={subagent.status} />
        </span>
        {/* Two lines, two columns: what the child is on the left, what state
            it is in and when on the right, so the status sits in one column
            the eye can run down whatever each name's length. */}
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-baseline gap-3">
            <span className="flex-1 min-w-0 text-xs leading-4 font-medium text-text-primary truncate">
              {/* The full title, cut by the row's own width: a task-derived title
                  sliced to a fixed length ends mid-word with no ellipsis. */}
              {subagentFullTitle(subagent)}
            </span>
            <span className={cn("shrink-0 text-2xs font-medium", TONE_CLASSES[tone])}>
              {subagentStatusLabel(subagent.status)}
            </span>
          </span>
          {(subtitle || subagent.updatedAt > 0) && (
            <span className="flex items-baseline gap-3">
              <span className="flex-1 min-w-0 text-2xs text-text-secondary truncate">
                {subtitle}
              </span>
              {subagent.updatedAt > 0 && (
                <TimeAgo
                  timestamp={subagent.updatedAt}
                  className="shrink-0 text-3xs text-text-secondary tabular-nums"
                />
              )}
            </span>
          )}
        </span>
        <ChevronRight
          className="size-3.5 shrink-0 self-center text-text-secondary group-hover:text-text-primary"
          aria-hidden="true"
        />
      </button>
    </li>
  );
}

/** Up, Down, Home and End walk the rows; Tab still leaves the list. */
function moveRowFocus(event: KeyboardEvent<HTMLUListElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-subagent-row]")
  );
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowDown"
          ? Math.min(rows.length - 1, current + 1)
          : Math.max(0, current - 1);
  event.preventDefault();
  rows[next]?.focus();
}

/**
 * Read-only list of the child sessions this terminal's agent spawned, hung off
 * the terminal's own header rather than a floating overlay — the bottom-right
 * corner of a pane already belongs to `ArtifactOverlay` and the fleet pill, and
 * an agent TUI is full-height, so a footer strip would cost it rows.
 *
 * Two levels in one frame: the list, and a child's own page with its
 * transcript. A transcript is the thing worth reading here, so it gets the
 * whole frame rather than a slot inside the list.
 *
 * One component for every provider that can report children. Renders nothing
 * until a query actually finds some, so a terminal that never delegates never
 * grows an affordance. Nothing here can steer a child: both providers are read
 * paths, and there is no way in from this UI.
 */
export function SubagentChip({ terminalId }: { terminalId: string }) {
  const { provider, agentState, hasPty, generation, cwd } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // The header's own rule for which agent the pane is running: live
        // detection first, launch affinity until detection rehydrates after a
        // restore, and nothing once the agent has exited back to the shell —
        // launch affinity outlives the agent, and the chip must not.
        provider: toSubagentProvider(getBuiltInRuntimeAgentId(pty)),
        agentState: pty?.agentState,
        hasPty: pty?.hasPty !== false,
        // Distinguishes a respawn from the process that held this panel id
        // before it, and a relaunch inside the same shell from the session
        // before it, so neither can inherit the old session's list.
        generation: `${pty?.startedAt ?? 0}:${pty?.agentIncarnation ?? 0}`,
        // Where a reply's relative links resolve from.
        cwd: pty?.cwd,
      };
    })
  );

  const active = hasPty ? provider : null;
  const headingId = useId();
  const detailHeadingId = useId();
  // Set by a press of refresh and cleared when the popover next opens, so the
  // status node speaks for a refresh the user asked for, not a background one
  // that happened while they were elsewhere.
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listScrollTop = useRef(0);
  const [query, setQuery] = useState("");
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // Lives as long as the chip, so reopening a child it already read shows the
  // messages at once and refetches only if the child has run since.
  const [transcriptCache] = useState<TranscriptCache>(() => new Map());
  // Which way focus should land after the level changes, and whether to ring it.
  const pendingFocus = useRef<{ to: "back" | "row"; id: string; visible: boolean } | null>(null);
  // With motion off the spin never runs, so the icon steps down to muted — the one
  // busy cue left once refresh stopped being natively disabled.
  const skipMotion = useShouldSkipMotion();
  const { result, isLoading, refresh, refreshError, checkedAt } = useSubagents(terminalId, {
    provider: active,
    agentState,
    generation,
  });

  const selected =
    selectedId !== null && result?.status === "ok"
      ? (result.subagents.find((subagent) => subagent.id === selectedId) ?? null)
      : null;

  // Focus follows the level: into the child's page on the way in, back onto
  // the row it came from on the way out, so it never falls to the page when
  // the element that held it is hidden.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    // Put the list back where it was left before focusing into it, so the row
    // comes back in place rather than being scrolled to the frame's edge.
    if (pending.to === "row" && listScrollRef.current) {
      listScrollRef.current.scrollTop = listScrollTop.current;
    }
    const target = pending.to === "back" ? backButtonRef.current : rowRefs.current.get(pending.id);
    target?.focus({ preventScroll: pending.to === "back", focusVisible: pending.visible });
  });

  // The provider check is belt-and-braces over the hook's own key guard: a list
  // read from one agent's store must never be rendered as another's.
  if (!active || result?.status !== "ok" || result.provider !== active) return null;
  if (result.subagents.length === 0) return null;

  const subagents = byAttention(result.subagents);
  const filterable = subagents.length > FILTER_THRESHOLD;
  const shown = filterable
    ? subagents.filter((subagent) => subagentMatches(subagent, query))
    : subagents;
  const label = SUBAGENT_PROVIDERS[result.provider].label;
  const waiting = subagents.filter((subagent) => subagent.status.type === "blocked").length;
  // The number on the chip is what is running now, never the session's
  // history: the list keeps every child the session spawned, finished or not.
  // Codex gets no number at all — its store reports almost every child as not
  // loaded, so running and finished look the same, and it is only re-read
  // when the parent settles. A count there would claim liveness nobody saw.
  const live = subagents.filter((subagent) => isLiveSubagentStatus(subagent.status)).length;
  const count = result.provider === "claude" && live > 0 ? live : null;
  const recorded = pluralize(subagents.length, `${label} subagent`);
  // "None running" only when every child was seen to stop: an unknown one may
  // be mid-way through a long tool call that writes nothing.
  const noneRunning =
    result.provider === "claude" &&
    subagents.every((subagent) => subagent.status.type !== "unknown");
  const summary =
    count !== null
      ? `${pluralize(count, `${label} subagent`)} running`
      : noneRunning
        ? `${recorded}, none running`
        : recorded;
  const waitingNote = waiting > 0 ? `${waiting} waiting on you` : null;
  const failed = subagents.filter((subagent) => subagent.status.type === "error").length;
  const attentionNote =
    [waitingNote, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(", ") || null;
  // The header answers the first question before any row is read: does
  // anything need me. The total follows, so a quiet list still says its size.
  const headerMeta = [
    waiting > 0 ? `${waiting} waiting` : null,
    failed > 0 ? pluralize(failed, "error") : null,
    count !== null ? `${count} running` : null,
    filterable && query.trim()
      ? `${shown.length} of ${subagents.length}`
      : pluralize(subagents.length, "subagent"),
  ]
    .filter(Boolean)
    .join(" · ");
  const refreshErrorMessage = refreshError ? subagentUnavailableMessage(refreshError, label) : null;
  // A retry in flight outranks the failure it is retrying; the visible notice
  // stays up until the new answer lands.
  const announcement =
    refreshRequested && isLoading
      ? "Refreshing subagents"
      : refreshErrorMessage
        ? `Couldn't refresh: ${refreshErrorMessage}`
        : refreshRequested
          ? "Subagents updated"
          : "";
  const requestRefresh = () => {
    if (isLoading) return;
    setRefreshRequested(true);
    refresh();
  };
  // The notice's Retry goes away with the notice, so focus moves to the refresh
  // button it stands in for; ringed only when the press came from the keyboard.
  const retryRefresh = (event: MouseEvent) => {
    refreshButtonRef.current?.focus({ preventScroll: true, focusVisible: event.detail === 0 });
    requestRefresh();
  };
  const openChild = (id: string, event: MouseEvent) => {
    listScrollTop.current = listScrollRef.current?.scrollTop ?? 0;
    pendingFocus.current = { to: "back", id, visible: event.detail === 0 };
    setSelectedId(id);
  };
  const closeChild = (visible: boolean) => {
    if (selectedId === null) return;
    pendingFocus.current = { to: "row", id: selectedId, visible };
    setSelectedId(null);
  };

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={refreshButtonRef}
          variant="ghost"
          size="icon-xs"
          onClick={requestRefresh}
          // Not `disabled`: that would drop keyboard focus to the page the
          // moment the button is pressed. The spin is the busy state.
          aria-disabled={isLoading}
          className={POPOVER_HEADER_ACTION_CLASS}
          aria-label="Refresh subagents"
        >
          <SpinningIcon
            icon={RefreshCw}
            active={isLoading}
            className={cn(isLoading && skipMotion && "text-text-muted")}
            aria-hidden
          />
        </Button>
      </TooltipTrigger>
      {/* How old the list is: a child's "Updated" is its own activity, not
          when Daintree last looked. */}
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Refresh subagents</span>
          {checkedAt !== null && (
            <span>
              Checked <TimeAgo timestamp={checkedAt} />
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
  // At either level: a reader on a child's page pressed the same Refresh, so
  // a failure has to be visible there too, not only behind Back.
  const refreshNotice = refreshErrorMessage && (
    <div className="flex items-baseline gap-3 px-3 py-2 border-b border-divider">
      <p className="flex-1 min-w-0 text-2xs text-text-secondary">
        Couldn't refresh: {refreshErrorMessage}. Showing what was last read.
      </p>
      <Button variant="link" onClick={retryRefresh} className="shrink-0 text-2xs">
        Retry
      </Button>
    </div>
  );

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setRefreshRequested(false);
        // Each opening starts at the list: the popover is a glance first.
        else {
          setSelectedId(null);
          setQuery("");
        }
      }}
    >
      {/* Selecting the pane would close the popover this opens. */}
      <span className="contents" onClick={holdPaneSelection}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  HEADER_CHIP_CLASS,
                  HEADER_CHIP_SURFACE,
                  HEADER_CHIP_TRIGGER_CLASS,
                  // The chip borrows the waiting hue only while a child is
                  // blocked on the user — the one thing worth seeing from the
                  // header without opening anything — and keeps it under the
                  // pointer, where hover lifts the fill instead.
                  // A failure with nothing waiting takes the error hue the same
                  // way; waiting outranks it because it is the one the user can act on.
                  waiting > 0
                    ? "text-state-waiting"
                    : failed > 0
                      ? "text-status-error"
                      : "text-text-secondary hover:text-text-primary",
                  CHIP_FOCUS_CLASS
                )}
                aria-label={attentionNote ? `${summary}, ${attentionNote}` : summary}
              >
                <Network className="w-3 h-3" aria-hidden="true" />
                {count !== null && <span className="tabular-nums">{count}</span>}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{summary}</span>
              <span>
                {attentionNote
                  ? `${capitalize(attentionNote)}. Click to review.`
                  : "Click to review."}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      </span>
      <PopoverContent
        align="end"
        className="w-[min(28rem,var(--radix-popover-content-available-width))] p-0 flex flex-col"
        style={{ maxHeight: FRAME_MAX_HEIGHT }}
        aria-labelledby={selected ? detailHeadingId : headingId}
        onOpenAutoFocus={(event) => {
          // Opening lands on the list, not on Refresh, the first focusable
          // control, whose tooltip would otherwise cover the first child.
          event.preventDefault();
          (
            filterRef.current ??
            listScrollRef.current?.querySelector<HTMLButtonElement>("[data-subagent-row]")
          )?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          // Escape walks back one level before it closes anything, and a
          // query clears before the list it filters goes away.
          if (selected) {
            event.preventDefault();
            closeChild(true);
          } else if (query) {
            event.preventDefault();
            setQuery("");
          }
        }}
      >
        {/* Always mounted, so each outcome is announced when it lands. The
            visible notice sits outside it, with its Retry. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
        {/* The list stays mounted under a child's page, so coming back finds
            it scrolled where it was left. */}
        <div
          hidden={selected !== null}
          className="flex min-h-0 flex-col"
          style={{ maxHeight: FRAME_MAX_HEIGHT }}
        >
          <div className={POPOVER_HEADER_CLASS}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span id={headingId} className={POPOVER_TITLE_CLASS}>
                {label} subagents
              </span>
              <span className={cn(POPOVER_HEADER_META_CLASS, "truncate")}>{headerMeta}</span>
            </span>
            {selected === null && refreshButton}
          </div>
          {selected === null && refreshNotice}
          {filterable && (
            <PopoverSearchField
              ref={filterRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery("")}
              placeholder="Filter subagents"
              aria-label="Filter subagents"
              fieldClassName="border-divider"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                listScrollRef.current
                  ?.querySelector<HTMLButtonElement>("[data-subagent-row]")
                  ?.focus();
              }}
            />
          )}
          <ScrollShadow ref={listScrollRef} compact className="flex-1">
            {shown.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-secondary">
                No subagents match “{query.trim()}”
              </p>
            )}
            <ul onKeyDown={moveRowFocus}>
              {shown.map((subagent) => (
                <SubagentListRow
                  key={`${result.provider}:${subagent.id}`}
                  subagent={subagent}
                  onOpen={(event) => openChild(subagent.id, event)}
                  rowRef={(node) => {
                    if (node) rowRefs.current.set(subagent.id, node);
                    else rowRefs.current.delete(subagent.id);
                  }}
                />
              ))}
            </ul>
          </ScrollShadow>
        </div>
        {selected && (
          <ContentFadeIn
            key={`${result.provider}:${selected.id}`}
            className="flex min-h-0 flex-col"
            // A child's page takes the whole frame from the moment it opens, so
            // a transcript landing, failing or growing never resizes it.
            style={{ height: FRAME_MAX_HEIGHT }}
          >
            <div className={cn(POPOVER_HEADER_CLASS, "justify-start")}>
              <Button
                ref={backButtonRef}
                variant="ghost"
                size="xs"
                onClick={(event) => closeChild(event.detail === 0)}
                className="-my-1 -ml-1.5 gap-1 px-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                aria-label={`Back to ${label} subagents`}
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                {label} subagents
              </Button>
              <span className="ml-auto">{refreshButton}</span>
            </div>
            {refreshNotice}
            <ScrollShadow compact className="flex-1">
              <SubagentDetail
                terminalId={terminalId}
                provider={result.provider}
                subagent={selected}
                cwd={cwd}
                cache={transcriptCache}
                headingId={detailHeadingId}
              />
            </ScrollShadow>
          </ContentFadeIn>
        )}
      </PopoverContent>
    </Popover>
  );
}
