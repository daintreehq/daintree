import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronRight, CircleDot, SquareArrowOutUpRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isPtyPanel, type PtyPanelData, type TerminalFirstPrompt } from "@shared/types/panel";
import { HANDBACK_MESSAGE_MAX_CHARS, type TerminalHandback } from "@shared/types/handback";
import { FIRST_PROMPT_MAX_CHARS } from "@shared/utils/firstPrompt";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { ROW_CONTROL_CLASS } from "@/components/ui/RowControl";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { REVIEW_HUB_COUNT_CHIP, REVIEW_HUB_SECTION_BAND } from "./reviewHubUtils";

interface RunEntry {
  panelId: string;
  title: string;
  kind: PtyPanelData["kind"];
  chrome: TerminalChromeDescriptor;
  firstPrompt?: TerminalFirstPrompt;
  handback?: TerminalHandback;
}

const FIRST_PROMPT_LABEL: Record<TerminalFirstPrompt["via"], string> = {
  launch: "Launched with",
  send: "First sent",
};

/**
 * Where a run's body starts: past the row's inset, chevron and agent mark, so
 * the recorded text sits under the title it belongs to.
 */
const RUN_BODY_INSET = "pl-12.5";

/** Enough of a recorded text to describe a closed run; the row shows one line of it. */
const PREVIEW_MAX_CHARS = 160;

// The run list's scroll fade lands on the hub's own surface.
const RUN_LIST_STYLE: CSSProperties & Record<"--scroll-shadow-color", string> = {
  "--scroll-shadow-color": "var(--color-surface-canvas)",
};

/** Focus ring drawn inside the control, so the section's scroller can't clip it. */
const INSET_FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

/**
 * A missing-CLI gate holds its launch's prompt for "Run anyway", but nothing ran
 * there, so it claims nothing. Every other record was written once the run's
 * process started.
 */
function shownFirstPrompt(panel: PtyPanelData): TerminalFirstPrompt | undefined {
  return panel.spawnStatus === "missing-cli" ? undefined : panel.firstPrompt;
}

function latestActivity(entry: RunEntry): number {
  return Math.max(entry.handback?.observedAt ?? 0, entry.firstPrompt?.at ?? 0);
}

interface LinkedIssue {
  worktreeId: string;
  label: string;
  title?: string;
}

interface ReviewHubContextProps {
  worktreePath: string;
  worktreeId: string | undefined;
  /** The dialog sizes to its content, so a share of its height can't resolve there. */
  isDialog?: boolean;
}

/**
 * What the work was for and what the agent said it did, both read straight off
 * recorded state: the linked issue, and for each terminal the first prompt
 * Daintree delivered to it and its last handback. Nothing here is inferred from
 * agent state, terminal output or the launch command, and a worktree with none
 * of them shows nothing.
 *
 * Bounded so it never takes the diff's place: one run open (the newest when the
 * hub opened), the rest one line each, and the whole section capped with its
 * own scroller.
 */
