import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, CircleCheck, Loader2, RotateCw } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { UI_ENTER_DURATION } from "@/lib/animationUtils";
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

  const hasWarning =
    allDone &&
    visibleSpecs.some((s) => {
      const state = checkStates[s.tool];
      return state !== "loading" && (!state?.available || !state.meetsMinVersion);
    });

  const summaryText = allDone
    ? visibleSpecs
        .filter((s) => {
          const state = checkStates[s.tool];
          return state !== "loading" && state?.available && state.meetsMinVersion;
        })
        .map((s) => {
          const state = checkStates[s.tool];
          const version = state !== "loading" && state?.version ? ` ${state.version}` : "";
          return `${s.label}${version}`;
        })
        .join(", ")
    : "";

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30">
      <button
        type="button"
        onClick={() => setUserExpanded((v) => !v)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 text-daintree-text/40 shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
        />
        <span className="text-sm font-medium text-daintree-text">System requirements</span>

        {isChecking && (
          <span className="flex items-center gap-1.5 ml-auto text-[11px] text-daintree-text/40">
            <Loader2 className="w-3 h-3 animate-spin" />
            Checking...
          </span>
        )}

        {allDone && !hasFatalFailure && !hasWarning && (
          <span className="flex items-center gap-1.5 ml-auto text-[11px] text-status-success">
            <CircleCheck className="w-3.5 h-3.5" />
            {summaryText}
          </span>
        )}

        {allDone && hasFatalFailure && (
          <span className="flex items-center gap-1.5 ml-auto text-[11px] text-status-error">
            Required tools missing
          </span>
        )}

        {allDone && !hasFatalFailure && hasWarning && (
          <span className="flex items-center gap-1.5 ml-auto text-[11px] text-status-warning">
            <AlertTriangle className="w-3.5 h-3.5" />
            {summaryText}
          </span>
        )}
      </button>

      <m.div
        animate={{ height: isExpanded ? "auto" : 0 }}
        initial={false}
        transition={
          prefersReducedMotion
            ? { duration: 0 }
            : { duration: UI_ENTER_DURATION / 1000, ease: [0.16, 1, 0.3, 1] }
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
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <div
                  key={i}
                  className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-3 py-2.5 animate-pulse h-[52px]"
                />
              ))}
            </div>
          )}

          {allDone && hasFatalFailure && (
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/5">
              <p className="text-xs text-status-warning">
                Some required tools are missing or outdated. Install them to continue setup.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 text-xs text-daintree-text/50 hover:text-daintree-text disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
          >
            <RotateCw className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? "Checking..." : "Re-check"}
          </button>
        </div>
      </m.div>
    </div>
  );
}
