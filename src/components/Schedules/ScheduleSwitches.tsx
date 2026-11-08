import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { schedulesClient } from "@/clients/schedulesClient";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ProjectScheduleSwitches } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobStatus, SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { scheduleOsJobUnavailable, type ScheduleOsJobKind } from "@shared/utils/scheduleOsJob";
import { scheduleOsJobKindHere } from "./scheduleOsJobKind";

export const SCHEDULES_ON_LABEL = "Schedules on";
export const START_WHEN_CLOSED_LABEL = "Start Daintree for due schedules";

const START_DESCRIPTION: Record<ScheduleOsJobKind, string> = {
  "launch-agent":
    "When Daintree isn't running, macOS starts it for a due schedule while the Mac is awake. It never wakes a sleeping Mac.",
  "systemd-timer":
    "When Daintree isn't running, systemd starts it for a due schedule while the computer is awake. It never wakes a sleeping computer.",
  "task-scheduler":
    "When Daintree isn't running, Windows starts it for a due schedule while you're signed in, and can wake the PC for it where wake timers are allowed",
};
const START_FALLBACK_DESCRIPTION =
  "When Daintree isn't running, it starts without a window for a due schedule";

type SwitchKey = "schedulesOn" | "startWhenClosed";

/** A switch set one way: what a write asks main for, and what its Retry asks again. */
interface Intent {
  key: SwitchKey;
  on: boolean;
}

const INTENT_WORDS: Record<SwitchKey, string> = {
  schedulesOn: "schedules",
  startWhenClosed: "starting Daintree for due schedules",
};

const SWITCH_FAILURE_SELECTOR = "[data-switch-failure]";

interface Failure {
  message: string;
  /** Absent when main refused it: asking again would be refused again. */
  retry?: Intent;
}

interface ScheduleSwitchesProps {
  /** The project's switches (#16166); null before its schedules are read. */
  switches: ProjectScheduleSwitches | null;
  /** Main's word on the OS job, for what this machine can have; null until it answers. */
  osJobStatus: ScheduleOsJobStatus | null;
  /** Main's answer to a switch, folded in so the switch doesn't wait for the push. */
  onSaved: (snapshot: SchedulesSnapshot) => void;
  /** The job's status, under the switch that asks for it. */
  children?: ReactNode;
}

/**
 * The project's two switches for its schedules (#16168): whether they run at
 * all, and whether Daintree starts itself for them. Each shows main's
 * answer, never the click, and one change goes at a time.
 */
export function ScheduleSwitches({
  switches,
  osJobStatus,
  onSaved,
  children,
}: ScheduleSwitchesProps) {
  const [pending, setPending] = useState(false);
  // Set before the render that disables a second click, which can come first.
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const schedulesOnId = useId();
  const startWhenClosedId = useId();
  // The switch a retry hands focus back to, once the answer has rendered.
  const [refocus, setRefocus] = useState<SwitchKey | null>(null);

  useEffect(() => {
    if (refocus === null) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        refocus === "schedulesOn" ? schedulesOnId : startWhenClosedId
      );
      // Turned off where the job can't exist, the start switch is disabled now.
      const usable = target && !target.hasAttribute("disabled") ? target : null;
      (usable ?? document.getElementById(schedulesOnId))?.focus();
      setRefocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [refocus, schedulesOnId, startWhenClosedId]);

  const kind = scheduleOsJobKindHere(osJobStatus?.context ?? null);
  // Before main answers, a platform with a job is taken as able to have it;
  // main still refuses where it can't.
  const unavailable =
    osJobStatus?.unavailable ??
    scheduleOsJobUnavailable(
      osJobStatus?.context ?? { kind, systemTimeZone: null, unavailable: null }
    );

  // A new change clears the last failure; a retry keeps it up, and its focused
  // Retry with it, until main answers. An answer that takes Retry away hands
  // focus to the switch, unless the keyboard has moved on meanwhile.
  const write = async (intent: Intent, retrying = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    if (!retrying) setFailure(null);
    const words = `Couldn't turn ${intent.on ? "on" : "off"} ${INTENT_WORDS[intent.key]}.`;
    try {
      const outcome = await schedulesClient.setSwitches({ [intent.key]: intent.on });
      const retryHasFocus =
        retrying && document.activeElement?.closest(SWITCH_FAILURE_SELECTOR) != null;
      if (outcome.status === "saved") {
        onSaved(outcome.snapshot);
        setFailure(null);
      } else {
        setFailure({ message: `${words} ${outcome.issues.map((i) => i.message).join(". ")}` });
      }
      if (retryHasFocus) setRefocus(intent.key);
    } catch (cause) {
      logError("Failed to change the project's schedule switches", cause);
      setFailure({ message: `${words} ${formatErrorMessage(cause, "")}`.trim(), retry: intent });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const schedulesOn = switches?.schedulesOn ?? false;
  const startWhenClosed = switches?.startWhenClosed ?? false;

  return (
    <div className="space-y-2" data-testid="schedule-switches">
      {failure && (
        <Callout
          severity="error"
          role="alert"
          data-switch-failure=""
          action={
            failure.retry && (
              // `loading` keeps the button focusable while it blocks a second try.
              <Button
                variant="outline"
                size="sm"
                loading={pending}
                onClick={() => {
                  if (failure.retry) void write(failure.retry, true);
                }}
              >
                <RefreshCw />
                Retry
              </Button>
            )
          }
        >
          {failure.message}
        </Callout>
      )}
      <SettingsGroup>
        <SwitchRow
          id={schedulesOnId}
          label={SCHEDULES_ON_LABEL}
          description="Lets agents in this project run unattended on their schedules"
          checked={schedulesOn}
          pending={pending}
          disabled={switches === null}
          onToggle={() => void write({ key: "schedulesOn", on: !schedulesOn })}
        />
        <SettingsDependents
          disabled={switches !== null && !schedulesOn}
          reason={unavailable ? undefined : "Turn schedules on to use this"}
        >
          <SwitchRow
            id={startWhenClosedId}
            label={START_WHEN_CLOSED_LABEL}
            description={kind ? START_DESCRIPTION[kind] : START_FALLBACK_DESCRIPTION}
            checked={startWhenClosed}
            pending={pending}
            // Never locked on: main turns it off wherever it is.
            disabled={switches === null || (unavailable !== null && !startWhenClosed)}
            disabledReason={unavailable ?? undefined}
            onToggle={() => void write({ key: "startWhenClosed", on: !startWhenClosed })}
          />
        </SettingsDependents>
      </SettingsGroup>
      {children}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  pending,
  disabled,
  disabledReason,
  onToggle,
}: {
  /** On the switch itself, for handing focus back to it. */
  id: string;
  label: string;
  description: string;
  checked: boolean;
  pending: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  const toggle = () => {
    if (!pending) onToggle();
  };
  return (
    <SettingsRow
      label={label}
      description={description}
      disabled={disabled}
      disabledReason={disabledReason}
      onRowClick={toggle}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        // aria-disabled while saving, not disabled: a disabled switch drops the
        // focus a keyboard toggle left on it.
        <SettingsSwitch
          id={id}
          checked={checked}
          onCheckedChange={toggle}
          disabled={rowDisabled}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    />
  );
}
