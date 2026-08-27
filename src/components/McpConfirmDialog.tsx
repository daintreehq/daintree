import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Plug, ShieldAlert, Sparkles } from "lucide-react";
import type { McpConfirmationDecision } from "@shared/types/ipc/mcpServer";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { isCautionPreviewLine, stripCautionPrefix } from "@/lib/mcpPreviewLines";
import { useMcpConfirmStore, type PendingMcpConfirm } from "@/store/mcpConfirmStore";

/**
 * Renderer-side timer that beats main's 30s `pendingDispatches` deadline by
 * a couple seconds, so the user-facing modal closes with a clean
 * `CONFIRMATION_TIMEOUT` outcome before main rejects with a generic
 * "Action dispatch timed out" error. The modal disappears automatically
 * either way; the earlier window just produces nicer audit semantics.
 */
const CONFIRMATION_TIMEOUT_MS = 28_000;

/**
 * Main's own hard deadline, mirrored from `MCP_DISPATCH_TIMEOUT_MS` in
 * `electron/services/mcp-server/shared.ts` (main-process only, so it cannot be
 * imported here). Nothing this modal does may outlive it: past this point main
 * has already failed the dispatch and told the agent it timed out, so an
 * approval landing afterwards would run the action anyway — the destructive
 * write happens while the caller was told it did not.
 */
const MAIN_DISPATCH_DEADLINE_MS = 30_000;

/**
 * Lower-bound read-time gate for destructive dispatches. `resolveOnce` guards
 * the second click; this disables the primary button briefly after each item
 * is promoted so a click meant for the previous modal can't silently approve a
 * freshly-promoted destructive write before the user has read it.
 *
 * This is a click-carry-over guard, not an attention device — passive delays
 * are known not to make anyone read. Chromium applies 500-1000ms to its own
 * security prompts for the same hazard; 1200ms sits just above that floor.
 */
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Upper bound for the user-agent shown in the "Requested by" row. An external
 * client controls its own `User-Agent` header (capped at Node's ~8 KB header
 * limit, not at a sane length), so clamp the display value here so an oversized
 * string can't push the rest of the request out of view. The row is also
 * clamped to a single line in CSS — 120 characters is still three wrapped lines
 * in a `max-w-md` dialog, which is three lines of incidental client text
 * sitting above the evidence that actually decides the approval.
 */
const MAX_USER_AGENT_DISPLAY = 120;

/**
 * Height reserved for the preview body before its content lands. Sized to the
 * common case (a heading plus ~3 rows) so the card does not grow when the fetch
 * resolves: the dialog is centre-anchored, so a body that grows moves the
 * confirm button — and it moves at the exact moment the button also stops being
 * disabled. A relocating, newly-live destructive target is a misclick hazard,
 * so the loading state reserves the space the content will occupy.
 */
const PREVIEW_MIN_BODY_HEIGHT = "min-h-[5.5rem]";

/**
 * Ceiling for the same body. A worktree with forty changed files is exactly the
 * case the preview exists for, but an unbounded listing pushes the argument
 * summary and the rest of the card back below the fold — the containment
 * problem the framed card was meant to solve. Bound it and scroll in place, as
 * every sibling preview does; the content is all still there.
 */
const PREVIEW_MAX_BODY_HEIGHT = "max-h-[13rem]";

function truncateUserAgent(userAgent: string): string {
  return userAgent.length > MAX_USER_AGENT_DISPLAY
    ? `${userAgent.slice(0, MAX_USER_AGENT_DISPLAY - 1)}…`
    : userAgent;
}

/**
 * What the fresh-preview fetch has to say, derived from the payload rather than
 * stored as a separate field — `preview` and `previewPending` already encode
 * all four cases and the store contract does not need to widen:
 *
 *   none        no preview target for this action; nothing was ever attempted.
 *   pending     a target exists and the fetch is in flight.
 *   ready       lines came back.
 *   unavailable a target existed and produced nothing — the monitor was gone,
 *               or a rejection escaped the builder and the bridge cleared the
 *               pending flag with an empty array. Distinct from `none`, and the
 *               distinction matters: it is the difference between "this action
 *               has no content to show" and "we could not find out what this
 *               affects", and a D2 approval must never read the second as the
 *               first.
 */
type PreviewState = "none" | "pending" | "ready" | "unavailable";

