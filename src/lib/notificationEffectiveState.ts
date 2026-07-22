import { EVENT_POLICY, type NotificationEventKind } from "@/lib/notify";

/**
 * Canonical kind order for the summary. An explicit type-annotated literal (not
 * a cast) keeps it lint-clean while staying in EVENT_POLICY declaration order;
 * a test asserts it stays in sync with EVENT_POLICY so a new kind can't be
 * silently dropped from the summary.
 */
const ALL_EVENT_KINDS: readonly NotificationEventKind[] = [
  "completed",
  "waiting",
  "workingPulse",
  "uiFeedback",
  "agent",
  "git",
  "host",
  "recovery",
  "settings",
  "connectivity",
];

/**
 * What a notification kind will actually do right now, given the stacked
 * suppression gates (global enable, session mute, scheduled quiet hours, and
 * the per-kind toggles). Drives the notification center's "what will fire right
 * now" summary so the user doesn't have to reason about the gates one by one.
 *
 * - `will-interrupt` — produces a toast (and a native banner for `watch`) now.
 * - `quiet-gated` — would interrupt, but session mute or quiet hours is holding
 *   it; resumes when the mute lifts.
 * - `kind-off` — a togglable notification kind the user switched off.
 * - `sound-off` — a sound-only kind whose sound the user switched off.
 * - `inbox-only` — a passive kind that only ever reaches the inbox.
 * - `disabled` — global notifications are off, so nothing fires.
 */
export type KindEffectiveStatus =
  "will-interrupt" | "quiet-gated" | "kind-off" | "sound-off" | "inbox-only" | "disabled";

export interface EffectiveStateInput {
  /** Global notifications enable toggle. */
  enabled: boolean;
  /** Session mute OR scheduled quiet hours currently active. */
  isQuiet: boolean;
  completedEnabled: boolean;
  waitingEnabled: boolean;
  workingPulseEnabled: boolean;
  uiFeedbackSoundEnabled: boolean;
  /**
   * OS-level Do-Not-Disturb / Focus state. Read-only display signal — does
   * NOT participate in `classifyKind` because the OS already silences its own
   * native banners; double-gating would hide signals the user cannot observe.
   * `true`/`false`/`undefined` map to "active"/"off"/"unknown" in the summary.
   */
  osDndActive?: boolean | undefined;
}

export interface KindEffectiveState {
  kind: NotificationEventKind;
  status: KindEffectiveStatus;
}

/** Concise display names for the summary — `EVENT_KIND_LABEL` is too verbose for a list. */
export const KIND_SHORT_LABEL: Record<NotificationEventKind, string> = {
  completed: "Completed",
  waiting: "Waiting",
  workingPulse: "Working pulse",
  uiFeedback: "UI sounds",
  agent: "Agent",
  git: "Git",
  host: "System",
  recovery: "Recovery",
  settings: "Settings",
  connectivity: "Connection",
};

function perKindToggle(
  kind: NotificationEventKind,
  input: EffectiveStateInput
): boolean | undefined {
  switch (kind) {
    case "completed":
      return input.completedEnabled;
    case "waiting":
      return input.waitingEnabled;
    case "workingPulse":
      return input.workingPulseEnabled;
    case "uiFeedback":
      return input.uiFeedbackSoundEnabled;
    default:
      return undefined;
  }
}

function classifyKind(
  kind: NotificationEventKind,
  input: EffectiveStateInput
): KindEffectiveStatus {
  if (!input.enabled) return "disabled";

  const policy = EVENT_POLICY[kind];
  const isPassive = policy.baseInterruption === "passive";
  const toggle = perKindToggle(kind, input);

  // A user-silenced kind never fires regardless of the quiet gate. Passive
  // sound kinds (working pulse, UI feedback) read as "sound off"; the rest are
  // real notification kinds switched off entirely.
  if (toggle === false) return isPassive ? "sound-off" : "kind-off";

  // Passive kinds only ever land in the inbox — they don't toast.
  if (isPassive) return "inbox-only";

  // Kinds that break through the quiet gate:
  // - `time-sensitive` / `critical` carry `urgent`, so the renderer `isQuiet`
  //   check lets them toast (see `resolveEventPolicyDefaults` in notify.ts).
  // - `waiting` pages through at the OS-native layer regardless: the main
  //   process fires it via `flushWaitingBurst → showWatchNotification`, which
  //   bypasses `drainQueue`'s quiet/session-mute gate ("waiting agents block
  //   user work and should page through" — AgentNotificationService.ts).
  const bypassesQuiet =
    policy.baseInterruption === "time-sensitive" ||
    policy.baseInterruption === "critical" ||
    kind === "waiting";
  if (input.isQuiet && !bypassesQuiet) return "quiet-gated";

  return "will-interrupt";
}

/**
 * Computes the effective status of every notification kind, in `EVENT_POLICY`
 * declaration order. Pure — no store or DOM access — so the summary logic stays
 * table-testable.
 */
export function computeEffectiveNotificationState(
  input: EffectiveStateInput
): KindEffectiveState[] {
  return ALL_EVENT_KINDS.map((kind) => ({
    kind,
    status: classifyKind(kind, input),
  }));
}

/** Kinds that produce a toast/native banner right now. */
export function selectInterruptingKinds(states: KindEffectiveState[]): NotificationEventKind[] {
  return states.filter((s) => s.status === "will-interrupt").map((s) => s.kind);
}

/** Real notification kinds (not sound-only) the user has switched off. */
export function selectKindOffKinds(states: KindEffectiveState[]): NotificationEventKind[] {
  return states.filter((s) => s.status === "kind-off").map((s) => s.kind);
}

function joinLabels(kinds: NotificationEventKind[]): string {
  return kinds.map((k) => KIND_SHORT_LABEL[k]).join(", ");
}

/**
 * The hero line that answers "what will interrupt me right now". Leads with the
 * interrupting kinds; falls back to a plain statement when nothing breaks through.
 */
export function heroLine(states: KindEffectiveState[]): string {
  const interrupting = selectInterruptingKinds(states);
  if (interrupting.length === 0) return "Nothing will interrupt you right now";
  return `Will interrupt you: ${joinLabels(interrupting)}`;
}

/**
 * Read-only display string describing the OS-level DND state. Returns `null`
 * when the signal is unknown (unsupported platform / detection failed) or when
 * DND is explicitly off — in both cases we don't show anything extra in the
 * summary. The OS already silences its own banners; this is purely informational.
 */
export function osDndDisplayNote(osDndActive: boolean | undefined): string | null {
  return osDndActive === true ? "OS Do Not Disturb is active" : null;
}
