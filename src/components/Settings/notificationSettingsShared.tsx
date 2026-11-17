import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUNDLED_NOTIFICATION_SOUNDS,
  isCustomSoundId,
  type CustomNotificationSound,
  type CustomNotificationSoundEntry,
} from "@shared/types/ipc/notificationSounds";
import {
  importNotificationSound,
  soundImportErrorMessage,
} from "@/services/notificationSoundImport";
import { SettingsRow } from "./SettingsGroup";

/**
 * What the global and project Notifications pages share: the option lists and the
 * wording of every setting both scopes show. The project page overrides the global
 * values, so the two have to name the same settings the same way — they drifted apart
 * when each kept its own copy (the project list was missing a sound).
 */

export const NOTIFICATION_SOUNDS = BUNDLED_NOTIFICATION_SOUNDS;

export const ESCALATION_DELAY_OPTIONS = [
  { value: 60_000, label: "1 min", ariaLabel: "1 minute" },
  { value: 180_000, label: "3 min", ariaLabel: "3 minutes" },
  { value: 300_000, label: "5 min", ariaLabel: "5 minutes" },
  { value: 600_000, label: "10 min", ariaLabel: "10 minutes" },
] as const;

export function soundLabel(
  file: unknown,
  customSounds: readonly CustomNotificationSoundEntry[] = []
): string {
  const bundled = NOTIFICATION_SOUNDS.find((s) => s.file === file);
  if (bundled) return bundled.label;
  const custom = customSounds.find((s) => s.id === file);
  if (custom) return custom.available ? custom.label : `${custom.label} (missing)`;
  return isCustomSoundId(file) ? "Missing sound" : String(file);
}

/**
 * This device's imported sounds for one settings page, shared by its pickers. A
 * list that resolves after a newer one started (an import, a picker opening) is
 * dropped, so it can't hide a sound that was just added.
 */
export function useCustomNotificationSounds() {
  const [sounds, setSounds] = useState<CustomNotificationSoundEntry[]>([]);
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const api = window.electron?.notificationSounds;
    if (!api) return;
    const request = ++requestRef.current;
    api
      .list()
      .then((list) => {
        if (request === requestRef.current) setSounds(list);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const importFile = useCallback(
    async (file: File): Promise<CustomNotificationSound> => {
      const imported = await importNotificationSound(file);
      setSounds((current) =>
        current.some((s) => s.id === imported.id)
          ? current
          : [...current, { ...imported, available: true }]
      );
      refresh();
      return imported;
    },
    [refresh]
  );

  return { sounds, refresh, importFile };
}

const CHOOSE_FILE_VALUE = "__choose-file__";

export function escalationDelayLabel(ms: unknown): string {
  return ESCALATION_DELAY_OPTIONS.find((o) => o.value === ms)?.ariaLabel ?? String(ms);
}

export const NOTIFICATION_COPY = {
  completed: {
    label: "Agent finished",
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
    /** A project can't override UI feedback sounds, so its switch doesn't claim them. */
    projectDescription: "Sounds for this project's agent notifications and working pulse",
  },
  volume: {
    label: "Volume",
    description: "For every sound here and UI feedback, on top of the system volume",
  },
  workingPulse: {
    label: "Working pulse",
    description: "A quiet periodic sound while a watched or docked agent works in the background",
  },
  soundFiles: {
    completedSoundFile: "Finished sound",
    waitingSoundFile: "Waiting sound",
    escalationSoundFile: "Escalation sound",
    workingPulseSoundFile: "Working pulse sound",
  },
  workingPulseOffReason: "Turn on Working pulse to choose its sound",
} as const;

export type SoundFileKey = keyof typeof NOTIFICATION_COPY.soundFiles;

/**
 * A sound picker with its Preview on the rail. The same row in both scopes, so a
 * sound is chosen with the same control wherever it is set. Its last entry
 * imports a file from disk and selects it.
 */
export function SoundPickerRow({
  label,
  description,
  value,
  onChange,
  onPreview,
  customSounds = [],
  onImportFile,
  onOpen,
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
  customSounds?: readonly CustomNotificationSoundEntry[];
  onImportFile?: (file: File) => Promise<CustomNotificationSound>;
  /** Called as the list opens, so imports made in another window show up. */
  onOpen?: () => void;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const available = customSounds.filter((s) => s.available);
  const playable =
    value !== undefined &&
    (NOTIFICATION_SOUNDS.some((s) => s.file === value) || available.some((s) => s.id === value));

  const handleFile = (file: File | undefined) => {
    if (!file || !onImportFile) return;
    setImportError(null);
    setImporting(true);
    onImportFile(file)
      .then((imported) => onChange(imported.id))
      .catch((error: unknown) => setImportError(soundImportErrorMessage(error)))
      .finally(() => setImporting(false));
  };

  return (
    <SettingsRow
      label={label}
      description={description}
      isModified={isModified}
      onReset={onReset}
      resetAriaLabel={resetAriaLabel}
      disabled={disabled}
      error={importError}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        <div className="flex items-center gap-2">
          <Select
            value={value ?? ""}
            onValueChange={(next) => {
              if (next === CHOOSE_FILE_VALUE) {
                fileInputRef.current?.click();
                return;
              }
              setImportError(null);
              onChange(next);
            }}
            onOpenChange={(open) => {
              if (open) onOpen?.();
            }}
            disabled={rowDisabled || importing}
          >
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
              {available.length > 0 && <SelectSeparator />}
              {available.map((sound) => (
                <SelectItem key={sound.id} value={sound.id}>
                  {sound.label}
                </SelectItem>
              ))}
              {value && !playable && (
                // The saved choice is an import whose file is gone: shown so the
                // trigger names it, but it can't be picked again.
                <SelectItem value={value} disabled>
                  {soundLabel(value, customSounds)}
                </SelectItem>
              )}
              {onImportFile && (
                <>
                  <SelectSeparator />
                  <SelectItem value={CHOOSE_FILE_VALUE}>Choose file…</SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
          {onImportFile && (
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                // Cleared so choosing the same file again still fires a change.
                event.currentTarget.value = "";
                handleFile(file);
              }}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (value) onPreview(value);
            }}
            disabled={rowDisabled || !playable}
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

/**
 * The volume setting as a slider. It shows each step while dragging but saves
 * once, when the drag or key press ends, rather than a write per step.
 */
export function SoundVolumeRow({
  value,
  onCommit,
  isModified,
  onReset,
}: {
  value: number;
  onCommit: (value: number) => void;
  isModified?: boolean;
  onReset?: () => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const percent = Math.round((draft ?? value) * 100);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };

  return (
    <SettingsRow
      id="notifications-sound-volume"
      label={NOTIFICATION_COPY.volume.label}
      description={NOTIFICATION_COPY.volume.description}
      isModified={isModified}
      onReset={onReset}
      resetAriaLabel="Reset volume to 100%"
      control={({ labelId, descriptionId, disabled }) => (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={percent}
            onChange={(e) => setDraft(Number(e.target.value) / 100)}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-valuetext={`${percent} percent`}
            className="w-40 accent-[var(--color-text-primary)] disabled:opacity-50"
            disabled={disabled}
          />
          <span
            className="text-xs text-text-secondary font-mono w-10 text-right"
            aria-hidden="true"
          >
            {percent}%
          </span>
        </div>
      )}
    />
  );
}

export function previewNotificationSound(file: string): void {
  window.electron?.notification?.playSound(file).catch(() => {});
}
