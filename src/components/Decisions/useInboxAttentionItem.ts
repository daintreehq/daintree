import { useCallback, useEffect, useRef, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsAttentionItem } from "@shared/types/decisionsAttention";
import type { DecisionQuestionListItem } from "@shared/types/decisionsQuestion";
import { attentionFingerprint } from "./decisionsAttentionModel";

/** Pushes for panes arrive in bursts; one read after they settle. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * - `idle`: the question shown isn't a stall this computer resolves.
 * - `loading`: its first read is out.
 * - `found`: its item, as main read it.
 * - `missing`: main lists no item for it, though the question list says it stalled.
 * - `not-running`: Decisions isn't delivering answers on this computer.
 * - `failed`: the read itself failed.
 */
export type InboxAttentionRead =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "found"; item: DecisionsAttentionItem }
  | { state: "missing" }
  | { state: "not-running" }
  | { state: "failed"; message: string };

const IDLE: InboxAttentionRead = { state: "idle" };
const LOADING: InboxAttentionRead = { state: "loading" };

/** Whether the inbox resolves this question's delivery in place: a stall on this computer. */
export function resolvesHere(
  item: DecisionQuestionListItem | null
): item is DecisionQuestionListItem {
  return item !== null && item.standing.kind === "needs-attention" && item.remoteHost === undefined;
}

/**
 * The needs-attention item of the question the inbox shows (#18027), read
 * from this computer's list while it is shown and stalled: once each time it
 * is shown, again whenever what the question list says of its stall changes,
 * and once a burst of pane changes settles, since those decide whether it can
 * still be resumed or sent on. A read for a question no longer shown is
 * dropped, and so is one that lands after a later one did. `stale` while the
 * item shown wasn't read in this showing of the question, or was read before
 * its stall last changed. A Remote Host's stall is that Host's to resolve.
 * `release` lets go of what was read, at the close.
 */
export function useInboxAttentionItem(
  selected: DecisionQuestionListItem | null,
  active: boolean,
  opening: number
): {
  read: InboxAttentionRead;
  stale: boolean;
  refresh: () => Promise<void>;
  release: () => void;
} {
  const eligible = active && resolvesHere(selected);
  const questionId = eligible ? selected.reference.questionId : null;
  const fingerprint = eligible ? attentionFingerprint([selected]) : null;
  // Each showing of a question, in each opening, is one visit: what an earlier one read
  // (canResume and canReassign can change without the stall changing) never acts here.
  const visitKey = questionId === null ? null : `${opening}\u0000${questionId}`;
  const [visit, setVisit] = useState<{ key: string | null; n: number }>({ key: null, n: 0 });
  if (visit.key !== visitKey) setVisit({ key: visitKey, n: visit.n + 1 });
  const visitN = visit.key === visitKey ? visit.n : visit.n + 1;
  const [read, setRead] = useState<{
    questionId: string;
    visit: number;
    fingerprint: string;
    read: InboxAttentionRead;
  } | null>(null);
  const launched = useRef(0);
  const applied = useRef(0);
  // The question reads are for now, so a refresh after an action reads for the one still shown.
  const shown = useRef<{ questionId: string; visit: number; fingerprint: string } | null>(null);
  useEffect(() => {
    shown.current =
      questionId === null || fingerprint === null
        ? null
        : { questionId, visit: visitN, fingerprint };
  }, [questionId, visitN, fingerprint]);

  const load = useCallback(async (id: string, inVisit: number, asOf: string) => {
    const ticket = ++launched.current;
    let next: InboxAttentionRead;
    try {
      const list = await decisionsClient.listAttention();
      if (list.result !== "listed") next = { state: "not-running" };
      else {
        const item = list.items.find((candidate) => candidate.questionId === id);
        next = item === undefined ? { state: "missing" } : { state: "found", item };
      }
    } catch (error) {
      next = { state: "failed", message: formatErrorMessage(error, "Couldn't read the answers") };
    }
    // Later reads never wait on earlier ones, so pane changes that keep coming can't
    // keep every read from landing; only an older answer than one shown is dropped.
    if (ticket < applied.current || shown.current?.questionId !== id) return;
    applied.current = ticket;
    setRead({ questionId: id, visit: inVisit, fingerprint: asOf, read: next });
  }, []);

  const refresh = useCallback(async () => {
    const now = shown.current;
    if (now !== null) await load(now.questionId, now.visit, now.fingerprint);
  }, [load]);

  useEffect(() => {
    if (questionId === null || fingerprint === null) return;
    void load(questionId, visitN, fingerprint);
  }, [questionId, visitN, fingerprint, load]);

  useEffect(() => {
    // A Remote Host window hears its Host's panes, which don't decide this computer's stalls.
    if (questionId === null || isRemoteWindow()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | null = null;
    try {
      off = decisionsClient.onPaneState(() => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
      });
    } catch {
      // A bridge without the event leaves the question list's own changes.
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
      off?.();
    };
  }, [questionId, refresh]);

  const release = useCallback(() => setRead(null), []);

  if (questionId === null) return { read: IDLE, stale: false, refresh, release };
  const current = read !== null && read.questionId === questionId ? read : null;
  return {
    read: current === null ? LOADING : current.read,
    stale: current !== null && (current.visit !== visitN || current.fingerprint !== fingerprint),
    refresh,
    release,
  };
}
