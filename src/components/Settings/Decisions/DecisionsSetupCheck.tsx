import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import {
  DECISIONS_SETUP_CHECK_STEPS,
  type DecisionsSetupCheckRun,
  type DecisionsSetupDiagnosticTerminal,
  type DecisionsStatus,
} from "@shared/types/decisions";
import { SETUP_STEP_LABEL, describeSetupStep } from "./setupCheckCopy";
import type { UseSetupCheckResult } from "./useSetupCheck";

function dateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** What the check row says about the last check: the run shown, or the one recorded. */
function summary(run: DecisionsSetupCheckRun | null, status: DecisionsStatus): string {
  if (run?.state === "running") {
    return "Checking each part of the loop in turn. Keep Settings open until it finishes.";
  }
  if (run?.state === "cancelled") return "The last check was cancelled, so it recorded nothing";
  const recorded = status.setupCheck;
  if (recorded) {
    return recorded.failedStep === null
      ? `Every step passed on ${dateTime(recorded.checkedAt)}`
      : `The check on ${dateTime(recorded.checkedAt)} stopped at ${SETUP_STEP_LABEL[recorded.failedStep].toLowerCase()}`;
  }
  return "Proves the whole loop: the relay, its claim, a socket, push, and a test question to your paired phones whose answer comes back into a diagnostic terminal. Run it again any time";
}

function DiagnosticTerminal({ terminal }: { terminal: DecisionsSetupDiagnosticTerminal }) {
  return (
    <SettingsRow
      id="decisions-setup-diagnostic"
      label={terminal.title}
      description="Runs no agent and no process, so nothing typed here can run. Your answer is typed here, and it closes when the check ends."
      layout="stacked"
      control={({ labelId, descriptionId }) => (
        <pre
          role="log"
          aria-live="polite"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className="max-h-64 overflow-auto rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text-primary"
        >
          {terminal.screen === "" ? "Waiting for an answer from your phone…" : terminal.screen}
        </pre>
      )}
    />
  );
}

/**
 * Check setup (#16024): runs the whole loop against the relay set up here,
 * shows each step as it observes it, and holds the diagnostic terminal the
 * test answer is typed into while the run has it open. Runs again later as a
 * doctor from the same row.
 */
export function DecisionsSetupCheck({
  check,
  status,
  disabled,
}: {
  check: UseSetupCheckResult;
  status: DecisionsStatus;
  disabled: boolean;
}) {
  const { run } = check;
  const running = run?.state === "running";
  return (
    <SettingsGroup id="decisions-setup-check-group">
      <SettingsRow
        id="decisions-setup-check"
        label="Setup check"
        description={summary(run, status)}
        error={check.error ?? undefined}
        disabled={disabled && !running}
        control={({ descriptionId, disabled: rowDisabled }) =>
          running ? (
            <Button
              variant="outline"
              size="sm"
              aria-describedby={descriptionId}
              onClick={() => check.cancel()}
            >
              Cancel check
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              loading={check.starting}
              disabled={rowDisabled}
              aria-describedby={descriptionId}
              data-decisions-setup-check-start=""
              onClick={() => check.start()}
            >
              {run || status.setupCheck ? "Check again" : "Check setup"}
            </Button>
          )
        }
      />
      {run &&
        DECISIONS_SETUP_CHECK_STEPS.map((step) => {
          const state = run.steps[step];
          const view = describeSetupStep(step, state, run);
          return (
            <SettingsRow
              key={step}
              id={`decisions-setup-check-${step}`}
              label={view.label}
              accessory={
                view.severity ? (
                  <SeverityMark
                    severity={view.severity}
                    label={view.severity === "success" ? "Passed" : "Failed"}
                    className="h-3.5 w-3.5"
                  />
                ) : state.state === "running" ? (
                  <Spinner size="sm" className="text-text-secondary" />
                ) : undefined
              }
              description={view.detail}
            />
          );
        })}
      {run?.diagnostic && <DiagnosticTerminal terminal={run.diagnostic} />}
    </SettingsGroup>
  );
}