export function ReviewHubContext({ worktreePath, worktreeId, isDialog }: ReviewHubContextProps) {
  const headingId = useId();
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  const issue = useWorktreeStore(
    useShallow((state): LinkedIssue | null => {
      for (const wt of state.worktrees.values()) {
        if (wt.path !== worktreePath) continue;
        if (!wt.issueNumber) return null;
        return {
          worktreeId: wt.id,
          label: wt.issueKey ?? `#${wt.issueNumber}`,
          title: wt.issueTitle ?? wt.branchDerivedTitle,
        };
      }
      return null;
    })
  );

  // Panel references are stable between store updates, so the shallow compare
  // holds; building entries inside the selector would mint new objects per call.
  const panels = usePanelStore(
    useShallow((state) => {
      if (!worktreeId) return [];
      return Object.values(state.panelsById).filter(
        (panel) =>
          isPtyPanel(panel) &&
          panel.location !== "trash" &&
          panel.worktreeId === worktreeId &&
          (panel.lastHandback || shownFirstPrompt(panel))
      );
    })
  );
  const byActivity: RunEntry[] = panels
    .flatMap((panel) =>
      isPtyPanel(panel)
        ? [
            {
              panelId: panel.id,
              title: getTerminalDisplayTitle(panel, "full", { showTask: showAgentTaskTitles }),
              kind: panel.kind,
              chrome: deriveTerminalChrome(panel),
              firstPrompt: shownFirstPrompt(panel),
              handback: panel.lastHandback,
            },
          ]
        : []
    )
    .sort((a, b) => latestActivity(b) - latestActivity(a));

  // Order and the open run are both fixed for the visit: a handback landing on
  // another run while the reviewer reads must not move rows or swap which one
  // is open under them. The hub opens newest first; a run that appears later
  // takes the next place once and keeps it, and the next visit sorts afresh.
  // Adjusted during render rather than in an effect, so an arrival never paints
  // in one place and then jumps to another.
  const [visitOrder, setVisitOrder] = useState<readonly string[]>(() =>
    byActivity.map((run) => run.panelId)
  );
  const arrivals = byActivity.filter((run) => !visitOrder.includes(run.panelId));
  if (arrivals.length > 0) {
    setVisitOrder([...visitOrder, ...arrivals.map((run) => run.panelId)]);
  }
  const runs = visitOrder.flatMap((id) => byActivity.filter((run) => run.panelId === id));
  const openedWith = visitOrder[0] ?? null;
  const defaultOpenId = runs.some((run) => run.panelId === openedWith)
    ? openedWith
    : (runs[0]?.panelId ?? null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  if (!issue && runs.length === 0) return null;

  return (
    <section
      aria-labelledby={headingId}
      style={RUN_LIST_STYLE}
      className={cn(
        "@container flex shrink-0 flex-col min-h-0 border-b border-divider",
        isDialog ? "max-h-[min(20rem,30vh)]" : "max-h-[min(20rem,35%)]"
      )}
      data-testid="review-hub-context"
    >
      <div className={cn(REVIEW_HUB_SECTION_BAND, "shrink-0 border-b border-divider")}>
        <h3 id={headingId} className={cn(SECTION_LABEL_CLASS, "flex shrink-0 items-center")}>
          Context
          {runs.length > 0 && (
            <span className={REVIEW_HUB_COUNT_CHIP}>{pluralize(runs.length, "run")}</span>
          )}
        </h3>
        {issue && (
          <button
            type="button"
            className={cn(
              "flex h-6 min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1 -mr-1 text-xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary",
              INSET_FOCUS_RING
            )}
            aria-label={`Open issue ${issue.label}${issue.title ? ` ${issue.title}` : ""}`}
            data-testid="review-hub-linked-issue"
            onClick={() =>
              void actionService.dispatch(
                "worktree.openIssue",
                { worktreeId: issue.worktreeId },
                { source: "user" }
              )
            }
          >
            <CircleDot className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="shrink-0 font-mono">{issue.label}</span>
            {issue.title && <span className="truncate">{issue.title}</span>}
          </button>
        )}
      </div>
      {runs.length > 0 && (
        <ScrollShadow compact scrollClassName="overscroll-contain">
          <ul className="py-1">
            {runs.map((run) => (
              <RunRow
                key={run.panelId}
                run={run}
                open={toggled[run.panelId] ?? run.panelId === defaultOpenId}
                onToggle={(open) => setToggled((prev) => ({ ...prev, [run.panelId]: open }))}
              />
            ))}
          </ul>
        </ScrollShadow>
      )}
    </section>
  );
}

function RunRow({
  run,
  open,
  onToggle,
}: {
  run: RunEntry;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const bodyId = useId();
  const titleId = useId();
  const previewId = useId();
  const ageId = useId();
  const { ref: titleRef, isTruncated: titleCut } = useTruncationDetection();
  const { panelId, title, kind, chrome, firstPrompt, handback } = run;
  const at = handback?.observedAt ?? firstPrompt?.at ?? 0;
  const ageLabel = handback
    ? "Last handback"
    : firstPrompt
      ? FIRST_PROMPT_LABEL[firstPrompt.via]
      : "";
  return (
    <li className="flex flex-col min-w-0" data-testid="review-hub-run">
      <div className="flex min-w-0 items-center gap-1 px-2">
        {/* The toggle and "Go to terminal" are siblings, never nested: the
            row is a disclosure with a trailing action beside it. */}
        <h4 className="flex min-w-0 flex-1">
          {/* Named by the title alone, so the name stays the same open or
              closed and never carries a whole recorded prompt; a cut title
              shows in full on hover or focus. */}
          <TruncatedTooltip content={title} isTruncated={titleCut}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-labelledby={titleId}
              aria-describedby={
                [open ? null : previewId, at > 0 ? ageId : null].filter(Boolean).join(" ") ||
                undefined
              }
              onClick={() => onToggle(!open)}
              data-testid="review-hub-run-toggle"
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] pl-1 pr-2 text-left text-xs transition-colors duration-150 ease-out hover:bg-overlay-hover",
                INSET_FOCUS_RING
              )}
            >
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "size-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
                  open && "rotate-90"
                )}
                aria-hidden="true"
              />
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <TerminalIcon kind={kind} chrome={chrome} className="size-3.5" />
              </span>
              <span
                ref={titleRef}
                id={titleId}
                className="min-w-0 truncate font-medium text-text-primary"
              >
                {title}
              </span>
              {/* Identity first: below a width where the preview would be a few
                letters, the title gets the whole row. */}
              {!open && (
                <span
                  id={previewId}
                  className="hidden min-w-0 flex-1 truncate text-text-secondary @md:block"
                >
                  <RunPreview firstPrompt={firstPrompt} handback={handback} />
                </span>
              )}
              {at > 0 && (
                <span id={ageId} className="ml-auto shrink-0 pl-2 text-2xs text-text-secondary">
                  <span className="sr-only">{ageLabel} </span>
                  <TimeAgo timestamp={at} />
                </span>
              )}
            </button>
          </TruncatedTooltip>
        </h4>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(ROW_CONTROL_CLASS, INSET_FOCUS_RING, "[&_svg]:size-3.5")}
              aria-label={`Go to terminal: ${title}`}
              onClick={() =>
                void actionService.dispatch("panel.focus", { panelId }, { source: "user" })
              }
            >
              <SquareArrowOutUpRight aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go to terminal</TooltipContent>
        </Tooltip>
      </div>
      <div
        id={bodyId}
        hidden={!open}
        className={cn("flex flex-col gap-2 pr-3 pt-0.5 pb-2", RUN_BODY_INSET)}
      >
        {open && handback && <HandbackField handback={handback} title={title} />}
        {open && firstPrompt && <FirstPromptField firstPrompt={firstPrompt} title={title} />}
      </div>
    </li>
  );
}

