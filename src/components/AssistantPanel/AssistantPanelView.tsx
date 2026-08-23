import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Info, TriangleAlert, ZapOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantToolRow, AssistantToolGroupHeader } from "./AssistantToolRow";
import { AssistantApprovalCard } from "./AssistantApprovalCard";
import type {
  AssistantApproval,
  AssistantToolCall,
  AssistantNotice,
  AssistantSessionState,
  AssistantTurn,
} from "@/store/assistantStore";
import type { AssistantCommandMeta } from "@shared/types/ipc/assistantHost";
import { AssistantBootSplash } from "./AssistantBootSplash";
import { AssistantQuestionCard } from "./AssistantQuestionCard";
import { AssistantOperationsDeck } from "./AssistantOperationsDeck";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { resolveInputBarColors } from "@/utils/terminalTheme";
import "./assistant-panel.css";

/**
 * The native assistant surface.
 *
 * Presentational by construction: it takes a session snapshot and callbacks, and
 * holds no store subscription of its own. That keeps it drivable from fixtures for
 * visual review in every theme — which is the only practical way to check a surface
 * that otherwise only appears when a real engine is mid-turn.
 */

export interface AssistantPanelViewProps {
  /** Shown in the masthead, exactly as the cockpit showed the bound project. */
  projectName?: string | null;
  state: AssistantSessionState;
  /**
   * Returns whether the prompt was ACCEPTED. The composer keeps the draft when it was
   * not — a session that is still starting, or has stopped, would otherwise swallow
   * what someone typed and leave an empty box, which reads as the app losing their
   * words rather than as "not ready yet".
   */
  onSubmit: (text: string) => boolean;
  onInterrupt: () => void;
  onDecideApproval: (approvalId: string, decision: "approved" | "rejected") => void;
  onAnswerQuestion?: (questionId: string, index: number) => void;
  onGrantTool?: (approval: AssistantApproval, uses: number) => void;
  onRequestOperations?: () => void;
  className?: string;
}

/**
 * Phase strings the engine emits, in the cockpit's own words.
 *
 * These are not paraphrases. The terminal UI distinguished "Analyzing request",
 * "Model working", "Writing" and "Integrating results" because they are different
 * things to be waiting on, and it BANNED the word "Thinking" outright — that word had
 * historically meant a phase inferred from silence, and its own test suite asserted it
 * never appeared (`TestRunStageLabel_NeverThinking`). Collapsing three phases into
 * "Thinking" both lost the distinction and reintroduced the forbidden word.
 */
/**
 * The INLINE live-status label, at the tail of the running turn (the cockpit's
 * `liveStatusLabel`, internal/ui/runstatus.go).
 *
 * Only the SILENT phases get one. `tool_running` is deliberately absent: the activity
 * rows below already say what is happening, and a status line repeating it is noise.
 * `received` is stamped on the turn marker instead.
 *
 * The word "Thinking" is banned from this vocabulary. In the cockpit it had meant a
 * phase INFERRED from "the assistant text is still empty"; every phase here is
 * explicit, and reusing the word would resurrect the guess it replaced.
 */
export const LIVE_STATUS_LABEL: Record<string, string> = {
  analyzing: "Analyzing request",
  thinking: "Model working",
  generating: "Writing",
  integrating: "Integrating results",
  awaiting_approval: "Waiting for approval",
  awaiting_question: "Waiting for your answer",
  cancelling: "Cancelling",
};

/**
 * The COMPOSER cue label (the cockpit's `runStageLabel`).
 *
 * Covers every phase, including the ones the inline line omits, because down here the
 * question is only "is it still going" — there are no activity rows beside it to answer
 * that. Same verbs as the inline labels wherever both exist, so the two lines can never
 * disagree about what the turn is doing.
 */
export const STAGE_LABEL: Record<string, string> = {
  received: "Received",
  analyzing: "Analyzing request…",
  thinking: "Model working…",
  generating: "Writing…",
  integrating: "Integrating results…",
  tool_running: "Inspecting project…",
  awaiting_approval: "Waiting for approval…",
  awaiting_question: "Waiting for your answer…",
  cancelling: "Cancelling…",
};

function liveStatusLabel(phase: string | null): string | null {
  if (!phase) return null;
  return LIVE_STATUS_LABEL[phase] ?? null;
}

function stageLabel(phase: string | null): string | null {
  if (!phase) return null;
  // The cockpit's generic fallback, for a phase this build does not know about.
  return STAGE_LABEL[phase] ?? "Processing…";
}

/** Formats a token count for the context meter: 31200 → "31.2k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Formats spend. `complete: false` means the figure is a FLOOR — a call ran whose
 * cost could not be measured — so it is rendered as "≥ $x" rather than as a settled
 * number. Presenting a floor as a receipt would under-report what a session spent.
 */
/** Matches the cockpit's own stall threshold. */
const STALL_THRESHOLD_MS = 5000;

/**
 * How often the live elapsed readout re-renders.
 *
 * Twice a second: fast enough that a tenth-of-a-second figure never looks stuck, slow
 * enough that a running turn is not re-rendering the transcript on every frame.
 */
const ELAPSED_TICK_MS = 500;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatCost(total: number, complete: boolean): string {
  const value = total < 0.01 && total > 0 ? total.toFixed(4) : total.toFixed(2);
  return `${complete ? "" : "≥ "}$${value}`;
}

function NoticeRow({ notice }: { notice: AssistantNotice }) {
  const Icon = notice.level === "info" ? Info : notice.level === "warning" ? TriangleAlert : ZapOff;
  const tone =
    notice.level === "info"
      ? "text-text-secondary"
      : notice.level === "warning"
        ? "text-status-warning"
        : "text-status-danger";
  return (
    <div className="flex items-start gap-2 px-1 py-1 text-xs">
      <Icon aria-hidden="true" className={cn("mt-px size-3.5 shrink-0", tone)} />
      <p className="min-w-0 flex-1 text-text-secondary">{notice.message}</p>
    </div>
  );
}

