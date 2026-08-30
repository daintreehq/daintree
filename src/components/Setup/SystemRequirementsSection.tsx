import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, CircleCheck, Loader2, RotateCw, CircleX } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { UI_ENTER_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import { useSystemHealthCheck } from "./useSystemHealthCheck";
import { PrerequisiteCard } from "./SystemToolsStep";

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

  const isExpanded = userExpanded || hasFatalFailure;

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

  return (
    <div className="rounded-[var(--radius-md)] border border-border-default bg-daintree-bg/30">
      <button
        type="button"
        onClick={() => setUserExpanded((v) => !v)}
        aria-expanded={isExpanded}
        aria-controls="system-requirements-panel"
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 text-daintree-text/40 shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
        />
        <span className="text-sm font-medium text-text-primary">System requirements</span>

        {isChecking && (
          <span className="flex items-center gap-1.5 ml-auto text-2xs text-text-secondary">
            <Loader2 className="w-3 h-3 animate-spin" />
            Checking...
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
      </button>

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
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
              <p className="text-xs text-status-error">Could not run health check: {error}</p>
            </div>
          )}

          {visibleSpecs.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
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

          {allDone && hasFatalFailure && (
            <div
              role="alert"
              aria-live="assertive"
              className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5 space-y-1.5"
            >
              {missingFatalTools.map((spec) => (
                <p key={spec.tool} className="text-xs text-status-error">
                  {spec.label} not found
                </p>
              ))}
              {outdatedFatalTools.map((spec) => {
                const state = checkStates[spec.tool];
                if (!state || state === "loading") return null;
                return (
                  <p key={spec.tool} className="text-xs text-status-error">
                    {spec.label} v{state.version} installed, needs v{spec.minVersion}+
                  </p>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
          >
            <RotateCw className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? "Checking..." : "Re-check"}
          </button>
        </div>
      </m.div>
    </div>
  );
}