/**
 * The one line a closed run shows: the agent's own words when it handed back
 * with a summary, otherwise what it was asked, each with its provenance.
 */
function RunPreview({
  firstPrompt,
  handback,
}: {
  firstPrompt?: TerminalFirstPrompt;
  handback?: TerminalHandback;
}) {
  if (handback?.message) {
    return (
      <>
        <span className="sr-only">The agent said: </span>“{excerpt(handback.message)}”
      </>
    );
  }
  if (handback) return <>Handback, no summary</>;
  if (firstPrompt) {
    return <>{`${FIRST_PROMPT_LABEL[firstPrompt.via]}: ${excerpt(firstPrompt.text)}`}</>;
  }
  return null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat;
}

function HandbackField({ handback, title }: { handback: TerminalHandback; title: string }) {
  return (
    <RecordField
      testId="review-hub-handback"
      facts={
        <>
          <span>Last handback</span>
          <FactSeparator />
          <TimeAgo timestamp={handback.observedAt} verbose />
          {!handback.message && (
            <>
              <FactSeparator />
              <span>no summary</span>
            </>
          )}
          {handback.truncated && (
            <>
              <FactSeparator />
              <span>first {HANDBACK_MESSAGE_MAX_CHARS.toLocaleString()} characters kept</span>
            </>
          )}
        </>
      }
      expandLabel="Full handback"
      expandAriaLabel={`Full handback from ${title}`}
      text={handback.message}
      render={(message) => (
        <>
          <span className="text-text-secondary">The agent said: </span>“{message}”
        </>
      )}
    />
  );
}

/**
 * The prompt exactly as recorded, as text: never rendered as Markdown or HTML,
 * since it is whatever the caller wrote.
 */
function FirstPromptField({
  firstPrompt,
  title,
}: {
  firstPrompt: TerminalFirstPrompt;
  title: string;
}) {
  return (
    <RecordField
      testId="review-hub-first-prompt"
      facts={
        <>
          <span>{FIRST_PROMPT_LABEL[firstPrompt.via]}</span>
          <FactSeparator />
          <TimeAgo timestamp={firstPrompt.at} verbose />
          {firstPrompt.truncated && (
            <>
              <FactSeparator />
              <span>first {FIRST_PROMPT_MAX_CHARS.toLocaleString()} characters kept</span>
            </>
          )}
        </>
      }
      expandLabel="Full prompt"
      expandAriaLabel={`Full prompt for ${title}`}
      text={firstPrompt.text}
      render={(text) => text}
    />
  );
}

/**
 * One recorded field of a run: its facts line, then its text clamped to three
 * lines. The expand control appears only when the clamp actually cuts the text
 * at this width, and its label never changes; the chevron and `aria-expanded`
 * carry open versus closed. Its 24px target overhangs the facts line, so a
 * field with the control sits at the same rhythm as one without.
 */
function RecordField({
  testId,
  facts,
  expandLabel,
  expandAriaLabel,
  text,
  render,
}: {
  testId: string;
  facts: ReactNode;
  expandLabel: string;
  expandAriaLabel: string;
  text: string | null;
  render: (text: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const textId = useId();

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="flex flex-col gap-0.5 min-w-0" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-text-secondary">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">{facts}</span>
        {text && (clamped || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={textId}
            aria-label={expandAriaLabel}
            onClick={() => setExpanded((value) => !value)}
            className={cn(
              "ml-auto -my-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 -mr-1 font-medium text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary",
              INSET_FOCUS_RING
            )}
          >
            <ChevronRight
              data-animated-chevron
              className={cn(
                "size-3 transition-transform duration-150 ease-out",
                expanded && "rotate-90"
              )}
              aria-hidden="true"
            />
            {expandLabel}
          </button>
        )}
      </div>
      {text && (
        <p
          ref={textRef}
          id={textId}
          className={cn(
            "text-xs text-text-primary whitespace-pre-wrap wrap-break-word text-pretty",
            !expanded && "line-clamp-3"
          )}
        >
          {render(text)}
        </p>
      )}
    </div>
  );
}
