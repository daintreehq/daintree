import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Send } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { forgeClient } from "@/clients/forgeClient";
import { cn } from "@/lib/utils";
import { composePrChecksAgentText, preparePrChecks, type PrCheckRow } from "./prChecks";

/**
 * Marks the open content for `ReviewHubContent`'s document-capture Escape
 * handler, which would otherwise close the whole hub out from under this
 * popover. Radix's own Escape listener is on the same target and phase but
 * registers later, so the hub's wins unless it stands aside.
 */
export const PR_CHECKS_POPOVER_ATTR = "data-pr-checks-popover";

const FOCUS_RING =
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary";

const ROW_ACTION_CLASS = cn(
  "inline-flex items-center justify-center shrink-0 p-1 rounded",
  "text-daintree-text/60 hover:bg-tint/5 hover:text-text-primary transition-colors cursor-pointer",
  FOCUS_RING
);

const FOOTER_BUTTON_CLASS = cn(
  "inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded text-2xs font-medium transition-colors",
  "bg-filter-selected-bg-soft hover:bg-tint/[0.14] text-text-primary cursor-pointer",
  FOCUS_RING
);

const LINK_BUTTON_CLASS = cn(
  "inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded text-2xs transition-colors",
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
  // Refresh re-fired, while an earlier read is still in flight. Only the newest
  // request may paint — or open the palette.
  const requestIdRef = useRef(0);
  // One deliberate hand-off of focus to the palette. See `.claude/rules/overlay-focus.md`:
  // a consumer that preventDefaults close-autofocus owns the outcome, which is what
  // stops Radix's deferred restoration yanking focus back off the palette.
  const suppressCloseFocusRef = useRef(false);

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

  const showSkeleton = useDohertyGate(state.kind === "loading");
  const failingCount = state.kind === "loaded" ? state.rows.filter((r) => r.isFailure).length : 0;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        type="button"
        data-testid="pr-checks-trigger"
        aria-label={triggerLabel}
        className={cn("inline-flex items-center rounded-sm cursor-pointer", FOCUS_RING)}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        aria-label={`CI checks for pull request #${prNumber}`}
        data-testid="pr-checks-popover"
        {...{ [PR_CHECKS_POPOVER_ATTR]: "" }}
        className="p-1 min-w-72 max-w-md text-xs"
        onCloseAutoFocus={(event) => {
          if (!suppressCloseFocusRef.current) return;
          suppressCloseFocusRef.current = false;
          event.preventDefault();
        }}
      >
        {state.kind === "loading" && showSkeleton && (
          <Skeleton label="Loading CI checks" className="flex flex-col gap-1.5 px-2 py-1.5">
            {/* `immediate`: the Doherty gate above already absorbed the anti-flicker delay. */}
            <SkeletonBone immediate className="h-3 w-40 rounded" />
            <SkeletonBone immediate className="h-3 w-32 rounded" />
            <SkeletonBone immediate className="h-3 w-36 rounded" />
          </Skeleton>
        )}

        {state.kind === "error" && (
          <ChecksNotice
            testId="pr-checks-error"
            message="Couldn't load checks."
            actionLabel="Retry"
            onAction={runFetch}
          />
        )}

        {state.kind === "no-pr" && (
          <ChecksNotice
            testId="pr-checks-missing"
            message={`Pull request #${prNumber} wasn't found.`}
            actionLabel="Retry"
            onAction={runFetch}
          />
        )}

        {state.kind === "empty" && (
          <ChecksNotice
            testId="pr-checks-empty"
            message={`No CI checks reported on pull request #${prNumber}.`}
            actionLabel="Refresh"
            onAction={runFetch}
          />
        )}

        {state.kind === "loaded" && (
          <>
            <ul
              data-testid="pr-checks-list"
              className="flex flex-col gap-0.5 max-h-64 overflow-y-auto"
            >
              {state.rows.map((row) => {
                const { Icon, toneClass, label } = row.outcome;
                const detailsUrl = row.detailsUrl;
                return (
                  <li key={row.key} className="flex items-start gap-2 px-2 py-1.5 rounded">
                    <Icon
                      className={cn("w-3.5 h-3.5 shrink-0 mt-px", toneClass)}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-text-primary break-words">{row.name}</span>
                      <span className="block text-text-secondary">
                        {/* Requiredness is only stated when the provider reported it —
                            an omitted `required` is unknown, not optional. */}
                        {row.required === true ? `${label} · Required` : label}
                      </span>
                    </span>
                    {detailsUrl && (
                      <button
                        type="button"
                        onClick={() => onOpenExternal(detailsUrl)}
                        aria-label={`Open details for ${row.name}`}
                        className={ROW_ACTION_CLASS}
                      >
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            {sendHint && (
              <p
                role="status"
                data-testid="pr-checks-send-hint"
                className="px-2 pt-1.5 text-2xs text-text-secondary"
              >
                {sendHint}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5 mt-1 border-t border-divider">
              <button type="button" onClick={runFetch} className={LINK_BUTTON_CLASS}>
                Refresh
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
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ChecksNotice({
  testId,
  message,
  actionLabel,
  onAction,
}: {
  testId: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    // Inline and polite, never a toast: this is a drill-down the user opened,
    // and its failure is only meaningful inside the surface they opened.
    <div
      role="status"
      data-testid={testId}
      className="flex items-center justify-between gap-3 px-2 py-1.5"
    >
      <span className="text-text-secondary">{message}</span>
      <button type="button" onClick={onAction} className={LINK_BUTTON_CLASS}>
        {actionLabel}
      </button>
    </div>
  );
}