export function derivePreviewState(current: PendingMcpConfirm): PreviewState {
  if (current.previewPending === true) return "pending";
  if (current.preview === undefined) return "none";
  return current.preview.length > 0 ? "ready" : "unavailable";
}

/**
 * Singleton dialog driven by the MCP confirmation queue. Mounted once near
 * the top of `App.tsx`. Reads `current` from `useMcpConfirmStore` and
 * surfaces one `ConfirmDialog` at a time — concurrent agent calls queue
 * FIFO behind the visible modal rather than stacking overlapping dialogs.
 *
 * Body order follows the ordering every permission surface converges on —
 * identity, then consequence, then evidence, then technical detail. People
 * anchor their trust judgement on who is asking before they weigh what is
 * being asked, so provenance leads; but it leads as one compact line, because
 * its cost in vertical space is what pushed the evidence down before.
 */
export function McpConfirmDialog() {
  const current = useMcpConfirmStore((state) => state.current);
  const queueDepth = useMcpConfirmStore((state) => state.queue.length);
  const resolveCurrent = useMcpConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  // `resolveCurrent` is synchronous: it resolves the promise and advances the
  // queue so `current` becomes the next item before React re-renders. A rapid
  // double-click would otherwise fire a second `resolveCurrent("approved")`
  // that lands on the freshly-promoted queued item — silently approving a
  // destructive action the user never saw. Gate every resolution on the
  // requestId we've already handled so a given dialog can resolve exactly once.
  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: McpConfirmationDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  useEffect(() => {
    if (current === null) return;
    const { requestId, enqueuedAt } = current;
    // Subtract time the request already spent queued behind a prior modal so
    // every dispatch races against the same wall-clock budget; otherwise a
    // queued item could outlive main's 30s deadline and degrade to a generic
    // timeout error instead of `CONFIRMATION_TIMEOUT`.
    const elapsed = Date.now() - enqueuedAt;
    // Destructive dispatches disable the confirm button for CONFIRM_COOLDOWN_MS
    // after promotion. A deeply-queued item could otherwise have less budget
    // left than the cooldown and auto-time-out before the user can ever click —
    // so floor the window above the cooldown for those. The floor still lands
    // under main's 30s deadline (28s budget + ~1.5s), preserving the clean
    // CONFIRMATION_TIMEOUT outcome.
    const floor = current.danger === "confirm" ? CONFIRM_COOLDOWN_MS + 300 : 500;
    // The floor keeps a deeply-queued destructive item approvable for at least
    // as long as its own cooldown. But the floor must never push the modal past
    // main's deadline: an item promoted at ~29s would otherwise sit open until
    // 30.5s and re-enable its confirm button at 30.2s — after main had already
    // failed the dispatch — so a click would run the destructive action while
    // the agent had been told it timed out. Clamp to whatever budget is
    // genuinely left; a non-positive clamp fires the timeout immediately, which
    // is the honest outcome for a request that can no longer be approved.
    const remaining = Math.min(
      Math.max(floor, CONFIRMATION_TIMEOUT_MS - elapsed),
      MAIN_DISPATCH_DEADLINE_MS - elapsed
    );
    const timer = setTimeout(() => {
      resolveOnce(requestId, "timeout");
    }, remaining);
    return () => clearTimeout(timer);
  }, [current, resolveOnce]);

  if (current === null) {
    return (
      <ErrorBoundary variant="component" componentName="McpConfirmDialog" resetKeys={[resetKey]}>
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Run"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  // Severity follows the action's registry classification, not the fact that
  // an MCP client dispatched it; only genuinely destructive dispatches earn
  // red. Daintree classifies its own actions, so unlike a remote server's
  // self-reported tool annotations this value is trusted.
  const isDestructive = current.danger === "confirm";
  const variant = isDestructive ? "destructive" : "default";
  const previewState = derivePreviewState(current);
  const hasArgs = current.argsSummary.trim().length > 0;

  // `alertdialog` is for a brief, important message; APG reserves it for text
  // the screen reader should read out whole on open. This body carries a
  // scrollable file list and a redacted payload, so it is a `dialog` whenever
  // either is present — matching every sibling confirm that shows a preview.
  const hasScrollableContent = previewState !== "none" || hasArgs;

  return (
    <ErrorBoundary variant="component" componentName="McpConfirmDialog" resetKeys={[resetKey]}>
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={confirmTitle(current)}
        description={current.actionDescription}
        confirmLabel={current.actionTitle}
        cancelLabel="Cancel"
        onConfirm={() => resolveOnce(current.requestId, "approved")}
        variant={variant}
        hasPreview={hasScrollableContent}
        confirmDisabled={previewState === "pending"}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
        hint={<GateHint previewState={previewState} queueDepth={queueDepth} />}
      >
        <div className="space-y-3">
          <RequesterRow current={current} />

          {current.dangerRationale && (
            <ConsequenceNote isDestructive={isDestructive}>
              {current.dangerRationale}
            </ConsequenceNote>
          )}

          {previewState !== "none" && (
            <PreviewCard
              title={current.previewTitle ?? "Working tree changes"}
              state={previewState}
              lines={current.preview ?? []}
            />
          )}

          {hasArgs && <ArgumentsDisclosure argsSummary={current.argsSummary} />}
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}

/**
 * The dialog title, naming the affected entity when one is known.
 *
 * `Run 'Delete worktree'?` says which registry action will execute but not
 * which worktree — and under multi-agent interruption the target is the thing
 * the approver most needs and can least infer. Where a subject resolved, the
 * title names it; where none did, it stays the stable generic form rather than
 * changing after open.
 */
export function confirmTitle(current: PendingMcpConfirm): string {
  return current.subject
    ? `${current.actionTitle} '${current.subject}'?`
    : `Run '${current.actionTitle}'?`;
}

/** Shared micro-label, matching the section-heading grammar used app-wide. */
const MICRO_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60";

/**
 * Who is asking, in one line.
 *
 * Provenance differs by dispatch origin, and an absent `callerInfo` has two
 * causes, not one: the pinned help-session route never carries an identity
 * (the assistant's own panel is its own context), and `getBearerInfoForSession`
 * also returns null for a session whose token hash was never registered. So the
 * row reads `sessionOrigin` — the field that actually records which class of
 * surface dispatched — and names an unidentified caller as unidentified rather
 * than letting it inherit the assistant's standing.
 *
 * The row is always present. It was previously dropped entirely for
 * assistant-owned requests, which moved everything below it by ~52px whenever a
 * queued item promoted across origins, and left the most trusted case looking
 * like a missing section.
 */
function RequesterRow({ current }: { current: PendingMcpConfirm }) {
  const { callerInfo, sessionOrigin } = current;
  const isAssistant = sessionOrigin === "help" || sessionOrigin === "assistant-pane";

  let Icon = ShieldAlert;
  let name = "Unidentified client";
  let detail: string | null = null;

  if (callerInfo) {
    Icon = Plug;
    name = truncateUserAgent(callerInfo.userAgent);
    detail = `…${callerInfo.token4LastChars}`;
  } else if (isAssistant) {
    Icon = Sparkles;
    name = "Daintree Assistant";
  }

  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className={cn(MICRO_LABEL, "shrink-0")}>Requested by</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <Icon
          aria-hidden="true"
          className="w-3 h-3 shrink-0 translate-y-0.5 text-daintree-text/45"
        />
        <span className="truncate text-daintree-text/80" title={callerInfo?.userAgent}>
          {name}
        </span>
        {detail && (
          <span className="shrink-0 font-mono text-[11px] text-daintree-text/45">{detail}</span>
        )}
      </span>
    </div>
  );
}

/**
 * Why the action is gated.
 *
 * For a destructive dispatch this is the consequence statement, so it gets a
 * toned callout with a real icon rather than another paragraph at body weight:
 * an icon keeps its shape under `forced-colors: active`, where the destructive
 * button's fill is replaced by a system colour and stops distinguishing itself
 * from Cancel. One toned block also keeps the severity signal singular — the
 * point is a consequence hierarchy, not red spread across every section.
 */
function ConsequenceNote({
  isDestructive,
  children,
}: {
  isDestructive: boolean;
  children: React.ReactNode;
}) {
  if (!isDestructive) {
    return (
      <div className="space-y-1">
        <div className={MICRO_LABEL}>Why this is gated</div>
        <div className="text-xs text-daintree-text/70 break-words">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-status-danger/20 bg-status-danger/10 p-3">
      <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0 mt-px text-status-danger" />
      <div className="min-w-0 space-y-1">
        <div className={cn(MICRO_LABEL, "text-status-danger/80")}>What this does</div>
        <div className="text-xs text-daintree-text/80 break-words">{children}</div>
      </div>
    </div>
  );
}

/**
 * The actual content the dispatch would affect — the decisive evidence for a
 * D2 approval, so it gets the framed, headed, bounded card every sibling
 * destructive confirm already uses, rather than the same bare `<pre>` well the
 * redacted arguments sit in.
 *
 * The card carries no row-count badge: these lines are freeform, and the first
 * one is usually the formatter's own summary ("3 files with uncommitted
 * changes:"), so a count of rendered rows sits next to a sentence stating a
 * different number.
 *
 * Rows are rendered individually rather than joined into one wrapped block:
 * soft-wrapping a monospace listing with no hanging indent puts continuation
 * text at the same left edge as a new entry, so a two-commit list reads as
 * however many visual rows it happens to wrap to.
 */
function PreviewCard({
  title,
  state,
  lines,
}: {
  title: string;
  state: Exclude<PreviewState, "none">;
  lines: string[];
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-tint/[0.08] bg-tint/[0.04]">
      <div className="border-b border-tint/[0.08] px-3 py-2">
        <span className={MICRO_LABEL}>{title}</span>
      </div>

      <div
        className={cn(
          "overflow-y-auto px-3 py-2",
          PREVIEW_MIN_BODY_HEIGHT,
          PREVIEW_MAX_BODY_HEIGHT
        )}
      >
        {state === "pending" ? (
          <div
            className="flex h-full items-center justify-center py-4"
            role="status"
            aria-label="Checking what this affects"
          >
            <Spinner size="sm" className="text-daintree-text/40" />
          </div>
        ) : state === "unavailable" ? (
          <CautionRow>
            Couldn't check what this affects. Approve only if you already know what it will change.
          </CautionRow>
        ) : (
          <div className="space-y-1">
            {lines.map((line, index) =>
              isCautionPreviewLine(line) ? (
                <CautionRow key={index}>{stripCautionPrefix(line)}</CautionRow>
              ) : (
                <div
                  key={index}
                  className="pl-4 -indent-4 font-mono text-xs break-words whitespace-pre-wrap text-daintree-text/80"
                >
                  {line}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A preview line the formatters marked as a caution — "could not verify",
 * "this operation will be refused". It is the most safety-relevant thing the
 * preview can say and previously rendered as an inline "⚠" character at the
 * same weight as a filename.
 */
function CautionRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-status-warning">
      <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * The redacted argument summary, behind a disclosure.
 *
 * Raw payloads shown inline are the classic driver of consent-dialog
 * click-through: they read as noise, and the noise trains people to skip the
 * whole surface. Collapsed, they stay one keystroke away for anyone who wants
 * them without competing with the evidence for attention. The preview above is
 * never collapsed — a D2 approval has to show actual content, not offer it.
 */
function ArgumentsDisclosure({ argsSummary }: { argsSummary: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 text-left",
          "transition-colors duration-150 ease-out hover:bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <span className={MICRO_LABEL}>Arguments</span>
      </button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-y-auto rounded-[var(--radius-md)] bg-overlay-subtle px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap text-daintree-text/80">
          {argsSummary}
        </pre>
      )}
    </div>
  );
}

/**
 * The subdued line beside the action row, answering "can I act right now, and
 * what happens when I do".
 *
 * Deliberately not a countdown. The request does expire, but a ticking clock on
 * a security decision pushes the reader toward impulsive rather than
 * deliberative processing, so the expiry stays silent and only the conditions
 * the user can act on are named. Nothing here is colour-coded either — it has
 * to survive forced-colors, where a tone would be flattened away.
 */
function GateHint({
  previewState,
  queueDepth,
}: {
  previewState: PreviewState;
  queueDepth: number;
}) {
  const parts: string[] = [];
  if (previewState === "pending") parts.push("Checking what this affects…");
  if (queueDepth > 0) {
    parts.push(`${queueDepth} more request${queueDepth === 1 ? "" : "s"} waiting`);
  }
  if (parts.length === 0) return null;

  return (
    <span aria-live="polite" className="min-w-0 truncate">
      {parts.join(" · ")}
    </span>
  );
}
