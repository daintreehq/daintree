import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleDashed, ExternalLink, Info, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDohertyGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { forgeClient } from "@/clients/forgeClient";
import { cn } from "@/lib/utils";
import {
  composePrChecksAgentText,
  preparePrChecks,
  summarizePrChecks,
  type PrCheckRow,
} from "./prChecks";
import { pluralize } from "@/lib/pluralize";

/**
 * Set on the trigger — which is always in the hub's own DOM — while the
 * disclosure is open, so `ReviewHubContent`'s document-capture Escape handler
 * can stand aside. It cannot key off the content instead: that is portalled,
 * and before the lazy Radix bundle lands there is no content at all.
 */
export const PR_CHECKS_OPEN_ATTR = "data-pr-checks-open";

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

// The primitive transitions every property; these only ever change colour.
const FOOTER_BUTTON_MOTION = "transition-colors";

/**
 * The three outcomes `ChecksCapability.getChecks` distinguishes lead a reader to
 * opposite conclusions, so none of them may present as another: `null` is "no
 * such pull request", `[]` is "this PR has no checks", and a rejection (which
 * includes a provider with no checks capability at all) is "we could not find
 * out". `empty` in particular must never read as green.
 */
type ChecksState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: PrCheckRow[] }
  | { kind: "empty" }
  | { kind: "no-pr" }
  | { kind: "error" };

interface PrChecksPopoverProps {
  worktreePath: string;
  prNumber: number;
  prUrl: string;
  /** Accessible name for the trigger; the badge inside it carries none of its own. */
  triggerLabel: string;
  onOpenExternal: (url: string) => void;
  /** The PR badge, rendered inside the trigger button. */
  children: ReactNode;
}

/**
 * Turns the PR badge into a disclosure over the pull request's individual CI
 * checks, and offers the failing ones to an agent through the existing
 * send-to-agent palette.
 *
 * Checks are read once per opening and never polled. `ForgeCheckRun` carries no
 * commit, attempt or run id, so there is nothing to dedupe a background refresh
 * against — fetching on the click bounds staleness to the click, which is the
 * only bound the contract can honestly offer.
 *
 * Callers must key this component by worktree and PR number: a snapshot read
 * for one pull request must never be repainted, or handed to an agent, under
 * another's identity.
 */