/**
 * Lines a long paste shows before and after the fold.
 *
 * The tail is the larger share, as the cockpit had it: a pasted log or stack trace
 * usually carries its payoff at the bottom, while the head only has to be enough to
 * recognise what was pasted.
 */
const USER_MSG_HEAD_LINES = 8;
const USER_MSG_TAIL_LINES = 12;

function UserTurn({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Trailing newlines are noise: they inflate the count, so a paste ending in "\n"
  // would fold one line sooner than the same paste without it.
  const lines = text.replace(/\n+$/, "").split("\n");
  // Fold only when it hides at least two lines — replacing one hidden line with a
  // one-row control saves nothing.
  const folded = !expanded && lines.length > USER_MSG_HEAD_LINES + USER_MSG_TAIL_LINES + 1;
  const hidden = lines.length - USER_MSG_HEAD_LINES - USER_MSG_TAIL_LINES;

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[85%] rounded-lg rounded-br-sm px-3 py-2",
          "bg-surface-panel-elevated text-sm text-text-primary",
          "whitespace-pre-wrap break-words"
        )}
      >
        {folded ? (
          <>
            {lines.slice(0, USER_MSG_HEAD_LINES).join("\n")}
            {"\n"}
            {/* Expandable, which the terminal could not be: a long paste must not bury
                the conversation, but nothing is actually lost here. */}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="my-1 w-full rounded-sm border-y border-border-divider py-0.5 text-center text-[10px] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle"
            >
              {hidden} lines hidden — show all
            </button>
            {lines.slice(-USER_MSG_TAIL_LINES).join("\n")}
          </>
        ) : (
          text
        )}
      </div>
    </div>
  );
}

function TurnBlock({ turn, state }: { turn: AssistantTurn; state: AssistantSessionState }) {
  if (turn.role === "user") {
    return <UserTurn text={turn.text} />;
  }

  return (
    <div className="flex gap-2.5">
      <DaintreeIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1 space-y-2">
        {/* Rendered IN ORDER. A turn is a sequence — prose, then the tools it reached
            for, then prose reacting to the results, with steers where the engine folded
            them in. Drawing tools first and prose last regardless made a turn that
            explained itself before acting read as if it had acted in silence. */}
        {turn.segments.map((segment, i) => {
          if (segment.kind === "interjection") {
            return (
              <div
                key={`${turn.turnId}-seg-${i}`}
                className="rounded-md border-l-2 border-border-strong bg-surface-inset/60 px-2 py-1 text-xs text-text-secondary"
              >
                <span className="text-text-muted">You added: </span>
                {segment.text}
              </div>
            );
          }
          if (segment.kind === "answer") {
            return (
              <div
                key={`${turn.turnId}-seg-${i}`}
                className="rounded-md border-l-2 border-border-strong bg-surface-inset/60 px-2 py-1 text-xs text-text-secondary"
              >
                <span className="text-text-muted">
                  {segment.text ? "You chose: " : "You dismissed: "}
                </span>
                {segment.text
                  ? `${segment.label ? `${segment.label} — ` : ""}${segment.text}`
                  : segment.question}
              </div>
            );
          }
          if (segment.kind === "tools") {
            const segCalls = segment.toolCallIds
              .map((id) => state.toolCalls[id])
              .filter((c): c is NonNullable<typeof c> => Boolean(c));
            if (segCalls.length === 0) return null;
            return (
              <ToolSegment
                key={`${turn.turnId}-seg-${i}`}
                calls={segCalls}
                turnComplete={turn.complete}
              />
            );
          }
          return segment.text ? (
            <AssistantMessage
              key={`${turn.turnId}-seg-${i}`}
              content={segment.text}
              // Only the LAST segment can still be streaming.
              streaming={!turn.complete && i === turn.segments.length - 1}
            />
          ) : null;
        })}

        {/* A turn that has produced nothing yet still needs to show it is alive — but
            only when no tool group is already carrying that signal, and never once an
            approval card has taken over saying the turn is blocked on the user. */}
        {turn.segments.length === 0 && !turn.complete && <AssistantMessage content="" streaming />}
      </div>
    </div>
  );
}

