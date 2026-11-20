import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsInvolvementMode,
  DecisionsInvolvementPreference,
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  DecisionsInvolvementUnavailableReason,
  SetDecisionsInvolvementPayload,
} from "@shared/types/decisionsInvolvement";

/** The most other agents a person can ask to be consulted (the protocol's `involvementConsultMax`). */
export const CONSULT_MAX = 8;

/** The longest a temporary mode can last (the protocol's `involvementOverrideMaxMs`). */
export const OVERRIDE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export const MODE_LABEL: Record<DecisionsInvolvementMode, string> = {
  "involve-early": "Ask while exploring",
  recommend: "Bring a recommendation",
};

export type AvailablePreference = Extract<DecisionsInvolvementPreference, { status: "available" }>;

/** What agents are asked to do in `mode`, in words. */
export function modeDetail(mode: DecisionsInvolvementMode, consultCount: number): string {
  return mode === "involve-early"
    ? "Agents are asked to come to you while they explore the options."
    : `Agents are asked to consult ${pluralize(consultCount, "other agent")} first, then bring you a recommendation.`;
}

/** The normal mode a temporary one gives way to, with the count a recommendation consults. */
export function thenText(preference: AvailablePreference): string {
  return preference.normalMode === "recommend"
    ? `then bring a recommendation, consulting ${pluralize(preference.consultCount, "other agent")}`
    : "then ask while exploring";
}

/** What agents do while the copy may be out of date: the library tells them to keep their usual behaviour. */
export const STALE_TEXT =
  "This computer hasn't confirmed it since it last reconnected or heard of a change: until it does, agents use their usual behaviour.";

/**
 * Where it was set, for the person: `computer` is the owner computer, which
 * is this one unless this computer is a Remote Host.
 */
export function setOnText(
  setOn: AvailablePreference["setOn"],
  role: Extract<DecisionsInvolvementRead, { result: "read" }>["role"]
): string {
  if (setOn === "phone") return "Set on a phone or tablet ";
  return role === "host" ? "Set on the owner computer " : "Set on this computer ";
}

/**
 * The mode in force at `now`: a temporary mode applies while `now < until`,
 * the normal mode from then on. Main works it out when it is read, so a read
 * goes stale the moment a temporary mode ends; this keeps the display current
 * between reads, as agents' next read will be.
 */
export function inForce(
  preference: AvailablePreference,
  now: number
): { mode: DecisionsInvolvementMode; until: string | null } {
  const override = preference.override;
  if (override !== null && now < Date.parse(override.until)) {
    return { mode: override.mode, until: override.until };
  }
  return { mode: preference.normalMode, until: null };
}

/** Milliseconds until the temporary mode in force ends, or null when none is. */
export function msUntilChange(
  preference: DecisionsInvolvementPreference,
  now: number
): number | null {
  if (preference.status !== "available" || preference.override === null) return null;
  const until = Date.parse(preference.override.until);
  return now < until ? until - now : null;
}

