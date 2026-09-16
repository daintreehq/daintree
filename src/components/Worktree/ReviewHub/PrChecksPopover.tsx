import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Send } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDohertyGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { forgeClient } from "@/clients/forgeClient";
import { cn } from "@/lib/utils";
import { composePrChecksAgentText, preparePrChecks, type PrCheckRow } from "./prChecks";

/**
 * Set on the trigger — which is always in the hub's own DOM — while the
 * disclosure is open, so `ReviewHubContent`'s document-capture Escape handler
 * can stand aside. It cannot key off the content instead: that is portalled,
 * and before the lazy Radix bundle lands there is no content at all.
 */
export const PR_CHECKS_OPEN_ATTR = "data-pr-checks-open";

const FOCUS_RING =
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary";

const ROW_ACTION_CLASS = cn(
  "inline-flex items-center justify-center shrink-0 p-1 rounded-sm",
  "text-text-secondary hover:bg-tint/5 hover:text-text-primary transition-colors cursor-pointer",
  FOCUS_RING
);

const FOOTER_BUTTON_CLASS = cn(
  "inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-sm text-2xs font-medium transition-colors",
  "bg-filter-selected-bg-soft hover:bg-tint/[0.14] text-text-primary cursor-pointer",
  FOCUS_RING
);

const LINK_BUTTON_CLASS = cn(
  "inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-sm text-2xs transition-colors",
  "text-text-secondary hover:text-text-primary hover:bg-tint/[0.06] cursor-pointer",
  FOCUS_RING
);

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
  const reloadLabel = state.kind === "error" || state.kind === "no-pr" ? "Retry" : "Refresh";

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
          className={cn("inline-flex items-center rounded-sm cursor-pointer", FOCUS_RING)}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          align="start"
          sideOffset={8}
          aria-label={`CI checks for pull request #${prNumber}`}
          data-testid="pr-checks-popover"
          className="p-1 min-w-72 max-w-md text-xs"
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
              className="flex flex-col gap-1.5 px-2 py-1.5"
            >
              {/* `immediate`: the Doherty gate already absorbed the anti-flicker delay. */}
              <SkeletonBone immediate className="h-3 w-40 rounded-sm" />
              <SkeletonBone immediate className="h-3 w-32 rounded-sm" />
              <SkeletonBone immediate className="h-3 w-36 rounded-sm" />
            </Skeleton>
          ) : (
            <>
              {state.kind === "error" && (
                <ChecksNotice testId="pr-checks-error" message="Couldn't load checks." />
              )}
              {state.kind === "no-pr" && (
                <ChecksNotice
                  testId="pr-checks-missing"
                  message={`Pull request #${prNumber} wasn't found.`}
                />
              )}
              {state.kind === "empty" && (
                <ChecksNotice
                  testId="pr-checks-empty"
                  message={`No CI checks reported on pull request #${prNumber}.`}
                />
              )}
              {state.kind === "loaded" && (
                <ul
                  data-testid="pr-checks-list"
                  className="flex flex-col gap-0.5 max-h-64 overflow-y-auto"
                >
                  {state.rows.map((row) => {
                    const { Icon, toneClass } = row.outcome;
                    const detailsUrl = row.detailsUrl;
                    const outcomeText = describeOutcome(row);
                    return (
                      <li key={row.key} className="flex items-start gap-2 px-2 py-1.5 rounded-sm">
                        <Icon
                          className={cn("w-3.5 h-3.5 shrink-0 mt-px", toneClass)}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-text-primary break-words">
                            {row.name}
                          </span>
                          <span className="block text-text-secondary">{outcomeText}</span>
                        </span>
                        {detailsUrl && (
                          <button
                            type="button"
                            onClick={() => onOpenExternal(detailsUrl)}
                            // Matrix jobs repeat names, so the name alone leaves two
                            // buttons identically labelled when a reader tabs the list
                            // without hearing the rows between them.
                            aria-label={`Open details for ${row.name} (${outcomeText})`}
                            className={ROW_ACTION_CLASS}
                          >
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {sendHint && (
            <p
              data-testid="pr-checks-send-hint"
              className="px-2 pt-1.5 text-2xs text-text-secondary"
            >
              {sendHint}
            </p>
          )}

          {/* Mounted in every state on purpose. Re-reading used to unmount the
            control that triggered it, which for a keyboard user dropped focus
            onto `document.body` inside an open popover. */}
          <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5 mt-1 border-t border-divider">
            <button
              type="button"
              data-testid="pr-checks-reload"
              onClick={runFetch}
              className={LINK_BUTTON_CLASS}
            >
              {reloadLabel}
            </button>
            {failingCount > 0 && (
              <button
                type="button"
                data-testid="pr-checks-send"
                onClick={handleSend}
                className={FOOTER_BUTTON_CLASS}
              >
                <Send className="w-3 h-3" aria-hidden="true" />
                Send to agent
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
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
      return `No CI checks reported on pull request #${prNumber}.`;
    case "loaded": {
      const failing = state.rows.filter((row) => row.isFailure).length;
      return `${state.rows.length} CI checks, ${failing} failing`;
    }
    default:
      return "";
  }
}

function ChecksNotice({ testId, message }: { testId: string; message: string }) {
  // Inline and quiet, never a toast: this is a drill-down the user opened, and
  // its failure is only meaningful inside the surface they opened. The live
  // region above does the announcing; the footer below carries the recovery.
  return (
    <div data-testid={testId} className="px-2 py-1.5 text-text-secondary">
      {message}
    </div>
  );
}
