import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ArrowUp, Info, Square, TriangleAlert, ZapOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantToolRow, AssistantToolGroupHeader } from "./AssistantToolRow";
import { AssistantApprovalCard } from "./AssistantApprovalCard";
import type {
  AssistantApproval,
  AssistantNotice,
  AssistantSessionState,
  AssistantTurn,
} from "@/store/assistantStore";
import { selectTurnToolCalls } from "@/store/assistantStore";
import { AssistantBootSplash } from "./AssistantBootSplash";
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
const PHASE_LABEL: Record<string, string> = {
  analyzing: "Analyzing request",
  thinking: "Model working",
  generating: "Writing",
  integrating: "Integrating results",
  "tool-queued": "Planning actions",
  "tool-running": "Working",
  "awaiting-approval": "Waiting for approval",
  "awaiting-question": "Waiting for your answer",
  cancelling: "Cancelling",
  // `received` carried no separate live line in the cockpit — it is stamped on the
  // turn marker instead — so it deliberately maps to nothing here.
  received: "",
};

function phaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  const label = PHASE_LABEL[phase];
  if (label === "") return null;
  // The cockpit's generic fallback, for a phase this build does not know about.
  return label ?? "Processing";
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

function TurnBlock({ turn, state }: { turn: AssistantTurn; state: AssistantSessionState }) {
  const calls = selectTurnToolCalls(state, turn);
  const failed = calls.filter((c) => c.state === "failed").length;
  // Work that is still LIVE after the turn ends: an accepted async call keeps running
  // in the background, so the turn completing does not mean the work did.
  const unsettled = calls.filter(
    (c) => c.state === "active" || c.state === "queued" || c.state === "waiting"
  ).length;

  // Actions open while the turn runs (so progress is visible) and collapse once it
  // settles (so the answer is what remains on screen) — EXCEPT when something failed
  // or is still going. Collapsing either made it indistinguishable from a clean,
  // finished run: the header said "1 action" whatever happened, so the two outcomes
  // most worth noticing were the two that hid.
  const [open, setOpen] = useState(!turn.complete);
  useEffect(() => {
    if (turn.complete && failed === 0 && unsettled === 0) setOpen(false);
  }, [turn.complete, failed, unsettled]);

  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            "max-w-[85%] rounded-lg rounded-br-sm px-3 py-2",
            "bg-surface-panel-elevated text-sm text-text-primary",
            "whitespace-pre-wrap break-words"
          )}
        >
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <DaintreeIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1 space-y-2">
        {calls.length > 0 && (
          <div>
            <AssistantToolGroupHeader
              count={calls.length}
              failedCount={failed}
              runningCount={turn.complete ? unsettled : 0}
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
        )}

        {/* Interjections render where the engine FOLDED them in, not where they were
            typed — that is the point in the turn the model actually saw them. */}
        {turn.interjections.map((text, i) => (
          <div
            key={`${turn.turnId}-int-${i}`}
            className="rounded-md border-l-2 border-border-strong bg-surface-inset/60 px-2 py-1 text-xs text-text-secondary"
          >
            <span className="text-text-muted">You added: </span>
            {text}
          </div>
        ))}

        {/* Render the message when there is text, or when the turn is still open and
            nothing else is carrying liveness. A bare caret under an active tool group
            read as a stray artifact: the tool rows already say work is happening, and
            the approval card says the turn is blocked on the user. */}
        {(turn.text || (!turn.complete && calls.length === 0)) && (
          <AssistantMessage content={turn.text} streaming={!turn.complete} />
        )}
      </div>
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
}: {
  state: AssistantSessionState;
  projectName: string | null;
}) {
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
        <div className="truncate opacity-50">
          tier <span>{state.tier}</span>
          {state.tierGloss ? <span> · {state.tierGloss}</span> : null}
        </div>
      ) : null}
      {state.backend ? <div className="truncate opacity-50">backend {state.backend}</div> : null}
      {state.routing ? <div className="truncate opacity-50">routing {state.routing}</div> : null}
      {state.autoApprove ? (
        <div className="text-status-error">
          {/* Its own row, carrying the full sentence, left-anchored so it is the last
              thing a narrow panel cuts. */}
          ⚠ AUTO-APPROVE — mutating actions will not ask first
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

export function AssistantPanelView({
  state,
  projectName,
  onSubmit,
  onInterrupt,
  onDecideApproval,
  className,
}: AssistantPanelViewProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);

  const streaming = state.turns.some((t) => t.role === "assistant" && !t.complete);
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
    setDraft("");
    // Collapse back to one row; the height was set imperatively as it grew.
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [draft, onSubmit]);

  const phase = phaseLabel(state.phase);
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
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
      >
        <Masthead state={state} projectName={projectName ?? null} />
        {booting ? (
          // The boot state, matching the cockpit: the mark draws itself while the
          // engine connects. The composer below stays live throughout — the cockpit's
          // was too — so this never gates input, it just fills the space the first
          // answer will occupy.
          <div
            className="flex h-full flex-col items-center justify-center"
            style={{ containerType: "inline-size" }}
          >
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

        {/* Approvals sit at the bottom of the scroller, next to the composer, because
            they block the turn: they are the next thing to do, not history. */}
        {state.approvals.length > 0 && (
          <div className="mt-3 space-y-2">
            {state.approvals.map((approval: AssistantApproval) => (
              <AssistantApprovalCard
                key={approval.approvalId}
                approval={approval}
                onDecide={onDecideApproval}
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

      <div className="shrink-0 px-3.5 pb-2.5 pt-2.5">
        {/* Same shell as the terminal's HybridInputBar: identical radius, padding,
            border and the `--ib-*` variables resolved from the terminal theme above.
            Copied as STRUCTURE rather than imported because that component carries a
            CodeMirror editor, chips, autocomplete and voice — none of which this
            composer has — but the surface a user looks at must not differ between the
            two panes just because one is HTML. */}
        <div
          className={cn(
            "group/shell relative flex w-full items-end gap-1.5 rounded-md border px-2 py-2",
            "transition-[border-color,background-color,box-shadow] duration-150",
            "bg-[var(--ib-bg)] border-[var(--ib-border)] shadow-[var(--ib-shadow)]",
            "hover:border-[var(--ib-border-hover)] hover:bg-[var(--ib-hover-bg)]",
            "focus-within:border-[var(--ib-border-focus)] focus-within:ring-1",
            "focus-within:ring-[var(--ib-focus-ring)] focus-within:bg-[var(--ib-focus-bg)]"
          )}
        >
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
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
          {busy ? (
            <Button size="icon-sm" variant="ghost" onClick={onInterrupt} aria-label="Stop">
              <Square />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              onClick={submit}
              disabled={draft.trim().length === 0 || state.connection !== "ready"}
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-2 px-0.5 text-[10px] text-text-muted">
          {phase ? (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <span
                aria-hidden="true"
                className="assistant-pulse size-1.5 rounded-full bg-text-secondary"
              />
              {phase}
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
            {state.rateLimited && <span className="text-status-warning">Rate limited</span>}
            {/* Auto-approve is a standing state, not an event — if confirmations are
                off that must stay visible for the whole session. Worded as what is
                switched ON, because "approvals off" reads ambiguously as "approving is
                unavailable" rather than "nothing will ask you". */}
            {state.autoApprove && (
              <span className="font-medium text-status-danger">Auto-approve on</span>
            )}
            {state.usage && state.usage.contextWindow > 0 && (
              <span title="Context used">
                {formatTokens(state.usage.contextTokens)}/{formatTokens(state.usage.contextWindow)}
              </span>
            )}
            {state.cost && <span>{formatCost(state.cost.total, state.cost.complete)}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