/** When a temporary mode ends, for "until …": the time alone today, the day too otherwise. */
export function formatUntil(iso: string, now: number): string {
  const end = new Date(iso);
  const today = new Date(now);
  const sameDay =
    end.getFullYear() === today.getFullYear() &&
    end.getMonth() === today.getMonth() &&
    end.getDate() === today.getDate();
  return sameDay
    ? end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : end.toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const UNAVAILABLE: Record<DecisionsInvolvementUnavailableReason, string> = {
  "not-synced": "This computer hasn't read a preference from the relay yet.",
  "not-set": "No involvement preference is set.",
  unsupported: "This relay doesn't support involvement preferences.",
  "signer-revoked": "The device that set the last preference was removed.",
  "device-revoked": "The relay removed this computer.",
};

/** Why no preference is in force, and that agents fall back to their usual behaviour. */
export function unavailableText(reason: DecisionsInvolvementUnavailableReason): string {
  return `${UNAVAILABLE[reason]} Agents use their usual behaviour.`;
}

const UNAVAILABLE_LABEL: Record<DecisionsInvolvementUnavailableReason, string> = {
  "not-set": "Not set",
  "not-synced": "Not read from the relay yet",
  unsupported: "Not supported by this relay",
  "signer-revoked": "Set by a device that was removed",
  "device-revoked": "This computer was removed from the relay",
};

/** Why no preference is in force, short enough for the inbox's one line. */
export function unavailableLabel(reason: DecisionsInvolvementUnavailableReason): string {
  return UNAVAILABLE_LABEL[reason];
}

/** Shown after a conflict while this computer waits to read the revision that won. */
export const WAITING_TEXT = "Reading the newer preference before it can be changed again…";

/**
 * Why the person can't change the preference here, or null when they can.
 * `refusedByRelay` is a save this opening sent that the relay turned away as
 * one it doesn't take from this computer.
 */
export function readOnlyText(
  read: Extract<DecisionsInvolvementRead, { result: "read" }>,
  refusedByRelay: boolean
): string | null {
  if (read.role === "host") {
    return "This computer is a Remote Host: change it on the owner computer or a phone.";
  }
  const preference = read.preference;
  if (preference.status === "unavailable" && preference.reason === "unsupported") {
    return "Update the relay to set it from here or from a phone.";
  }
  if (preference.status === "unavailable" && preference.reason === "device-revoked") {
    return "Change it from a phone.";
  }
  if (refusedByRelay) {
    return "This relay doesn't take changes from this computer. A relay older than 0.8.0 takes them only from a phone: update it to change this here.";
  }
  if (!read.settable) return "Changes can be made once this computer reconnects to the relay.";
  return null;
}

/** The person's change as they are making it. `until` is the field's local date and time. */
export interface InvolvementDraft {
  normalMode: DecisionsInvolvementMode;
  consultCount: number;
  temporary: boolean;
  temporaryMode: DecisionsInvolvementMode;
  /** `YYYY-MM-DDTHH:mm` in local time, as a `datetime-local` field holds it. */
  until: string;
  /**
   * The exact end of the temporary mode the draft started from, kept while
   * `until` is untouched, so changing anything else never moves it to the
   * field's minute.
   */
  keptUntil: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `ms` as a `datetime-local` value, in local time. */
export function localDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * A `datetime-local` value as epoch ms, or NaN when it isn't one, or names a
 * time the clocks skip: the browser would move it an hour on, so the end
 * saved would not be the one shown.
 */
export function parseLocalDateTime(value: string): number {
  if (!LOCAL_DATE_TIME.test(value)) return Number.NaN;
  // Without an offset the date-time form is local time.
  const ms = new Date(value).getTime();
  return localDateTime(ms) === value ? ms : Number.NaN;
}

/** A whole local date and time that the clocks skip where this computer is. */
function skippedLocalTime(value: string): boolean {
  return (
    LOCAL_DATE_TIME.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    Number.isNaN(parseLocalDateTime(value))
  );
}

const HOUR_MS = 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * A draft from what the person reviewed: an ended temporary mode is left out,
 * since the relay refuses saving it again, and a temporary mode starts out as
 * the other mode, for an hour.
 */
export function draftFrom(
  preference: DecisionsInvolvementPreference,
  now: number
): InvolvementDraft {
  const fallbackUntil = Math.ceil((now + HOUR_MS) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  if (preference.status !== "available") {
    return {
      normalMode: "recommend",
      consultCount: 1,
      temporary: false,
      temporaryMode: "involve-early",
      until: localDateTime(fallbackUntil),
      keptUntil: null,
    };
  }
  const active = inForce(preference, now).until !== null ? preference.override : null;
  const other: DecisionsInvolvementMode =
    preference.normalMode === "recommend" ? "involve-early" : "recommend";
  return {
    normalMode: preference.normalMode,
    consultCount: preference.consultCount,
    temporary: active !== null,
    temporaryMode: active?.mode ?? other,
    until: localDateTime(active === null ? fallbackUntil : Date.parse(active.until)),
    keptUntil: active?.until ?? null,
  };
}

/** The end of the draft's temporary mode as the ISO time the relay takes, or null when it isn't one. */
export function draftUntil(draft: InvolvementDraft): string | null {
  if (draft.keptUntil !== null) return draft.keptUntil;
  const ms = parseLocalDateTime(draft.until);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Whether two drafts would save the same preference: a temporary mode's fields count only while it is on. */
export function sameDraft(a: InvolvementDraft, b: InvolvementDraft): boolean {
  if (
    a.normalMode !== b.normalMode ||
    a.consultCount !== b.consultCount ||
    a.temporary !== b.temporary
  ) {
    return false;
  }
  return !a.temporary || (a.temporaryMode === b.temporaryMode && draftUntil(a) === draftUntil(b));
}

export interface DraftIssue {
  field: "count" | "until";
  text: string;
}

/** Why the draft can't be saved at `now`, and which field says so, or null. */
export function draftIssue(draft: InvolvementDraft, now: number): DraftIssue | null {
  const count = draft.consultCount;
  if (!Number.isInteger(count) || count < 1 || count > CONSULT_MAX) {
    return { field: "count", text: `Enter a whole number from 1 to ${CONSULT_MAX}.` };
  }
  if (!draft.temporary) return null;
  const until = draftUntil(draft);
  if (until === null) {
    return {
      field: "until",
      text:
        draft.keptUntil === null && skippedLocalTime(draft.until)
          ? "The clocks skip that time here. Choose another."
          : "Choose when it ends.",
    };
  }
  const ms = Date.parse(until);
  if (ms <= now) return { field: "until", text: "It has to end in the future." };
  if (ms > now + OVERRIDE_MAX_MS) return { field: "until", text: "It can last at most 30 days." };
  return null;
}

/** The change to send, replacing `expectedRevision`. Call only once `draftIssue` is null. */
export function draftPayload(
  draft: InvolvementDraft,
  expectedRevision: number
): SetDecisionsInvolvementPayload {
  const until = draft.temporary ? draftUntil(draft) : null;
  return {
    expectedRevision,
    normalMode: draft.normalMode,
    consultCount: draft.consultCount,
    override: until === null ? null : { mode: draft.temporaryMode, until },
  };
}

export type SaveNotice = { severity: "warning" | "error" | "info"; text: string };

/** A change whose fate this computer couldn't learn: never said to be saved or lost. */
export const UNCONFIRMED_NOTICE: SaveNotice = {
  severity: "warning",
  text: "This computer couldn't confirm whether your change was saved. Check the preference before changing it again.",
};

/**
 * What the inbox says after a save, or null for one that went through.
 * `relayRefusal` is set for a refusal that leaves the section read-only.
 */
export function saveNotice(
  result: DecisionsInvolvementSaveResult
): (SaveNotice & { relayRefusal: boolean }) | null {
  switch (result.result) {
    case "saved":
      return null;
    case "conflict":
      return {
        severity: "warning",
        text: "The relay holds a different version of the preference from the one you changed, so your change wasn't saved. Review the latest before changing it again.",
        relayRefusal: false,
      };
    case "unsupported":
      return {
        severity: "warning",
        text: "This relay doesn't take involvement preferences, so your change wasn't saved.",
        relayRefusal: true,
      };
    case "unconfirmed":
      return { ...UNCONFIRMED_NOTICE, relayRefusal: false };
    case "refused":
      if (result.reason === "not-owner") {
        return {
          severity: "error",
          text: "This computer is a Remote Host, so it can't change the preference.",
          relayRefusal: false,
        };
      }
      if (result.reason === "revoked") {
        return {
          severity: "error",
          text: "The relay removed this computer, so your change wasn't sent.",
          relayRefusal: false,
        };
      }
      if (result.reason === "invalid") {
        return {
          severity: "error",
          text: `Your change wasn't saved: ${result.detail}.`,
          relayRefusal: false,
        };
      }
      // A relay older than 0.8.0 takes a change only from a phone or tablet.
      if (result.code === "forbidden") {
        return {
          severity: "warning",
          text: "The relay didn't take the change from this computer, so it wasn't saved.",
          relayRefusal: true,
        };
      }
      return {
        severity: "error",
        text: `The relay refused the change (${result.code}), so it wasn't saved.`,
        relayRefusal: false,
      };
    case "off":
    case "not-running":
      return {
        severity: "warning",
        text: "This computer isn't connected to the relay, so your change wasn't sent.",
        relayRefusal: false,
      };
  }
}