export function PrChecksPopover({
  worktreePath,
  prNumber,
  prUrl,
  triggerLabel,
  onOpenExternal,
  children,
}: PrChecksPopoverProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ChecksState>({ kind: "idle" });
  const [sendHint, setSendHint] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  // Monotonic, not a cancelled flag: the popover can be closed and reopened, and
  // the reload re-fired, while an earlier read is still in flight. Only the
  // newest request may paint — or open the palette.
  const requestIdRef = useRef(0);
  // One deliberate hand-off of focus to the palette. See `.claude/rules/overlay-focus.md`:
  // a consumer that preventDefaults close-autofocus owns the outcome, which is what
  // stops Radix's deferred restoration yanking focus back off the palette.
  const suppressCloseFocusRef = useRef(false);
  // Null until the lazily-loaded Radix layer actually mounts its content.
  const contentRef = useRef<HTMLDivElement | null>(null);

  // A read outliving the component must not resolve into a dead setState.
  useEffect(() => () => void (requestIdRef.current += 1), []);

  const runFetch = useCallback(() => {
    const requestId = (requestIdRef.current += 1);
    setSendHint(null);
    setState({ kind: "loading" });
    forgeClient.getChecks(worktreePath, prNumber).then(
      (result) => {
        if (requestIdRef.current !== requestId) return;
        if (result === null) {
          setState({ kind: "no-pr" });
          return;
        }
        if (result.checks.length === 0) {
          setState({ kind: "empty" });
          return;
        }
        setState({ kind: "loaded", rows: preparePrChecks(result.checks) });
      },
      () => {
        if (requestIdRef.current !== requestId) return;
        setState({ kind: "error" });
      }
    );
  }, [worktreePath, prNumber]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        suppressCloseFocusRef.current = false;
        runFetch();
        return;
      }
      // Abandon whatever is in flight and drop the snapshot: the next opening is
      // a fresh question, and showing the previous answer first would be a lie
      // about when it was read.
      requestIdRef.current += 1;
      setSendHint(null);
      setShowSettled(false);
      setState({ kind: "idle" });
    },
    [runFetch]
  );

  // Escape has to reach the disclosure, and between the hub and Radix there is a
  // window where it would not. The hub's own handler is a document-capture
  // listener that closes the whole hub; Radix's is registered only once its lazy
  // bundle has landed and the layer is mounted. Window capture runs ahead of
  // both, so this closes the gap — and only the gap.
  //
  // Once the content is mounted this stands down rather than claiming the key.
  // Radix owns Escape properly: stopping propagation here would skip
  // `PopoverContent`'s `onKeyDown`, which is what clears the pointer-selection
  // flags in `overlay-focus-restore.ts`. A pointer click on Refresh followed by
  // Escape would then be restored as a pointer close and lose the focus ring a
  // keyboard user is owed. The hub's `PR_CHECKS_OPEN_ATTR` backstop is what
  // keeps the hub out of the way for that path.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || contentRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      handleOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, handleOpenChange]);

  const handleSend = useCallback(() => {
    if (state.kind !== "loaded") return;
    const text = composePrChecksAgentText({ prNumber, prUrl, worktreePath, rows: state.rows });
    if (!text) return;
    if (openSendToAgentPaletteWithText(text)) {
      suppressCloseFocusRef.current = true;
      setOpen(false);
      return;
    }
    setSendHint("Open an agent terminal, then try sending again.");
  }, [state, prNumber, prUrl, worktreePath]);

  // The floor is the half that stops a glitch: the Doherty gate only suppresses
  // an early skeleton, and without a minimum dwell a read landing at 410ms puts
  // one on screen for a single frame.
  const showSkeleton = useSkeletonFloor(useDohertyGate(state.kind === "loading"));
  const failingCount = state.kind === "loaded" ? state.rows.filter((r) => r.isFailure).length : 0;
  const cannotRead = state.kind === "error" || state.kind === "no-pr";
  const reloadLabel = cannotRead ? "Retry" : "Refresh";

  return (
    <>
      {/* Outside `PopoverContent` on purpose: that subtree is lazily mounted, so
          a region living inside it would first appear already carrying its
          message — which is the announcement that does not land. Here it is
          mounted empty for the whole life of the chip. */}
      <p role="status" aria-live="polite" className="sr-only">
        {open ? describeState(state, prNumber, showSkeleton, sendHint) : ""}
      </p>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          type="button"
          data-testid="pr-checks-trigger"
          aria-label={triggerLabel}
          {...{ [PR_CHECKS_OPEN_ATTR]: open ? "true" : undefined }}
          className={cn(
            "group/pr-checks inline-flex items-center rounded-sm cursor-pointer",
            FOCUS_RING
          )}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          align="start"
          aria-label={`CI checks for pull request #${prNumber}`}
          data-testid="pr-checks-popover"
          // A fixed width, not a content-sized one: the footer actions must not
          // move between a refresh that fails and one that lists a long matrix.
          className="flex flex-col w-96 max-w-[calc(100vw-16px)] text-xs"
          onCloseAutoFocus={(event) => {
            if (!suppressCloseFocusRef.current) return;
            suppressCloseFocusRef.current = false;
            event.preventDefault();
          }}
        >
          {showSkeleton ? (
            // `inert`: the single region above owns announcements, so the
            // skeleton must not add an `aria-busy` region of its own.
            <Skeleton
              inert
              data-testid="pr-checks-skeleton"
              label="Loading CI checks"
              className="flex flex-col"
            >
              {/* `immediate`: the Doherty gate already absorbed the anti-flicker delay. */}
              <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-divider">
                <SkeletonBone immediate className="h-3.5 w-24 rounded-sm" />
                <SkeletonBone immediate className="h-3 w-48 rounded-sm" />
              </div>
              <div className="flex flex-col gap-3 px-3 py-3">
                {SKELETON_ROWS.map((width) => (
                  <div key={width} className="flex items-center gap-2.5">
                    <SkeletonBone immediate className="h-3.5 w-3.5 rounded-full" />
                    <SkeletonBone immediate className={cn("h-3 rounded-sm", width)} />
                  </div>
                ))}
              </div>
            </Skeleton>
          ) : (
            <>
              {state.kind === "error" && (
                <ChecksBanner testId="pr-checks-error">
                  <InlineStatusBanner
                    severity="error"
                    title="Couldn't load checks"
                    description="The check results couldn't be read. Retry, or open the pull request to see them there."
                    {...QUIET_BANNER}
                  />
                </ChecksBanner>
              )}
              {state.kind === "no-pr" && (
                <ChecksBanner testId="pr-checks-missing">
                  <InlineStatusBanner
                    severity="warning"
                    title={`Pull request #${prNumber} wasn't found`}
                    description="It may have been deleted, or moved to another repository. Retry, or open it to check."
                    {...QUIET_BANNER}
                  />
                </ChecksBanner>
              )}
              {state.kind === "empty" && (
                <div data-testid="pr-checks-empty" className="px-3 py-4">
                  <EmptyState
                    variant="zero-data"
                    scale="popover"
                    icon={<CircleDashed />}
                    title="Refresh once CI starts"
                    instant
                  />
                </div>
              )}
              {state.kind === "loaded" && (
                <ChecksList
                  rows={state.rows}
                  showSettled={showSettled}
                  onToggleSettled={() => setShowSettled((value) => !value)}
                  onOpenExternal={onOpenExternal}
                />
              )}
            </>
          )}

          {sendHint && (
            <p
              data-testid="pr-checks-send-hint"
              className="flex items-start gap-2 px-3 py-2 border-t border-divider text-text-secondary"
            >
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              {sendHint}
            </p>
          )}

          {/* Mounted in every state on purpose. Re-reading used to unmount the
            control that triggered it, which for a keyboard user dropped focus
            onto `document.body` inside an open popover. */}
          <div className="flex items-center justify-between gap-2 px-2 py-2 border-t border-divider">
            <Button
              type="button"
              variant="subtle"
              size="sm"
              data-testid="pr-checks-reload"
              onClick={runFetch}
              className={FOOTER_BUTTON_MOTION}
            >
              <RefreshCw aria-hidden="true" />
              {reloadLabel}
            </Button>
            {failingCount > 0 && (
              <Button
                type="button"
                variant="contrast"
                size="sm"
                data-testid="pr-checks-send"
                onClick={handleSend}
                className={FOOTER_BUTTON_MOTION}
              >
                <Send aria-hidden="true" />
                Send {pluralize(failingCount, "check")} to agent
              </Button>
            )}
            {cannotRead && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="pr-checks-open-pr"
                onClick={() => onOpenExternal(prUrl)}
                className={FOOTER_BUTTON_MOTION}
              >
                <ExternalLink aria-hidden="true" />
                Open pull request
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

const SKELETON_ROWS = ["w-44", "w-56", "w-36"];

/**
 * The status region outside the popover owns every announcement; a banner that
 * mounted as its own alert would say the same thing twice.
 */
const QUIET_BANNER = { role: "status", ariaLive: "off" } as const;

function ChecksList({
  rows,
  showSettled,
  onToggleSettled,
  onOpenExternal,
}: {
  rows: PrCheckRow[];
  showSettled: boolean;
  onToggleSettled: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const settledId = useId();
  const summary = summarizePrChecks(rows);
  const leading = rows.filter((row) => row.group !== "settled");
  const settled = rows.filter((row) => row.group === "settled");
  // Folding the clean results away only pays when something else is left to
  // read; an all-green run is exactly the list the reader opened.
  const collapsible = leading.length > 0 && settled.length > 0;
  const settledVisible = !collapsible || showSettled;
  const detailsLabels = labelDetailsButtons(rows);

  return (
    <>
      <div data-testid="pr-checks-summary" className="px-3 py-2 border-b border-divider">
        <p className="font-medium text-text-primary">{summary.headline}</p>
        {summary.detail && <p className="mt-0.5 text-2xs text-text-secondary">{summary.detail}</p>}
      </div>
      <ScrollShadow compact className="max-h-80" scrollClassName="p-1 scroll-py-4">
        {/* One stable child: the shadow hook observes the scroller's first element. */}
        <div data-testid="pr-checks-list">
          {leading.length > 0 && (
            <CheckRows rows={leading} labels={detailsLabels} onOpenExternal={onOpenExternal} />
          )}
          {collapsible && (
            <button
              type="button"
              data-testid="pr-checks-settled-toggle"
              aria-expanded={showSettled}
              aria-controls={settledId}
              onClick={onToggleSettled}
              className={cn(
                "flex w-full items-center gap-2.5 mt-0.5 px-2 py-1.5 rounded-md text-left",
                "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary transition-colors cursor-pointer",
                FOCUS_RING,
                "focus-visible:-outline-offset-2"
              )}
            >
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "w-3.5 h-3.5 shrink-0 transition-transform duration-150 ease-out",
                  showSettled && "rotate-90"
                )}
                aria-hidden="true"
              />
              {showSettled ? "Hide" : "Show"} {summary.settledLabel}
            </button>
          )}
          {settledVisible && settled.length > 0 && (
            <CheckRows
              id={settledId}
              rows={settled}
              labels={detailsLabels}
              onOpenExternal={onOpenExternal}
            />
          )}
        </div>
      </ScrollShadow>
    </>
  );
}

/**
 * Matrix jobs repeat names, so the name alone leaves two buttons identically
 * labelled when a reader tabs the list without hearing the rows between them.
 * The outcome separates most of them; an ordinal separates whatever is left.
 */
function labelDetailsButtons(rows: readonly PrCheckRow[]): Map<string, string> {
  const base = new Map(rows.map((row) => [row.key, `${row.name} (${describeOutcome(row)})`]));
  const totals = new Map<string, number>();
  for (const text of base.values()) totals.set(text, (totals.get(text) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const row of rows) {
    const text = base.get(row.key)!;
    const total = totals.get(text)!;
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    labels.set(row.key, `Open details for ${text}${total > 1 ? `, ${nth} of ${total}` : ""}`);
  }
  return labels;
}

function CheckRows({
  id,
  rows,
  labels,
  onOpenExternal,
}: {
  id?: string;
  rows: PrCheckRow[];
  labels: ReadonlyMap<string, string>;
  onOpenExternal: (url: string) => void;
}) {
  return (
    <ul id={id} className="flex flex-col">
      {rows.map((row) => {
        const { Icon, toneClass } = row.outcome;
        const detailsUrl = row.detailsUrl;
        const outcomeText = describeOutcome(row);
        return (
          <li
            key={row.key}
            // Pointer tracking only — the row is not itself a control, so the
            // details button inside it never nests in another interactive.
            className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-overlay-subtle focus-within:bg-overlay-subtle transition-colors"
          >
            <Icon className={cn("w-3.5 h-3.5 shrink-0 mt-px", toneClass)} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-text-primary break-words">{row.name}</span>
              <span className="block text-text-secondary">{outcomeText}</span>
            </span>
            {detailsUrl && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onOpenExternal(detailsUrl)}
                aria-label={labels.get(row.key)}
                className="-my-1 [&_svg]:size-3.5"
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Requiredness is only stated where the provider reported it — omitted is unknown, not optional. */
function describeOutcome(row: PrCheckRow): string {
  if (row.required === true) return `${row.outcome.label} · Required`;
  if (row.required === false) return `${row.outcome.label} · Not required`;
  return row.outcome.label;
}

function describeState(
  state: ChecksState,
  prNumber: number,
  showSkeleton: boolean,
  sendHint: string | null
): string {
  if (sendHint) return sendHint;
  if (showSkeleton) return "Loading CI checks";
  switch (state.kind) {
    case "error":
      return "Couldn't load checks.";
    case "no-pr":
      return `Pull request #${prNumber} wasn't found.`;
    case "empty":
      return `No CI checks have reported on pull request #${prNumber} yet.`;
    case "loaded": {
      const failing = state.rows.filter((row) => row.isFailure).length;
      const total = state.rows.length;
      return `${pluralize(total, "CI check")}, ${failing} failing`;
    }
    default:
      return "";
  }
}

/**
 * Inline and quiet, never a toast: this is a drill-down the user opened, and
 * its failure is only meaningful inside the surface they opened. The recovery
 * lives in the footer rather than on the banner, so a retry never unmounts the
 * control that started it.
 */
function ChecksBanner({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="p-2">
      {children}
    </div>
  );
}
