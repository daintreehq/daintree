import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { scheduleFlip } from "@/utils/flipScheduler";
import type { DecisionsInvolvementRead } from "@shared/types/decisionsInvolvement";
import {
  UNCONFIRMED_NOTICE,
  draftFrom,
  draftIssue,
  draftPayload,
  draftUntil,
  msUntilChange,
  readOnlyText,
  sameDraft,
  saveNotice,
  type InvolvementDraft,
  type SaveNotice,
} from "./decisionsInvolvementModel";

/**
 * How often the preference is read again while it is shown. The library
 * takes a phone's change from the relay's hint on its own and tells no one,
 * so a read is the only way to see it; it reads this computer's copy and
 * touches no network.
 */
export const INVOLVEMENT_READ_MS = 5_000;

/** How long after a conflict a change waits for this computer to read the revision that won. */
const BEHIND_WAIT_MS = 15_000;

export type InvolvementRead = Extract<DecisionsInvolvementRead, { result: "read" }>;

export type InvolvementLoad =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "read"; read: InvolvementRead }
  | { state: "not-running" };

const LOADING: InvolvementLoad = { state: "loading" };

/** A read settled as a value, null when it fails, a bridge that throws rather than rejects included. */
function readInvolvement(): Promise<DecisionsInvolvementRead | null> {
  try {
    return decisionsClient.getInvolvement().then(
      (value) => value,
      () => null
    );
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * The preference while `active`, as this opening read it, read again every
 * few seconds while the window is visible, whenever `statusRevision` moves,
 * and on `reload`. A read that fails keeps the last good one. `at` is when
 * the shown read landed.
 */
function useInvolvementRead(
  active: boolean,
  opening: number,
  statusRevision: number | null
): { load: InvolvementLoad; at: number; reload: () => void } {
  const [current, setCurrent] = useState<{
    opening: number;
    load: InvolvementLoad;
    at: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      // Settled as a value, not thrown: a read that fails keeps the last good one.
      const result = await readInvolvement();
      reading = false;
      if (stopped) return;
      const at = Date.now();
      if (result === null) {
        setCurrent((previous) =>
          previous !== null && previous.opening === opening && previous.load.state === "read"
            ? previous
            : { opening, load: { state: "failed" }, at }
        );
        return;
      }
      const load: InvolvementLoad =
        result.result === "read" ? { state: "read", read: result } : { state: "not-running" };
      setCurrent({ opening, load, at });
    };
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, INVOLVEMENT_READ_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, opening, statusRevision, attempt]);
  const shown = active && current !== null && current.opening === opening ? current : null;
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load: shown?.load ?? LOADING, at: shown?.at ?? 0, reload };
}

interface Edit {
  opening: number;
  /** The revision the person reviewed: a change replaces exactly it, whatever is read meanwhile. */
  revision: number;
  draft: InvolvementDraft;
  /** The draft as it started, so a form can tell an untouched one. */
  initial: InvolvementDraft;
  /** No preference was in force: saving the suggested one as it stands is still a change. */
  first: boolean;
}

/** The focusable surface of the dialog holding the section: `AppDialog` names its backdrop and focuses the surface inside. */
function dialogSurface(section: HTMLElement | null): HTMLElement | null {
  const dialog = section?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? null;
  if (dialog === null) return null;
  return dialog.hasAttribute("tabindex")
    ? dialog
    : dialog.querySelector<HTMLElement>(':scope > [tabindex="-1"]');
}

/**
 * Whether the keyboard is nowhere the person put it on purpose: on the page,
 * on the dialog's own surface, or inside the section. A panel or list the
 * person moved to holds it, even one the section sits in.
 */
function keyboardIsFree(section: HTMLElement | null): boolean {
  const focused = document.activeElement;
  if (focused === null || focused === document.body) return true;
  if (section === null) return false;
  return section.contains(focused) || focused === dialogSurface(section);
}

// A radio group's one stop is its selected option; the others are reached by arrow keys.
const FIRST_FIELD = 'input:not(:disabled), button:not(:disabled):not([tabindex="-1"])';

export interface InvolvementPreferenceOptions {
  /** Shown and Decisions is on: nothing is read otherwise. */
  active: boolean;
  /** The opening this belongs to: nothing of an earlier one is shown. */
  opening: number;
  /** Decisions' status revision: a change in the connection reads the preference again. */
  statusRevision: number | null;
  /**
   * Where the keyboard goes once a save settles or the form is put away and Change isn't there to
   * take it: the dialog's surface, where Tab stays in its trap, or the section (`tabIndex={-1}`),
   * which keeps the person's place on a page.
   */
  fallback: "dialog" | "section";
  /** Something around it is changing (Decisions turning on or off): nothing is started or sent. */
  locked?: boolean;
}

