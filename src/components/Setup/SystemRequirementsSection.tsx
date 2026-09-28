import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { Callout } from "@/components/ui/Callout";
import { AlertTriangle, ChevronDown, CircleCheck, RotateCw, CircleX } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { UI_ENTER_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import { useSystemHealthCheck } from "./useSystemHealthCheck";
import { PrerequisiteCard } from "./SystemToolsStep";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Button } from "@/components/ui/button";

interface SystemRequirementsSectionProps {
  onFatalFailureChange: (hasFatal: boolean) => void;
  onCheckingChange: (checking: boolean) => void;
}

export function SystemRequirementsSection({
  onFatalFailureChange,
  onCheckingChange,
}: SystemRequirementsSectionProps) {
  const { visibleSpecs, checkStates, isChecking, error, allDone, hasFatalFailure, runCheck } =
    useSystemHealthCheck();

  const [userExpanded, setUserExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // The last settled answer, held while a re-check runs. `hasFatalFailure`
  // reads false mid-check, and following it would unmount the failure panel —
  // and the "Check again" button that has focus — until the result is back.
  const [shownFatal, setShownFatal] = useState(hasFatalFailure);
  if (allDone && shownFatal !== hasFatalFailure) setShownFatal(hasFatalFailure);

  const isExpanded = userExpanded || shownFatal;

  // A re-check that clears the failure folds the panel and removes "Check
  // again" with focus still on it. Hand focus to the disclosure that replaces
  // it. Removal fires no blur, so the flag is still set when the swap lands.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const checkAgainFocusedRef = useRef(false);
  useEffect(() => {
    if (shownFatal || !checkAgainFocusedRef.current) return;
    checkAgainFocusedRef.current = false;
    toggleRef.current?.focus();
  }, [shownFatal]);

  useEffect(() => {
    onFatalFailureChange(hasFatalFailure);
  }, [hasFatalFailure, onFatalFailureChange]);

  useEffect(() => {
    onCheckingChange(isChecking);
  }, [isChecking, onCheckingChange]);

  // Derived collections for UI
  const readyTools = visibleSpecs.filter((s) => {
    const state = checkStates[s.tool];
    return state !== "loading" && state?.available && state.meetsMinVersion;
  });

  const warningTools = visibleSpecs.filter((s) => {
    const state = checkStates[s.tool];
    return (
      state !== "loading" && s.severity === "warn" && (!state?.available || !state.meetsMinVersion)
    );
  });

  const fatalTools = visibleSpecs.filter((s) => {
    const state = checkStates[s.tool];
    return (
      state !== "loading" && (!state?.available || !state.meetsMinVersion) && s.severity === "fatal"
    );
  });

  const missingFatalTools = fatalTools.filter((s) => {
    const state = checkStates[s.tool];
    return state !== "loading" && !state?.available;
  });

  const outdatedFatalTools = fatalTools.filter((s) => {
    const state = checkStates[s.tool];
    return state !== "loading" && state?.available && !state.meetsMinVersion;
  });

  const readyCount = readyTools.length;
  const totalCount = visibleSpecs.length;

  // Warning state: has any warnings (warn severity tools not meeting version or missing)
  const hasWarning = allDone && warningTools.length > 0;

  const headerSummary = (
    <>
      <span className="text-sm font-medium text-text-primary">System requirements</span>

      {isChecking && (
        <span className="flex items-center gap-1.5 ml-auto text-2xs text-text-secondary">
          <Spinner size="xs" />
          Checking…
        </span>
      )}

      {allDone && !hasFatalFailure && !hasWarning && !error && (
        <span className="flex items-center gap-1.5 ml-auto text-2xs text-status-success">
          <CircleCheck className="w-3.5 h-3.5" />
          All system tools ready
        </span>
      )}

      {allDone && hasFatalFailure && (
        <span className="flex items-center gap-1.5 ml-auto text-2xs text-status-error">
          <CircleX className="w-3.5 h-3.5" />
          Action required: {readyCount} of {totalCount} tools ready
        </span>
      )}

      {allDone && !hasFatalFailure && hasWarning && (
        <span className="flex items-center gap-1.5 ml-auto text-2xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5" />
          Warning: {readyCount} of {totalCount} tools ready
        </span>
      )}
    </>
  );

  return (
    <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-canvas/30">
      {/* While a required tool is missing the panel cannot fold, so the row is
          a heading rather than a disclosure that would do nothing. */}
      {shownFatal ? (
        <div className="flex items-center gap-2.5 w-full px-3 py-2.5">{headerSummary}</div>
      ) : (
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setUserExpanded((v) => !v)}
          aria-expanded={isExpanded}
          aria-controls="system-requirements-panel"
          className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left cursor-pointer rounded-[var(--radius-md)] transition-colors hover:bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 text-text-secondary shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
          />
          {headerSummary}
        </button>
      )}

      <m.div
        id="system-requirements-panel"
        inert={!isExpanded || undefined}
        animate={{ height: isExpanded ? "auto" : 0 }}
        initial={false}
        transition={
          prefersReducedMotion
            ? { duration: 0 }
            : { duration: UI_ENTER_DURATION / 1000, ease: EASE_OUT_EXPO_FM }
        }
        style={{ overflow: "hidden" }}
      >
        <div className="px-3 pb-3 space-y-3">
          {error && (
            <Callout severity="error" role="alert">
              <p>Could not run health check: {error}</p>
            </Callout>
          )}

          {visibleSpecs.length > 0 && (
            // items-start: an expanded card must not stretch its row partner.
            <div className="grid grid-cols-2 items-start gap-2">
              {visibleSpecs.map((spec) => (
                <PrerequisiteCard
                  key={spec.tool}
                  spec={spec}
                  state={checkStates[spec.tool] ?? "loading"}
                />
              ))}
            </div>
          )}

          {visibleSpecs.length === 0 && isChecking && (
            <Skeleton label="Checking system requirements" className="grid grid-cols-2 gap-2">
              {/* `immediate` — spawning version-check processes reliably
                  exceeds the 400ms gate. */}
              {Array.from({ length: 4 }, (_, i) => (
                <SkeletonBone
                  key={i}
                  immediate
                  heightPx={52}
                  className="rounded-[var(--radius-md)]"
                />
              ))}
            </Skeleton>
          )}

          {shownFatal && (
            <Callout
              severity="error"
              role="alert"
              aria-live="assertive"
              // The control that finishes it sits beside the line that says what
              // to do, rather than below the fold of the expanded steps.
              action={
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    if (!isChecking) void runCheck();
                  }}
                  onFocus={() => {
                    checkAgainFocusedRef.current = true;
                  }}
                  onBlur={() => {
                    checkAgainFocusedRef.current = false;
                  }}
                  // Busy, not unavailable: the rotating glyph says so, and the
                  // button keeps keyboard focus rather than dropping it to <body>.
                  aria-busy={isChecking || undefined}
                  aria-disabled={isChecking || undefined}
                  className="shrink-0"
                >
                  <SpinningIcon
                    icon={RotateCw}
                    active={isChecking}
                    className="w-3 h-3"
                    aria-hidden
                  />
                  Check again
                </Button>
              }
            >
              <div className="space-y-1.5">
                {missingFatalTools.map((spec) => (
                  <p key={spec.tool} className="text-xs text-text-primary">
                    Install {spec.label} using the steps above, then check again.
                  </p>
                ))}
                {outdatedFatalTools.map((spec) => {
                  const state = checkStates[spec.tool];
                  if (!state || state === "loading") return null;
                  return (
                    <p key={spec.tool} className="text-xs text-text-primary">
                      Update {spec.label} to v{spec.minVersion} or later (you have v{state.version}
                      ), then check again.
                    </p>
                  );
                })}
              </div>
            </Callout>
          )}

          {!shownFatal && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (!isChecking) void runCheck();
              }}
              aria-busy={isChecking || undefined}
              aria-disabled={isChecking || undefined}
            >
              <SpinningIcon icon={RotateCw} active={isChecking} className="w-3 h-3" aria-hidden />
              Re-check
            </Button>
          )}
        </div>
      </m.div>
    </div>
  );
}
