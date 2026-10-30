import type { IdleShellThresholdMinutes } from "@shared/types/ipc/idleBackgroundAutoClose";

/**
 * The idle thresholds' choices, shared by this machine's General page and a
 * host's work settings, so the same setting reads the same on either.
 */
export const IDLE_TERMINAL_THRESHOLD_PRESETS = [
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 240, label: "4h" },
] as const;

export const IDLE_BACKGROUND_THRESHOLD_PRESETS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
] as const;

export const IDLE_SHELL_THRESHOLD_PRESETS = [
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 240, label: "4h" },
  { value: 480, label: "8h" },
] as const satisfies ReadonlyArray<{ value: IdleShellThresholdMinutes; label: string }>;

/** "45m", "2h", "1h 30m": a duration in the presets' own words. */
export function formatThresholdMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The presets, plus the value itself when it is none of them: one set
 * elsewhere (an assistant, an older build) still shows as what it is.
 */
export function thresholdOptionsWith(
  presets: readonly { value: number; label: string }[],
  value: number | null
): { value: number; label: string }[] {
  if (value === null || presets.some((preset) => preset.value === value)) return [...presets];
  return [...presets, { value, label: formatThresholdMinutes(value) }].sort(
    (a, b) => a.value - b.value
  );
}