export interface InvolvementPreference {
  load: InvolvementLoad;
  read: InvolvementRead | null;
  /** The display clock: the last read, moved on when a temporary mode or a wait ends. */
  now: number;
  reload: () => void;
  /** The change being made, while it can be made here. */
  draft: InvolvementDraft | null;
  /** The draft would save something other than what was reviewed. */
  dirty: boolean;
  /** A change is in flight: the form is locked until it settles. */
  busy: boolean;
  notice: SaveNotice | null;
  /** Why the preference can't be changed here, or null. */
  readOnly: string | null;
  /** After a conflict, waiting to read the revision that won. */
  waiting: boolean;
  canEdit: boolean;
  /** Change, or Set preference, is offered. */
  canStart: boolean;
  startEditing: () => void;
  change: (next: Partial<InvolvementDraft>) => void;
  changeUntil: (until: string) => void;
  cancel: () => void;
  save: () => Promise<void>;
  /** The element holding everything below; with the `section` fallback, focusable (`tabIndex={-1}`). */
  sectionRef: RefObject<HTMLElement | null>;
  changeRef: RefObject<HTMLButtonElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The person's involvement preference (#17237) and a change to it, for every
 * surface that shows it (#18060): what agents' `get_involvement` is told now,
 * and, on the owner computer while connected, a change that replaces the
 * revision the person reviewed, so one made on a phone meanwhile is refused
 * rather than overwritten.
 */
export function useInvolvementPreference({
  active,
  opening,
  statusRevision,
  fallback,
  locked = false,
}: InvolvementPreferenceOptions): InvolvementPreference {
  const sectionRef = useRef<HTMLElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const { load, at, reload } = useInvolvementRead(active, opening, statusRevision);
  const read = load.state === "read" ? load.read : null;
  const preference = read?.preference ?? null;

  // A temporary mode ends without a new revision: the display flips at its
  // end, and reads again. A draft's own end wakes its check the same way.
  const [flippedAt, setFlippedAt] = useState(0);
  const now = Math.max(at, flippedAt);
  // Shown again after a while hidden, the clock moves to now before any read lands: a read that
  // stalls or fails would otherwise keep a temporary mode that ended meanwhile, and time its end
  // from the old clock.
  useEffect(() => {
    if (active) setFlippedAt(Date.now());
  }, [active]);
  const flipIn = preference === null ? null : msUntilChange(preference, now);
  useEffect(() => {
    if (!active || flipIn === null) return;
    return scheduleFlip(flipIn, () => {
      setFlippedAt(Date.now());
      reload();
    });
  }, [active, flipIn, reload]);

  const [editing, setEditing] = useState<Edit | null>(null);
  const edit = editing !== null && editing.opening === opening ? editing : null;
  // What is open when a save settles: only the form it was sent from, still holding the keyboard, hands it on.
  const editingRef = useRef<Edit | null>(null);
  const openingRef = useRef(opening);
  const activeRef = useRef(active);
  useEffect(() => {
    editingRef.current = editing;
    openingRef.current = opening;
    activeRef.current = active;
  });

  // One save at a time in an opening: the form is locked while it is in flight, so its results can't cross.
  const [inFlight, setInFlight] = useState<{ opening: number; sent: Edit } | null>(null);
  const busy = inFlight !== null && inFlight.opening === opening;
  const [notice, setNotice] = useState<{ opening: number; notice: SaveNotice } | null>(null);
  const shownNotice = notice !== null && notice.opening === opening ? notice.notice : null;
  const [refused, setRefused] = useState<number | null>(null);
  const refusedByRelay = refused === opening;
  // After a conflict, a change waits for this computer to read the revision that won, for a while:
  // a newer record it can't verify never arrives, and a change from what it holds is refused again anyway.
  const [behind, setBehind] = useState<{ opening: number; revision: number; at: number } | null>(
    null
  );
  const waiting =
    read !== null &&
    behind !== null &&
    behind.opening === opening &&
    read.preference.revision < behind.revision &&
    now - behind.at < BEHIND_WAIT_MS;
  const [handoff, setHandoff] = useState(0);
  const [opened, setOpened] = useState(0);

  const readOnly = read === null ? null : readOnlyText(read, refusedByRelay);
  const canEdit = read !== null && readOnly === null && !waiting;

  // The wait has its own end, so reads that fail or stall can't hold it open.
  const waitEnds = waiting && behind !== null ? behind.at + BEHIND_WAIT_MS : null;
  useEffect(() => {
    if (waitEnds === null) return;
    return scheduleFlip(waitEnds - Date.now(), () => setFlippedAt(Date.now()));
  }, [waitEnds, now]);

  // A draft's own end wakes its check, counted from that end rather than from the last read, and
  // re-armed whenever the clock moves short of it (a hidden window, a delay past the timer's cap).
  const draftEnd =
    active && canEdit && edit !== null && edit.draft.temporary ? draftUntil(edit.draft) : null;
  useEffect(() => {
    if (draftEnd === null) return;
    const end = Date.parse(draftEnd);
    if (now >= end) return;
    return scheduleFlip(end - Date.now(), () => setFlippedAt(Date.now()));
  }, [draftEnd, now]);

  // Once a save settles or the form is put away, the keyboard goes to Change, else the fallback.
  useEffect(() => {
    if (handoff === 0 || !activeRef.current) return;
    const section = sectionRef.current;
    if (!keyboardIsFree(section)) return;
    (changeRef.current ?? (fallback === "dialog" ? dialogSurface(section) : section))?.focus();
  }, [handoff, fallback]);

  // Change goes as the form opens, so the keyboard it held moves on to the form's first field.
  useEffect(() => {
    if (opened === 0 || !activeRef.current) return;
    if (!keyboardIsFree(sectionRef.current)) return;
    formRef.current?.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
  }, [opened]);

  const startEditing = () => {
    if (read === null || locked) return;
    setNotice(null);
    setOpened((n) => n + 1);
    const draft = draftFrom(read.preference, Date.now());
    setEditing({
      opening,
      revision: read.preference.revision,
      draft,
      initial: draft,
      first: read.preference.status !== "available",
    });
  };

  const change = (next: Partial<InvolvementDraft>) => {
    if (edit === null || busy) return;
    setEditing({ ...edit, draft: { ...edit.draft, ...next } });
  };

  const cancel = () => {
    setEditing(null);
    setHandoff((n) => n + 1);
  };

  const save = async () => {
    if (edit === null || busy || !canEdit || locked) return;
    // Checked again at the moment of saving: an end that has passed since the last read shows now.
    const checkedAt = Date.now();
    if (draftIssue(edit.draft, checkedAt) !== null) {
      setFlippedAt(checkedAt);
      return;
    }
    const sent = edit;
    // Locking the fields drops a field's focus, so the keyboard waits on Save meanwhile.
    if (formRef.current?.contains(document.activeElement)) saveRef.current?.focus();
    setInFlight({ opening: sent.opening, sent });
    // Settled as a value: a call that fails may still have reached the relay before something here failed.
    const result = await decisionsClient
      .setInvolvement(draftPayload(sent.draft, sent.revision))
      .then(
        (value) => value,
        () => null
      );
    const said = result === null ? UNCONFIRMED_NOTICE : saveNotice(result);
    const relayRefusal = said !== null && "relayRefusal" in said && said.relayRefusal;
    if (relayRefusal) setRefused(sent.opening);
    if (result !== null && result.result === "conflict" && result.latestRevision !== null) {
      setBehind({ opening: sent.opening, revision: result.latestRevision, at: Date.now() });
    }
    const holdsKeyboard =
      openingRef.current === sent.opening &&
      (editingRef.current === sent || editingRef.current === null) &&
      keyboardIsFree(sectionRef.current);
    setNotice(said === null ? null : { opening: sent.opening, notice: said });
    setEditing((current) => (current === sent ? null : current));
    setInFlight((current) => (current !== null && current.sent === sent ? null : current));
    if (holdsKeyboard) setHandoff((n) => n + 1);
    reload();
  };

  const draft = edit !== null && canEdit ? edit.draft : null;
  return {
    load,
    read,
    now,
    reload,
    draft,
    dirty: edit !== null && (edit.first || !sameDraft(edit.initial, edit.draft)),
    busy,
    notice: shownNotice,
    readOnly,
    waiting,
    canEdit,
    canStart: canEdit && edit === null && !busy && !locked,
    startEditing,
    change,
    changeUntil: (until) => change({ until, keptUntil: null }),
    cancel,
    save,
    sectionRef,
    changeRef,
    formRef,
    saveRef,
  };
}