/** One announced batch, collapsing on the same rules the whole turn used to. */
function ToolSegment({
  calls,
  turnComplete,
}: {
  calls: AssistantToolCall[];
  turnComplete: boolean;
}) {
  const failed = calls.filter((c) => c.state === "failed").length;
  // Work still LIVE after the turn ends: an accepted async call keeps running in the
  // background, so the turn completing does not mean the work did.
  // Async calls are excluded: they were handed off, and this panel is never told
  // whether they finished, so counting them as "still running" asserts something it
  // cannot know and that goes stale the moment the work completes.
  const unsettled = calls.filter(
    (c) => !c.asyncId && (c.state === "active" || c.state === "queued" || c.state === "waiting")
  ).length;

  /**
   * What the batch did, for the collapsed header.
   *
   * One call reads as the row would ("Read src/main.go"); several list their distinct
   * verbs, because the targets differ and stacking them is longer than the panel is
   * wide. Falls back to nothing — never to the tool ids — when the engine recognised
   * none of the tools: a row of raw identifiers is worse than the plain count.
   */
  const groupWhat = useMemo(() => {
    if (calls.length === 1) {
      const only = calls[0];
      if (!only?.verb) return undefined;
      return only.target ? `${only.verb} ${only.target}` : only.verb;
    }
    const verbs = [...new Set(calls.map((c) => c.verb).filter((v): v is string => !!v))];
    if (verbs.length === 0) return undefined;
    return verbs.slice(0, 3).join(", ") + (verbs.length > 3 ? "…" : "");
  }, [calls]);

  // Open while the turn runs (so progress is visible), collapsing once it settles (so
  // the answer is what remains) — EXCEPT when something failed or is still going.
  // Collapsing either made it indistinguishable from a clean run: the header said
  // "1 action" whatever happened, so the two outcomes most worth noticing were the two
  // that hid.
  const [open, setOpen] = useState(!turnComplete);
  useEffect(() => {
    if (turnComplete && failed === 0 && unsettled === 0) setOpen(false);
  }, [turnComplete, failed, unsettled]);

  return (
    <div>
      <AssistantToolGroupHeader
        count={calls.length}
        what={groupWhat}
        failedCount={failed}
        runningCount={turnComplete ? unsettled : 0}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <ul className="mt-1 space-y-1">
          {calls.map((call) => (
            <AssistantToolRow key={call.toolCallId} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The session masthead, ported from the CLI cockpit's own (internal/ui/render_chrome.go).
 *
 * Same facts in the same order, for the same reasons that file gives: identity and
 * build; the project; the tier and what it permits; a non-default backend, which since
 * sign-in went away is the ONLY readout of which endpoint answers a turn; a non-default
 * routing policy; then the auto-approve warning on its own row — never appended to the
 * tier line, because appending puts the safety text where truncation eats it first.
 * Below the rule sits the debug-log badge.
 *
 * Every value is resolved by the ENGINE and arrives on `host:ready`, so this component
 * decides layout only and cannot disagree with the engine about what is default.
 */
function Masthead({
  state,
  projectName,
  live,
}: {
  state: AssistantSessionState;
  projectName: string | null;
  live: boolean;
}) {
  // An approval is outstanding exactly when a mutating call has been parked for an
  // answer — the engine only raises one for the always-confirm risk classes.
  const destructive = state.approvals.length > 0;
  const hasAny = state.engineVersion || projectName || state.tier || state.backend || state.routing;
  if (!hasAny) return null;

  return (
    <div className="mb-3 select-text text-xs leading-relaxed">
      <div className="truncate">
        <span className="font-semibold">Daintree Assistant</span>
        {state.engineVersion ? (
          // The "v" prefix only when the build string does not already carry its own
          // identity. The engine reports things like "daintree-2eadd58", and "vdaintree-…"
          // reads as a typo rather than a version.
          <span className="opacity-50">
            {" "}
            {/^\d/.test(state.engineVersion) ? `v${state.engineVersion}` : state.engineVersion}
          </span>
        ) : null}
      </div>
      {projectName ? <div className="truncate opacity-50">{projectName}</div> : null}
      {state.tier ? (
        // Quiet at rest for every tier, and DANGEROUS only while a destructive action
        // waits on an answer — the cockpit's own rule (render_chrome.go:66). The tier
        // names what this session is allowed to do; the one moment that matters is when
        // it is about to be exercised. The gloss stays dim throughout: it is a
        // description of the tier, not a live state.
        <div className="truncate">
          <span className={destructive ? "text-status-danger" : "opacity-50"}>
            tier {state.tier}
          </span>
          {state.tierGloss ? <span className="opacity-50"> · {state.tierGloss}</span> : null}
        </div>
      ) : null}
      {state.backend ? <div className="truncate opacity-50">backend {state.backend}</div> : null}
      {state.routing ? <div className="truncate opacity-50">routing {state.routing}</div> : null}
      {state.autoApprove ? (
        <div className="text-status-error">
          {/* Its own row, carrying the full sentence, left-anchored so it is the last
              thing a narrow panel cuts.
              
              Deliberately NOT cleared when the session stops, unlike the footer's live
              indicator. The masthead is the permanent record of how this session ran,
              and a transcript that stops saying it was unattended the moment the
              engine exits is a transcript that hides the fact. */}
          {/* Past tense once the session has stopped: the row is the record of how it
              ran, and "will not ask first" over a dead engine states a capability that
              no longer exists. */}
          {live
            ? "⚠ AUTO-APPROVE — mutating actions will not ask first"
            : "⚠ AUTO-APPROVE — this session ran without confirmations"}
        </div>
      ) : null}
      <div aria-hidden="true" className="my-1.5 border-t border-current opacity-15" />
      {state.logFile ? <LogBadge path={state.logFile} /> : null}
    </div>
  );
}

/**
 * The debug-log badge: a hollow "◌ logging" label then a dim path.
 *
 * The path WRAPS rather than truncating. It used to end in an ellipsis, which hid the
 * useful tail — the session id and `.log` — and the whole point of showing it is that
 * someone can find and open that file. `break-all` is the CSS equivalent of the CLI's
 * hard cell-wrap: paths have no spaces, so a word wrapper would refuse to break at all.
 */
function LogBadge({ path }: { path: string }) {
  // `process.env.HOME` is not available here — the renderer runs sandboxed with node
  // integration off, so reading it silently yielded undefined and every path stayed
  // absolute. The home directory comes over IPC instead.
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    safeFireAndForget(
      window.electron.system.getHomeDir().then((dir) => {
        if (!cancelled && typeof dir === "string") setHome(dir);
      })
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // Collapsed on a PATH-SEGMENT boundary, not a bare prefix: with a home of
  // `/home/bob`, a bare `startsWith` turns `/home/bobby/x` into `~by/x`.
  const shown =
    home && (path === home || path.startsWith(home.endsWith("/") ? home : `${home}/`))
      ? `~${path.slice(home.length)}`
      : path;
  return (
    <div className="break-all">
      <span className="text-status-warning">◌ logging</span>
      <span className="opacity-50"> · {shown}</span>
    </div>
  );
}

/**
 * The slash palette, ported from the cockpit's own (internal/ui/composer/palette.go).
 *
 * Five rows are RENDERED, but the full ranked list stays navigable — the window follows
 * the highlight (`paletteWindow`). Capping the list itself instead, as this panel first
 * did, makes a matched command unreachable by keyboard for no reason a user can see.
 */
const PALETTE_CAP = 5;

/** q's characters appear in s in order, not necessarily adjacent — "tgl" matches "toggle". */
function isSubsequence(s: string, q: string): boolean {
  let si = 0;
  for (const qc of q) {
    while (si < s.length && s[si] !== qc) si++;
    if (si === s.length) return false;
    si++;
  }
  return true;
}

/** exact name (1000) > name prefix (500) > name subsequence (200) > description substring (50). */
function fuzzyScore(name: string, q: string, desc: string): number {
  if (name === q) return 1000;
  if (name.startsWith(q)) return 500;
  if (isSubsequence(name, q)) return 200;
  if (desc.includes(q)) return 50;
  return 0;
}

function bareName(name: string): string {
  return name.replace(/^\//, "").toLowerCase();
}

/**
 * Filter + rank the command list for a draft.
 *
 * The space that ends the command token is a SEMANTIC boundary, not just a split point.
 * While the token is open the draft is a discovery QUERY, so the loose tiers earn their
 * keep — "/back" should surface a command whose description mentions the backend. Once a
 * separator closes an EXACT command name the user has committed, and a command that
 * merely names it in prose becomes noise. A closed token naming nothing is still a
 * search, so Enter can complete "/inb urgent" to "/inbox urgent".
 *
 * Arguments deliberately do NOT close the palette: it stays up, with its usage hint, as
 * you type "/audit 5".
 */
function suggestionsFor(
  commands: readonly AssistantCommandMeta[],
  value: string
): AssistantCommandMeta[] {
  if (!value.startsWith("/")) return [];
  let q = value.slice(1).toLowerCase();
  let closed = false;
  const sep = q.search(/[ \t]/);
  if (sep >= 0) {
    q = q.slice(0, sep);
    closed = true;
  }
  // "/" — and "/ ", which is closed but names nothing — is still "show me everything".
  if (q === "") return [...commands];

  if (closed) {
    // Gated on the separator rather than on exactness alone: "/workflow" can be a live
    // command AND a strict prefix of "/workflows", so collapsing an OPEN token would
    // yank a reachable command away mid-keystroke.
    const exact = commands.find((c) => bareName(c.name) === q);
    if (exact) return [exact];
  }

  return commands
    .map((c, idx) => ({
      c,
      idx,
      score: fuzzyScore(bareName(c.name), q, (c.palette ?? "").toLowerCase()),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((m) => m.c);
}

/** The at-most-five rows to render, plus the selection's index within that slice. */
function paletteWindow(
  suggestions: readonly AssistantCommandMeta[],
  selected: number
): { rows: AssistantCommandMeta[]; local: number } {
  if (suggestions.length === 0) return { rows: [], local: 0 };
  const sel = Math.min(Math.max(selected, 0), suggestions.length - 1);
  if (suggestions.length <= PALETTE_CAP) return { rows: [...suggestions], local: sel };
  const maxStart = suggestions.length - PALETTE_CAP;
  const start = Math.min(Math.max(sel - PALETTE_CAP + 1, 0), maxStart);
  return { rows: suggestions.slice(start, start + PALETTE_CAP), local: sel - start };
}

/** Wrap into [0, n) so navigation never gets stuck at either end. */
function paletteWrap(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((i % n) + n) % n;
}

export function AssistantPanelView({
  state,
  projectName,
  onSubmit,
  onInterrupt,
  onDecideApproval,
  onAnswerQuestion,
  onGrantTool,
  onRequestOperations,
  className,
}: AssistantPanelViewProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);

  const openTurn = state.turns.find((t) => t.role === "assistant" && !t.complete);
  const streaming = openTurn !== undefined;
  // False while a turn the assistant started ITSELF is running — including the window
  // before that turn opens, when only the phase has said so.
  const interruptible = openTurn ? openTurn.wake !== true : !state.phaseIsWake;
  const busy = streaming || state.phase !== null;

  // Stick to the bottom only while the reader is already there. Yanking someone back
  // down while they are reading earlier output is the classic chat-scroll annoyance.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `toolCalls` included: a progress line or a settling row changes the transcript's
    // height without touching turns, so leaving it out lets content grow below a
    // reader who is pinned to the bottom and expects to stay there.
  }, [state.turns, state.approvals, state.notices, state.toolCalls]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (!onSubmit(text)) return; // keep the draft; the session could not take it
    // Recorded only on ACCEPTANCE, so a refused prompt never lands in history — and
    // never as a consecutive duplicate, which is what makes ↑↑ walk distinct prompts
    // rather than the same one twice.
    if (historyRef.current[historyRef.current.length - 1] !== text) {
      historyRef.current.push(text);
    }
    setHistoryIndex(null);
    stashRef.current = "";
    setDraft("");
    // Collapse back to one row; the height was set imperatively as it grew.
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [draft, onSubmit]);

  // The deck replaces the transcript rather than sitting beside it: the panel is a
  // sidebar, and two scrolling regions in that width makes both unreadable. The cockpit
  // did the same — its deck took the screen.
  const [deckOpen, setDeckOpen] = useState(false);

  // A live session is one that can still act. Several readouts describe the session
  // rather than the transcript, and none of them is true once it has stopped.
  const live = state.connection === "ready";

  // Two lines, as the cockpit had: the inline one at the tail of the running turn,
  // and the composer cue under the input. `liveLabel` is null for the phases whose
  // activity rows already explain themselves.
  const liveLabel = liveStatusLabel(state.phase);
  const phase = stageLabel(state.phase);

  // A clock, ticking only while a turn is running.
  //
  // `now` is real state that the rendered output reads, not a bare counter: under the
  // React Compiler a `setTick` whose value nothing consumes is optimised away and the
  // readout silently freezes in production while passing in tests.
  const [now, setNow] = useState(() => Date.now());
  const running = state.turnStartedAt !== null && !state.turns.every((t) => t.complete);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  // Cumulative over the TURN, not the current phase, so it does not reset to zero on
  // every transition. Held back below 300ms to avoid a 0ms flicker.
  const elapsedMs = running && state.turnStartedAt ? now - state.turnStartedAt : 0;
  const elapsed = elapsedMs >= 300 ? formatDuration(elapsedMs) : null;
  // Quiet for a while is normal — a slow model, a long tool — but indistinguishable
  // from a hang unless the panel says which it thinks it is.
  const stalled =
    running && state.lastActivityAt !== null && now - state.lastActivityAt > STALL_THRESHOLD_MS;
  const empty = state.turns.length === 0;

  // The splash belongs to a SESSION, not to this component.
  //
  // The panel stays mounted while it is closed — it slides off-canvas rather than
  // unmounting — so a splash keyed on mount plays to nobody at app start and has long
  // finished by the time the panel is first opened. Keying it on the session id means
  // it plays when an engine actually starts, and replays for a new one ("+ New
  // session"), which is exactly when the CLI played it.
  // Identified by a BOOT GENERATION, not by the session id.
  //
  // The session id does not exist until `start()` resolves, so keying on it means the
  // splash mounts as "pending", then re-keys the moment readiness arrives — restarting
  // the reveal on every cold start, and playing it twice outright when the start is
  // slow. The generation is stamped once, when the connection first enters "starting",
  // and does not move again until another session starts.
  const [bootGen, setBootGen] = useState(0);
  const [splashedGen, setSplashedGen] = useState(-1);
  const prevConnection = useRef(state.connection);
  useEffect(() => {
    if (prevConnection.current !== "starting" && state.connection === "starting") {
      setBootGen((n) => n + 1);
    }
    prevConnection.current = state.connection;
  }, [state.connection]);
  const starting = state.connection === "starting" || state.connection === "ready";
  const booting = empty && starting && splashedGen !== bootGen;

  // Notices the engine attributed to a turn are drawn with that turn; the rest are
  // session-level and sit at the end of the transcript.
  const sessionNotices = useMemo(() => state.notices.filter((n) => !n.turnId), [state.notices]);
  const noticesByTurn = useMemo(() => {
    const byTurn = new Map<string, AssistantNotice[]>();
    for (const n of state.notices) {
      if (!n.turnId) continue;
      const list = byTurn.get(n.turnId);
      if (list) list.push(n);
      else byTurn.set(n.turnId, [n]);
    }
    return byTurn;
  }, [state.notices]);

  // The panel is HTML, not a terminal, but it sits in the same rail as one and reads as
  // the same kind of surface — so it takes its colours from the terminal theme rather
  // than the panel palette. `resolveInputBarColors` is the same function the terminal's
  // own composer uses, so the two agree by construction instead of by two sets of
  // hand-picked tokens drifting apart on the next theme.
  const termTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
  const term = useMemo(() => resolveInputBarColors(termTheme), [termTheme]);

  // Clicking anywhere that is not itself interactive puts the caret in the composer —
  // the same affordance a terminal has, where the whole pane is the typing surface.
  // Guarded so it never steals a click meant for a button, a link, or a text selection.
  const focusComposer = useCallback((e: React.MouseEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el?.closest("button, a, input, textarea, [role='button'], [contenteditable]")) return;
    if ((window.getSelection()?.toString().length ?? 0) > 0) return;
    textareaRef.current?.focus();
  }, []);

  // The slash palette, ranked as the cockpit ranked it. Arguments no longer close it:
  // it stays up with its usage hint while "/audit 5" is typed, which is exactly when
  // the hint is worth reading.
  const paletteMatches = useMemo(
    () => suggestionsFor(state.commands, draft),
    [draft, state.commands]
  );
  const [paletteIndex, setPaletteIndex] = useState(0);
  // Escape dismisses the palette without clearing the draft. Reset on any edit, so the
  // next keystroke brings it back rather than leaving it hidden for the rest of the line.
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  useEffect(() => {
    setPaletteIndex(0);
  }, [draft]);
  // Closed once nothing can be sent. Leaving it live let a click erase the draft and
  // report a command run against an engine that had stopped.
  const paletteOpen = paletteMatches.length > 0 && live && !paletteDismissed;
  const { rows: paletteRows, local: paletteLocal } = paletteWindow(paletteMatches, paletteIndex);
  const paletteOffset = paletteIndex - paletteLocal;

  /**
   * Escape's action, derived rather than fixed, so the hint can never advertise
   * something Escape will not do (hints.go escapeState).
   */
  const escapeHint = useMemo(() => {
    // Both sheets take the keys while they are open, and Escape means something
    // different inside each (decline the tool / dismiss the question). Advertising a
    // composer Escape beside a live approval would be the most expensive wrong label
    // in the panel.
    if (state.pendingQuestion || state.approvals.length > 0) return null;
    if (paletteOpen) return "dismiss";
    if (draft !== "") return "clear draft";
    if (busy && interruptible !== false) return "cancel turn";
    return null;
  }, [busy, draft, interruptible, paletteOpen, state.approvals.length, state.pendingQuestion]);

  /**
   * One pass, in keymap.go hintRow's order: Escape, then the submit pair, then ^O when
   * it leads, then the discovery hints, then ^O when it does not.
   *
   * ^O is emitted EXACTLY ONCE and its position is the only thing that adapts —
   * promotion, not new chrome. Branching out of the function early (as the palette
   * case did) breaks that rule twice over: the control disappears entirely, and when
   * it comes back it can no longer be promoted.
   */
  const composerHints = useMemo(() => {
    const hints: { key: string; action: string }[] = [];
    const ops = { key: "^O", action: "inspect ops" };
    // Cancel takes precedence over attention: if a turn can still be stopped, that is
    // the more urgent thing to know about.
    const leadWithOps = state.operations !== null && !busy;

    if (escapeHint) hints.push({ key: "Esc", action: escapeHint });

    if (paletteOpen) {
      // The palette owns Enter while it is open, so the submit pair would be a lie.
      hints.push({ key: "↑↓", action: "select" }, { key: "Tab", action: "complete" });
    } else if (draft !== "") {
      // "add" mid-turn, because that is what the engine does with it: the prompt is
      // folded into the turn already running rather than starting a new one.
      hints.push({ key: "Enter", action: busy ? "add" : "send" });
      hints.push({ key: "⇧Enter", action: "newline" });
    }

    if (leadWithOps) hints.push(ops);
    // Discovery is suppressed while drafting: a mid-word "/" types a literal slash, and
    // ↑ walks the draft's own rows long before it reaches history.
    if (draft === "" && !paletteOpen) {
      hints.push({ key: "/", action: "commands" }, { key: "↑", action: "history" });
    }
    if (!leadWithOps) hints.push(ops);
    return hints;
  }, [busy, draft, escapeHint, paletteOpen, state.operations]);

  /**
   * Completion writes exactly "<name> " and PRESERVES the arguments already typed, so
   * "/inb urgent" completes to "/inbox urgent" rather than throwing the argument away
   * (internal/ui/composer/palette.go acceptSuggestion).
   */
  const acceptSuggestion = useCallback(
    (cmd: AssistantCommandMeta) => {
      const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
      const rest = draft.replace(/^\/[^\s]*/, "").replace(/^[ \t]+/, "");
      setDraft(rest ? `${name} ${rest}` : `${name} `);
      setPaletteDismissed(true);
      textareaRef.current?.focus();
    },
    [draft]
  );

  /**
   * Composer history, the cockpit's ↑ binding.
   *
   * Entered only when the caret sits at the very start of the draft: inside a multi-line
   * draft ↑ has to walk the draft's own rows first, or a two-line prompt becomes
   * uneditable. `stash` holds what was being typed so ↓ off the end restores it rather
   * than discarding it.
   */
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const stashRef = useRef("");

  const recallHistory = useCallback(
    (direction: -1 | 1) => {
      const items = historyRef.current;
      if (items.length === 0) return false;
      if (historyIndex === null) {
        if (direction === 1) return false; // nothing newer than the live draft
        stashRef.current = draft;
        const idx = items.length - 1;
        setHistoryIndex(idx);
        setDraft(items[idx] ?? "");
        return true;
      }
      const next = historyIndex + direction;
      if (next < 0) return true; // hold at the oldest rather than wrapping
      if (next >= items.length) {
        setHistoryIndex(null);
        setDraft(stashRef.current);
        return true;
      }
      setHistoryIndex(next);
      setDraft(items[next] ?? "");
      return true;
    },
    [draft, historyIndex]
  );

  /**
   * The composer key map, ported from internal/ui/composer/keymap.go + hints.go.
   *
   * Order matters and mirrors the cockpit's own branch order: the palette owns its keys
   * while it is open, then Escape resolves against the draft, then history, then submit.
   */
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ^O inspects operations from the keyboard, not only from the toolbar button.
      if (e.key.toLowerCase() === "o" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setDeckOpen((open) => {
          if (!open) onRequestOperations?.();
          return !open;
        });
        return;
      }

      if (paletteOpen) {
        const n = paletteMatches.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPaletteIndex((i) => paletteWrap(i + 1, n));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPaletteIndex((i) => paletteWrap(i - 1, n));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          // Both COMPLETE rather than send. Enter used to submit the raw draft straight
          // past the highlighted row, which made the selection decorative — the palette
          // looked navigable and answered to nothing.
          const cmd = paletteMatches[paletteIndex];
          if (cmd) {
            e.preventDefault();
            acceptSuggestion(cmd);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setPaletteDismissed(true);
          return;
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        // The cockpit's Escape matrix (hints.go escapeHintMode), in its branch order: a
        // non-empty draft is cleared first, and only an EMPTY draft during a live turn
        // reaches the turn itself.
        //
        // The cockpit had two states between those — Escape retracted a buffered
        // follow-up (LIFO) before it would cancel. They are deliberately absent: it
        // buffered follow-ups client-side, while this panel hands each one to the engine
        // the moment it is typed, so by the time Escape arrives there is nothing local
        // left to take back. Offering a retract that silently failed would be worse than
        // not offering one.
        if (draft !== "") {
          setDraft("");
          setHistoryIndex(null);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
          return;
        }
        if (busy && interruptible !== false) onInterrupt();
        return;
      }

      // History walks the draft's own rows first: only a caret at the very start means
      // "there is nothing above this line", which is when ↑ belongs to history.
      const el = e.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      if (e.key === "ArrowUp" && atStart && !e.shiftKey) {
        if (recallHistory(-1)) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "ArrowDown" && historyIndex !== null && !e.shiftKey) {
        if (recallHistory(1)) {
          e.preventDefault();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [
      acceptSuggestion,
      busy,
      draft,
      historyIndex,
      interruptible,
      onInterrupt,
      onRequestOperations,
      paletteIndex,
      paletteMatches,
      paletteOpen,
      recallHistory,
      submit,
    ]
  );

  const shellVars = {
    "--ib-bg": term.shellBg,
    "--ib-border": term.shellBorder,
    "--ib-border-hover": term.shellBorderHover,
    "--ib-border-focus": term.shellBorderFocus,
    "--ib-shadow": term.shellShadow,
    "--ib-focus-ring": term.shellFocusRing,
    "--ib-hover-bg": term.shellHoverBg,
    "--ib-focus-bg": term.shellFocusBg,
    "--ib-fg": term.foreground,
    // Derived from the terminal foreground rather than a panel token: a fixed
    // placeholder colour that is legible on the panel surface can be invisible on a
    // terminal theme, and the placeholder is the one string that tells a first-time
    // user what this box is for.
    "--ib-placeholder": `color-mix(in oklab, ${term.foreground} 45%, transparent)`,
  } satisfies Record<string, string>;

  return (
    <div
      className={cn("flex h-full min-h-0 cursor-text flex-col", className)}
      // Custom properties are not part of `CSSProperties`, so the cast is at the point
      // of USE and covers only this object rather than widening the declaration above.
      style={
        {
          backgroundColor: term.background,
          color: term.foreground,
          ...shellVars,
        } as React.CSSProperties
      }
      onMouseDown={focusComposer}
    >
      {deckOpen && onRequestOperations ? (
        <AssistantOperationsDeck
          operations={state.operations}
          onRefresh={onRequestOperations}
          onClose={() => setDeckOpen(false)}
        />
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
        >
          <Masthead state={state} projectName={projectName ?? null} live={live} />
          {booting ? (
            // The boot state, matching the cockpit: the mark draws itself while the
            // engine connects. The composer below stays live throughout — the cockpit's
            // was too — so this never gates input, it just fills the space the first
            // answer will occupy.
            <div className="flex h-full flex-col items-center justify-center">
              <AssistantBootSplash
                // Keyed on the boot generation so a NEW session replays the reveal from
                // frame one, while a session id arriving mid-reveal does not.
                key={bootGen}
                onDone={() => setSplashedGen(bootGen)}
                className="w-full px-6"
              />
            </div>
          ) : empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <DaintreeIcon aria-hidden="true" className="size-6 text-text-muted" />
              {/* Names what the assistant DOES. "Ask about this project" framed it as a
                question box, which is the one thing it is not: it plans work, spawns
                visible agents in worktrees and supervises them. It never edits files
                itself, and it can run several at once. Written as plain sentences with
                no dash: the em dash read as an aside, and driving OTHER agents rather
                than editing anything is the whole point, not a footnote. */}
              <p className="text-sm opacity-80">Put agents to work</p>
              <p className="max-w-[26rem] text-xs opacity-60">
                Plan a change and it spawns agents across your worktrees, as many as the job needs,
                then keeps watch on the runs. It doesn&rsquo;t edit files itself. Every agent it
                starts is one you can see and take over.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {state.turns.map((turn) => (
                <div key={turn.turnId} className="space-y-1">
                  <TurnBlock turn={turn} state={state} />
                  {noticesByTurn.get(turn.turnId)?.map((notice) => (
                    <NoticeRow key={notice.id} notice={notice} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* The cockpit's live status line, at the tail of the running turn rather
            than in the footer (internal/ui/render_turn.go renderLiveStatus).

            Placement is the whole point of it. Down in the composer strip it sits
            below the input, outside where anyone is reading, and a long silent
            stretch reads as the panel having died. Here it is the last thing in the
            transcript — exactly where the next output will appear — so "the model is
            working and has not said anything yet" is visible in the place you are
            already looking.

            Shown only for the silent phases: while tools run, the activity rows
            above are a better answer than a label repeating them. */}
          {liveLabel && (
            <div
              // aria-live so a screen reader hears the turn progressing; "polite"
              // because it must never cut across the prose being streamed above it.
              aria-live="polite"
              className={cn(
                "mt-3 flex items-baseline gap-1.5 text-xs tabular-nums",
                // A slow model and a hung one look identical without this.
                stalled ? "text-status-warning" : "text-text-secondary"
              )}
            >
              <span aria-hidden="true" className="assistant-spinner font-mono" />
              <span>
                {liveLabel}
                {stalled && " · still working"}
                {elapsed && ` · ${elapsed}`}
              </span>
            </div>
          )}

          {state.queuedInterjections.map((queued, i) => (
            // The cockpit's queued follow-up. These sit after the running turn because
            // they have not landed anywhere yet — the engine decides whether to fold each
            // into this turn, and only then does it move into the transcript proper.
            <div
              key={`queued-${i}`}
              className="mt-3 rounded-md border border-dashed border-border-strong px-2 py-1.5 text-xs opacity-70"
            >
              <span className="opacity-60">Queued: </span>
              {queued}
            </div>
          ))}

          {/* Approvals sit at the bottom of the scroller, next to the composer, because
            they block the turn: they are the next thing to do, not history. */}
          {state.approvals.length > 0 && (
            <div className="mt-3 space-y-2">
              {state.approvals.map((approval: AssistantApproval) => (
                <AssistantApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  onDecide={onDecideApproval}
                  onGrant={onGrantTool}
                />
              ))}
            </div>
          )}

          {sessionNotices.length > 0 && (
            <div className="mt-3 space-y-0.5">
              {/* NOT truncated, and not a fixed-height strip. The cockpit committed every
                notice to scrollback as its own cell; showing only the last few is how a
                warning that mattered (the engine replaying a turn) disappeared behind
                the notices that followed it. Turn-scoped notices are drawn with their
                turn above; these are the ones the engine did not attribute to one. */}
              {sessionNotices.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 px-3.5 pb-2.5 pt-2.5">
        {paletteOpen && (
          // Above the composer, like the cockpit's. Shows what each command DOES, not
          // just its name: the operations surface — inbox, watchers, timers, workflows,
          // launches, audit — is reachable only through these, so a list of bare words
          // would hide the whole thing behind knowing what to type.
          <div
            role="listbox"
            aria-label="Commands"
            className="mb-1.5 overflow-hidden rounded-md border border-border-default bg-surface-inset"
          >
            {paletteRows.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                aria-selected={i === paletteLocal}
                onMouseEnter={() => setPaletteIndex(paletteOffset + i)}
                // Completes into the composer exactly as Enter and Tab do. Submitting
                // the bare name on click threw away any argument already typed and gave
                // the mouse a different meaning from the keyboard for the same row.
                onClick={() => acceptSuggestion(cmd)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs",
                  "transition-colors duration-150 ease-out",
                  i === paletteLocal ? "bg-overlay-subtle" : "hover:bg-overlay-subtle/60"
                )}
              >
                <span className="shrink-0 font-mono">{cmd.syntax}</span>
                <span className="min-w-0 flex-1 truncate opacity-60">{cmd.palette}</span>
              </button>
            ))}
          </div>
        )}

        {state.pendingQuestion && onAnswerQuestion ? (
          // The sheet REPLACES the composer, as the cockpit's did: the engine has
          // parked the tool dispatch, so there is nothing a typed message could reach.
          // The status line below stays, because it is still true.
          <AssistantQuestionCard question={state.pendingQuestion} onAnswer={onAnswerQuestion} />
        ) : (
          <>
            {/* Same shell as the terminal's HybridInputBar: identical radius, padding,
            border and the `--ib-*` variables resolved from the terminal theme above.
            Copied as STRUCTURE rather than imported because that component carries a
            CodeMirror editor, chips, autocomplete and voice — none of which this
            composer has — but the surface a user looks at must not differ between the
            two panes just because one is HTML. */}
            <div
              className={cn(
                "group/shell relative flex w-full items-baseline gap-1.5 rounded-md border py-2 pr-2",
                "transition-[border-color,background-color,box-shadow] duration-150",
                "bg-[var(--ib-bg)] border-[var(--ib-border)] shadow-[var(--ib-shadow)]",
                "hover:border-[var(--ib-border-hover)] hover:bg-[var(--ib-hover-bg)]",
                "focus-within:border-[var(--ib-border-focus)] focus-within:ring-1",
                "focus-within:ring-[var(--ib-focus-ring)] focus-within:bg-[var(--ib-focus-bg)]"
              )}
            >
              {/* The terminal's own affordance: a muted prompt glyph on the LEFT, no
                  background. It is what makes the box read as a prompt rather than as
                  a chat field. */}
              <span
                aria-hidden="true"
                className="select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-daintree-accent/65"
              >
                ❯
              </span>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Auto-grow to the content, bounded by max-h-40. Without this the field
                  // declared a maximum height it could never reach, so a multi-line prompt
                  // scrolled inside a single line — invisible while composing it.
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onKeyDown={onComposerKeyDown}
                rows={1}
                // The composer stays live during a turn on purpose: a prompt sent mid-turn
                // is folded into the RUNNING turn as an interjection, which is how a user
                // steers work in flight. Disabling it would remove that entirely.
                placeholder={busy ? "Add to this turn…" : "What needs doing?"}
                className={cn(
                  "max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent",
                  // text-placeholder measured ~2.69:1 in the dark theme — the least legible
                  // text in the panel, and it is the one string that tells a first-time
                  // user what to do.
                  "text-sm text-[var(--ib-fg)] placeholder:text-[var(--ib-placeholder)]",
                  // The composer's focus chrome is drawn by its wrapper, so the textarea
                  // suppresses its own — via outline-hidden, which keeps the outline
                  // present for forced-colors mode rather than removing it outright.
                  "outline-hidden"
                )}
              />
              {/* NO send button. The terminal's input bar has none — Enter sends, the
                  way it does at any prompt — so an accent-filled arrow here was a
                  control this surface invented and the pane beside it does not have.
                  Stop is the exception: a turn in flight needs an out, and there is no
                  Ctrl-C to reach for. Worded and weighted like the prompt glyph rather
                  than like a button. */}
              {busy && (
                <button
                  type="button"
                  onClick={onInterrupt}
                  // A wake turn is not interruptible — the engine aborts command turns
                  // only — so an enabled Stop over one is a control that does nothing.
                  disabled={interruptible === false}
                  aria-label="Stop"
                  title={
                    interruptible === false
                      ? "Background work the assistant started on its own — it will finish on its own"
                      : undefined
                  }
                  className={cn(
                    "shrink-0 select-none px-1 font-mono text-[11px] leading-5",
                    "opacity-60 transition-opacity duration-150 ease-out",
                    "hover:opacity-100 disabled:opacity-30"
                  )}
                >
                  stop
                </button>
              )}
            </div>
          </>
        )}

        {/* The adaptive hint row (internal/ui/composer/keymap.go hintRow).

          The SET is stable and the ORDER adapts — promotion, not new chrome — so the
          row never becomes a place where controls appear and disappear. Escape leads
          because its meaning changes with state and is the one binding a user cannot
          guess; discovery hints are suppressed while a draft is in progress, since a
          mid-word "/" types a literal slash and ↑ walks the draft's own rows before it
          ever reaches history. ^O is emitted exactly once, promoted to the front only
          when something is actually waiting. */}
        {composerHints.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-0.5 text-[10px] text-text-secondary">
            {composerHints.map((hint) => (
              <span key={hint.key} className="flex items-baseline gap-1">
                <kbd className="font-mono opacity-80">{hint.key}</kbd>
                <span className="opacity-60">{hint.action}</span>
              </span>
            ))}
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-2 px-0.5 text-[10px] text-text-secondary">
          {phase ? (
            <span
              className={cn(
                "flex items-center gap-1.5",
                stalled ? "text-status-warning" : "text-text-secondary"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "assistant-pulse size-1.5 rounded-full",
                  stalled ? "bg-status-warning" : "bg-text-secondary"
                )}
              />
              {phase}
              {/* The stalled warning and the clock belong to the inline status line,
                  which is showing whenever `liveLabel` is set. They repeat here only
                  for the phases that line omits — chiefly `tool_running` — so the
                  elapsed time never disappears just because the turn moved into
                  tools. */}
              {!liveLabel && stalled && " · still working"}
              {!liveLabel && elapsed && ` · ${elapsed}`}
            </span>
          ) : (
            <span>
              {state.connection === "ready"
                ? state.mcpUnavailable
                  ? // Qualified deliberately. The engine is up, but it cannot reach
                    // Daintree — so it can talk and cannot act, and "Connected" alone
                    // would describe only the half that works.
                    "Connected · no Daintree tools"
                  : "Connected"
                : state.connection}
            </span>
          )}

          <span className="ml-auto flex items-center gap-2 tabular-nums">
            {/* The way into the deck. Placed with the status readouts because that is
                where "what is going on" already lives. */}
            {onRequestOperations && (
              <button
                type="button"
                onClick={() => {
                  setDeckOpen((v) => !v);
                  if (!deckOpen) onRequestOperations();
                }}
                aria-pressed={deckOpen}
                className="rounded-sm px-1 transition-colors duration-150 ease-out hover:bg-overlay-subtle"
              >
                Operations
              </button>
            )}
            {/* Both describe a LIVE session, so neither survives it stopping:
                "Auto-approve on" over a dead engine states a standing permission that
                no longer applies to anything, and "Rate limited" a condition nothing
                is subject to. */}
            {live && state.rateLimited && <span className="text-status-warning">Rate limited</span>}
            {/* Auto-approve is a standing state, not an event — if confirmations are
                off that must stay visible for the whole session. Worded as what is
                switched ON, because "approvals off" reads ambiguously as "approving is
                unavailable" rather than "nothing will ask you". */}
            {live && state.autoApprove && (
              <span className="font-medium text-status-danger">Auto-approve on</span>
            )}
            {state.usage && state.usage.contextWindow > 0 && (
              <span title="Context used">
                {formatTokens(state.usage.contextTokens)}/{formatTokens(state.usage.contextWindow)}
              </span>
            )}
            {/* Nothing is a floor of zero. A backend that reports no cost figures at
                all yields total 0 with complete false, and "≥ $0.00" is clutter that
                says less than saying nothing — the cockpit stayed silent on unknown
                cost for the same reason. */}
            {state.cost && (state.cost.total > 0 || state.cost.complete) && (
              <span>{formatCost(state.cost.total, state.cost.complete)}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
