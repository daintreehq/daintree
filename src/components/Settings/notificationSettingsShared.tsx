import type { ReactNode } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "./SettingsGroup";

/**
 * What the global and project Notifications pages share: the option lists and the
 * wording of every setting both scopes show. The project page overrides the global
 * values, so the two have to name the same settings the same way — they drifted apart
 * when each kept its own copy (the project list was missing a sound).
 */

export const NOTIFICATION_SOUNDS: { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime" },
  { file: "ping.wav", label: "Ping" },
  { file: "complete.wav", label: "Complete" },
  { file: "waiting.wav", label: "Waiting" },
  { file: "error.wav", label: "Error" },
  { file: "pulse.wav", label: "Pulse" },
];

export const ESCALATION_DELAY_OPTIONS = [
  { value: 60_000, label: "1 min", ariaLabel: "1 minute" },
  { value: 180_000, label: "3 min", ariaLabel: "3 minutes" },
  { value: 300_000, label: "5 min", ariaLabel: "5 minutes" },
  { value: 600_000, label: "10 min", ariaLabel: "10 minutes" },
] as const;

export function soundLabel(file: unknown): string {
  return NOTIFICATION_SOUNDS.find((s) => s.file === file)?.label ?? String(file);
}

export function escalationDelayLabel(ms: unknown): string {
  return ESCALATION_DELAY_OPTIONS.find((o) => o.value === ms)?.ariaLabel ?? String(ms);
}

export const NOTIFICATION_COPY = {
  completed: {
    label: "Agent completed",
    description: "Send an OS notification when an agent finishes its task",
  },
  waiting: {
    label: "Agent waiting for input",
    description: "Send an OS notification as soon as an agent needs input",
  },
  escalation: {
    label: "Escalate if still waiting",
    description: "Send a second OS notification if a docked agent is still waiting after the delay",
  },
  escalationDelay: {
    label: "Escalation delay",
    description: "How long a docked agent waits before the second notification",
  },
  escalationOffReason: "Turn on Escalate if still waiting to choose a delay",
  waitingOffReason: "Turn on Agent waiting for input to escalate reminders",
  sound: {
    label: "Play sound",
    description: "Sounds for agent notifications, the working pulse and UI feedback",
  },
  workingPulse: {
    label: "Working pulse",
    description: "A quiet periodic sound while a watched or docked agent works in the background",
  },
  soundFiles: {
    completedSoundFile: "Completed sound",
    waitingSoundFile: "Waiting sound",
    escalationSoundFile: "Escalation sound",
    workingPulseSoundFile: "Working pulse sound",
  },
  workingPulseOffReason: "Turn on Working pulse to choose its sound",
} as const;

export type SoundFileKey = keyof typeof NOTIFICATION_COPY.soundFiles;

/**
 * A sound picker with its Preview on the rail. The same row in both scopes, so a
 * sound is chosen with the same control wherever it is set.
 */
export function SoundPickerRow({
  label,
  description,
  value,
  onChange,
  onPreview,
  isModified,
  onReset,
  resetAriaLabel,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  value: string | undefined;
  onChange: (value: string) => void;
  onPreview: (file: string) => void;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      label={label}
      description={description}
      isModified={isModified}
      onReset={onReset}
      resetAriaLabel={resetAriaLabel}
      disabled={disabled}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        <div className="flex items-center gap-2">
          <Select value={value ?? ""} onValueChange={onChange} disabled={rowDisabled}>
            <SelectTrigger
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              className="w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_SOUNDS.map(({ file, label: name }) => (
                <SelectItem key={file} value={file}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (value) onPreview(value);
            }}
            disabled={rowDisabled || !value}
            aria-label={`Preview ${label.toLowerCase()}`}
          >
            <Play aria-hidden="true" />
            Preview
          </Button>
        </div>
      )}
    />
  );
}

export function previewNotificationSound(file: string): void {
  window.electron?.notification?.playSound(file).catch(() => {});
}
