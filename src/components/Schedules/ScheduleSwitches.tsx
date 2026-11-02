import { useRef, useState, type ReactNode } from "react";
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
import type {
  ScheduleOsJobStatus,
  ScheduleSwitchesPatch,
  SchedulesSnapshot,
} from "@shared/types/ipc/schedules";
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
  const [error, setError] = useState<string | null>(null);

  const kind = scheduleOsJobKindHere(osJobStatus?.context ?? null);
  // Before main answers, a platform with a job is taken as able to have it;
  // main still refuses where it can't.
  const unavailable =
    osJobStatus?.unavailable ??
    scheduleOsJobUnavailable(
      osJobStatus?.context ?? { kind, systemTimeZone: null, unavailable: null }
    );

  const write = async (patch: ScheduleSwitchesPatch, label: string, on: boolean) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const fail = (why: string) => setError(`Couldn't turn ${on ? "on" : "off"} ${label}. ${why}`);
    try {
      const outcome = await schedulesClient.setSwitches(patch);
      if (outcome.status === "saved") onSaved(outcome.snapshot);
      else fail(outcome.issues.map((issue) => issue.message).join(". "));
    } catch (cause) {
      logError("Failed to change the project's schedule switches", cause);
      fail(formatErrorMessage(cause, "Try again."));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const schedulesOn = switches?.schedulesOn ?? false;
  const startWhenClosed = switches?.startWhenClosed ?? false;

  return (
    <div className="space-y-2" data-testid="schedule-switches">
      {error && (
        <Callout severity="error" role="alert">
          {error}
        </Callout>
      )}
      <SettingsGroup>
        <SwitchRow
          label={SCHEDULES_ON_LABEL}
          description="Lets agents in this project run unattended on their schedules"
          checked={schedulesOn}
          pending={pending}
          disabled={switches === null}
          onToggle={() => void write({ schedulesOn: !schedulesOn }, "schedules", !schedulesOn)}
        />
        <SettingsDependents
          disabled={switches !== null && !schedulesOn}
          reason={unavailable ? undefined : "Turn schedules on to use this"}
        >
          <SwitchRow
            label={START_WHEN_CLOSED_LABEL}
            description={kind ? START_DESCRIPTION[kind] : START_FALLBACK_DESCRIPTION}
            checked={startWhenClosed}
            pending={pending}
            // Never locked on: main turns it off wherever it is.
            disabled={switches === null || (unavailable !== null && !startWhenClosed)}
            disabledReason={unavailable ?? undefined}
            onToggle={() =>
              void write(
                { startWhenClosed: !startWhenClosed },
                "starting Daintree for due schedules",
                !startWhenClosed
              )
            }
          />
        </SettingsDependents>
      </SettingsGroup>
      {children}
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  pending,
  disabled,
  disabledReason,
  onToggle,
}: {
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
