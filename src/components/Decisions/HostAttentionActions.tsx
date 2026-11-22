import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { decisionsClient } from "@/clients/decisionsClient";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsAttentionItem } from "@shared/types/decisionsAttention";
import type {
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";
import {
  RESUME_PENDING,
  STILL_WORKING,
  aliasLabel,
  canCopy,
  copyLabel,
  handledConfirmTitle,
  handledNeedsConfirm,
  leavesList,
  outcomeSeverity,
  outcomeText,
  subjectOf,
} from "./decisionsAttentionModel";
import { referenceKey } from "./decisionsInboxModel";
import {
  hostActionFailureText,
  hostAttentionReadOf,
  hostHandledConfirmBody,
  hostReadFailedText,
  hostUnavailableText,
  hostWaitingText,
  type HostAttentionRead,
} from "./hostAttentionModel";

/** Past this, a resume's wait says it is still going. */
const STILL_WORKING_MS = 5_000;

/** True once `active` has held for `ms`; false again as soon as it ends. */
function useHeldFor(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return held;
}

/**
 * A ref for a control that can go away under the keyboard: when it leaves
 * with focus on it, focus moves to `target` rather than falling to the
 * document, unless it has gone somewhere else already.
 */
function useHandBack(target: () => HTMLElement | null) {
  return useCallback(
    (node: HTMLElement | null) => {
      if (node === null) return;
      return () => {
        if (!node.contains(document.activeElement)) return;
        queueMicrotask(() => {
          const focused = document.activeElement;
          if (focused !== null && focused !== document.body) return;
          target()?.focus();
        });
      };
    },
    [target]
  );
}

type Shown = HostAttentionRead | { kind: "none" } | { kind: "reading" };

interface Outcome {
  message: string;
  severity: "success" | "warning";
}

type Action = "resume" | "handled";

/** One of a Remote Host's stopped deliveries in the inbox, as its Host offers it (#18031). */
export interface HostAttention {
  /** The Host's name, for what is said about it. */
  host: string;
  shown: Shown;
  busy: Action | null;
  /** What the last action on the shown question came to; kept once its callout goes. */
  outcome: Outcome | null;
  /** The item a Mark handled confirmation asks about, while it still asks it. */
  confirming: DecisionsAttentionItem | null;
  copy: () => Promise<string>;
  resume: () => void;
  markHandled: () => void;
  confirmHandled: () => void;
  cancelHandled: () => void;
  retry: () => void;
}

/** A read's key: its question's reference, field by field, then the stall it was read for. */
function readKeyOf(item: DecisionQuestionListItem): string {
  const { hostId, projectId, terminalId, questionId } = item.reference;
  return JSON.stringify([
    hostId,
    projectId,
    terminalId,
    questionId,
    item.standing,
    item.stall,
    item.closureNotice ?? null,
  ]);
}

/** The question a read's key names; null for a key `readKeyOf` didn't make. */
function referenceOfReadKey(readKey: string): DecisionQuestionReference | null {
  const parsed: unknown = JSON.parse(readKey);
  if (!Array.isArray(parsed)) return null;
  const [hostId, projectId, terminalId, questionId]: unknown[] = parsed;
  return typeof hostId === "string" &&
    typeof projectId === "string" &&
    typeof terminalId === "string" &&
    typeof questionId === "string"
    ? { hostId, projectId, terminalId, questionId }
    : null;
}

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * Reads the shown question's stopped delivery on its Remote Host while the
 * inbox is open on it, and again whenever its stall, its link or an action
 * here changes what it might say. Nothing is offered until the Host has
 * answered with what it offers itself; an older Host, or one not
 * connected, gets a note saying what to do instead.
 */
export function useHostAttention(
  selected: DecisionQuestionListItem | null,
  active: boolean
): HostAttention {
  const announce = useAnnouncerStore((state) => state.announce);
  const host = selected?.remoteHost;
  const hostName = host?.name ?? "the Remote Host";
  const stalled =
    selected !== null && host !== undefined && selected.standing.kind === "needs-attention";
  const connected = host?.connected === true;
  const key = selected === null ? null : referenceKey(selected.reference);
  const reference = stalled && connected ? selected.reference : null;
  // What a read depends on: the question, and its stall as listed while its Host is connected.
  const readKey = stalled && connected ? readKeyOf(selected) : null;
  const [epoch, setEpoch] = useState(0);
  const [read, setRead] = useState<{ readKey: string; read: HostAttentionRead } | null>(null);
  /** The action under way on each question, by its key: one per question, never one for all. */
  const [busy, setBusy] = useState<ReadonlyMap<string, Action>>(new Map());
  /** What the last action on each question came to, by its key, for this opening. */
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [confirm, setConfirm] = useState<{ readKey: string; token: string } | null>(null);
  /** The inbox's openings, so an action that settles after a close leaves nothing behind. */
  const opening = useRef({ active, count: 0 });

  useEffect(() => {
    opening.current = { active, count: opening.current.count + (active ? 1 : 0) };
    // What was read goes with the opening: nothing of it stays held while the inbox is closed.
    if (!active) setOutcomes((current) => (current.size === 0 ? current : new Map()));
  }, [active]);

  // Controls and a confirmation hold only for the stall, the link and the opening they were read
  // in: another question, a new stall, a reconnect or a reopening shows nothing until read again.
  useEffect(() => {
    setRead(null);
    setConfirm(null);
  }, [readKey, active]);

  useEffect(() => {
    const asked = readKey === null ? null : referenceOfReadKey(readKey);
    if (!active || readKey === null || asked === null) return;
    let live = true;
    decisionsClient.hostAttention({ action: "read", reference: asked }).then(
      (result) => {
        if (live) setRead({ readKey, read: hostAttentionReadOf(result) });
      },
      () => {
        if (live) setRead({ readKey, read: { kind: "failed" } });
      }
    );
    return () => {
      live = false;
    };
  }, [active, readKey, epoch]);

  // The last read of this very stall stays shown while it is read again after an action or a
  // retry, so the controls never go away under focus for that alone.
  const shown: Shown = !stalled
    ? { kind: "none" }
    : !connected
      ? { kind: "unavailable", reason: "disconnected" }
      : read !== null && read.readKey === readKey
        ? read.read
        : { kind: "reading" };
  const item = shown.kind === "item" ? shown.item : null;
  const busyHere = key === null ? null : (busy.get(key) ?? null);
  const confirming =
    item !== null && confirm !== null && confirm.readKey === readKey && confirm.token === item.token
      ? item
      : null;

  const act = (action: Action, acted: DecisionsAttentionItem) => {
    if (readKey === null || key === null || reference === null || busyHere !== null) return;
    const forKey = key;
    const forReadKey = readKey;
    const forOpening = opening.current.count;
    setBusy((current) => new Map(current).set(forKey, action));
    setOutcomes((current) => without(current, forKey));
    const settle = (next: Outcome, gone: boolean) => {
      setBusy((current) => without(current, forKey));
      // Whatever opening it settles in, what the Host offers may have changed: read it again.
      setEpoch((current) => current + 1);
      // Settled after the inbox closed, or in a later opening: that opening never asked.
      if (!opening.current.active || opening.current.count !== forOpening) return;
      setOutcomes((current) => new Map(current).set(forKey, next));
      // Off the list as acted on: nothing more is offered for it while the Host's list catches up.
      if (gone) {
        setRead((current) =>
          current?.readKey === forReadKey
            ? { readKey: forReadKey, read: { kind: "gone" } }
            : current
        );
      }
      announce(next.message);
    };
    // The token goes with it: the Host refuses once the question asks something else.
    decisionsClient.hostAttention({ action, reference, expected: acted.token }).then(
      (result) => {
        if (result.result === "acted") {
          settle(
            {
              message: outcomeText(acted.alias, result.outcome, subjectOf(acted)),
              severity: outcomeSeverity(result.outcome),
            },
            leavesList(result.outcome)
          );
          return;
        }
        settle(
          { message: hostActionFailureText(result, hostName, acted.alias), severity: "warning" },
          false
        );
      },
      (error: unknown) =>
        settle(
          {
            message: formatErrorMessage(
              error,
              `Couldn't change ${aliasLabel(acted.alias)}'s ${subjectOf(acted)}`
            ),
            severity: "warning",
          },
          false
        )
    );
  };

  return {
    host: hostName,
    shown,
    busy: busyHere,
    outcome: key === null ? null : (outcomes.get(key) ?? null),
    confirming,
    copy: async () => {
      if (reference === null) throw new Error("Nothing to copy");
      const result = await decisionsClient.hostAttention({ action: "copy", reference });
      if (result.result !== "copied" || result.text === null) throw new Error("Nothing to copy");
      return result.text;
    },
    resume: () => {
      if (item !== null) act("resume", item);
    },
    markHandled: () => {
      if (item === null || readKey === null) return;
      if (handledNeedsConfirm(item)) setConfirm({ readKey, token: item.token });
      else act("handled", item);
    },
    confirmHandled: () => {
      if (confirming === null) return;
      setConfirm(null);
      act("handled", confirming);
    },
    cancelHandled: () => setConfirm(null),
    retry: () => setEpoch((current) => current + 1),
  };
}

interface HostAttentionActionsProps {
  attention: HostAttention;
  /** Where the keyboard goes when the controls it is on go away under it. */
  fallbackFocus: RefObject<HTMLElement | null>;
}

/**
 * What the Host offers for its stopped delivery, in the inbox's callout:
 * Try resume while the Host would resume it, Copy, and Mark handled, with
 * the confirmation the attention list asks while handling it takes another
 * way of delivering it away. Choose destination is the Host's own: its
 * panes are there.
 */
export function HostAttentionActions({ attention, fallbackFocus }: HostAttentionActionsProps) {
  const { shown, busy, confirming, host } = attention;
  const handledRef = useRef<HTMLButtonElement>(null);
  const toPane = useCallback(() => fallbackFocus.current, [fallbackFocus]);
  const toHandled = useCallback(() => handledRef.current ?? fallbackFocus.current, [fallbackFocus]);
  // A resolved delivery takes its controls with it; a resume no longer offered takes its button.
  const handBackToPane = useHandBack(toPane);
  const handBackToHandled = useHandBack(toHandled);
  const item = shown.kind === "item" ? shown.item : null;
  if (item === null) return null;
  const alias = aliasLabel(item.alias);
  const locked = busy !== null;
  return (
    <div ref={handBackToPane} className="flex flex-wrap items-center gap-1.5">
      {item.canResume && (
        <Button
          ref={handBackToHandled}
          variant="outline"
          size="xs"
          aria-label={`Try resume for ${alias}`}
          aria-busy={busy === "resume" || undefined}
          aria-disabled={busy === "resume" || undefined}
          disabled={locked && busy !== "resume"}
          onClick={busy === "resume" ? undefined : attention.resume}
          data-testid="decisions-host-resume"
        >
          <SpinningIcon icon={RotateCw} active={busy === "resume"} aria-hidden="true" />
          Try resume
        </Button>
      )}
      {canCopy(item) && (
        <CopyButton
          label={copyLabel(item)}
          aria-label={`${copyLabel(item)} to ${alias}`}
          variant={item.canResume ? "ghost" : "outline"}
          size="xs"
          disabled={locked}
          text={attention.copy}
          data-testid="decisions-host-copy"
        />
      )}
      <Button
        ref={handledRef}
        variant="ghost"
        size="xs"
        aria-label={`Mark ${alias} handled`}
        loading={busy === "handled"}
        disabled={locked && busy !== "handled"}
        onClick={attention.markHandled}
        data-testid="decisions-host-handled"
      >
        Mark handled
      </Button>
      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={attention.cancelHandled}
        zIndex="nested"
        variant="destructive"
        title={confirming === null ? "" : handledConfirmTitle(confirming.alias)}
        description={
          <span className="[text-wrap:pretty]">
            {confirming === null
              ? ""
              : hostHandledConfirmBody(subjectOf(confirming), host, {
                  copy: canCopy(confirming),
                  resume: confirming.canResume,
                  reassign: confirming.canReassign,
                })}
          </span>
        }
        // A cancel returns to the button that asked, or to the pane once it has gone.
        restoreFocusTo={toHandled}
        confirmLabel="Mark handled"
        onConfirm={attention.confirmHandled}
      >
        {confirming !== null && (
          <p className="text-xs text-text-secondary [text-wrap:pretty]">
            {hostWaitingText(confirming, host)}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

interface HostAttentionStatusProps {
  attention: HostAttention;
  /** Where the keyboard goes when Retry goes away under it. */
  fallbackFocus: RefObject<HTMLElement | null>;
}

/**
 * What the inbox says of a Host's stopped delivery beside its controls,
 * below the callout so it outlasts it: what the controls act on, as the
 * Host read it with them; what to do when it can't be resolved from here;
 * a read that failed; a resume under way; and what the last action came to.
 */
export function HostAttentionStatus({ attention, fallbackFocus }: HostAttentionStatusProps) {
  const { shown, busy, outcome, host } = attention;
  const resuming = busy === "resume";
  const stillWorking = useHeldFor(resuming, STILL_WORKING_MS);
  const toPane = useCallback(() => fallbackFocus.current, [fallbackFocus]);
  const handBack = useHandBack(toPane);
  const note = shown.kind === "unavailable" ? hostUnavailableText(shown.reason, host) : null;
  return (
    <>
      {/* From the same read as the controls' token, so what is acted on is what is shown,
          whatever the question's thread below has caught up with. */}
      {shown.kind === "item" && (
        <p
          className="text-xs text-text-secondary [text-wrap:pretty]"
          data-testid="decisions-host-attention-waiting"
        >
          {hostWaitingText(shown.item, host)}
        </p>
      )}
      {/* An action the Host refused for the same reason the reread then found already says it. */}
      {note !== null && note !== outcome?.message && (
        <p
          className="text-xs text-text-secondary [text-wrap:pretty]"
          data-testid="decisions-host-attention-note"
        >
          {note}
        </p>
      )}
      {shown.kind === "failed" && (
        <p
          className="flex flex-wrap items-center gap-2 text-xs text-text-secondary [text-wrap:pretty]"
          data-testid="decisions-host-attention-failed"
        >
          {hostReadFailedText(host)}
          <Button ref={handBack} variant="outline" size="xs" onClick={attention.retry}>
            Retry
          </Button>
        </p>
      )}
      {resuming && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">
          {stillWorking ? `${RESUME_PENDING} ${STILL_WORKING}` : RESUME_PENDING}
        </p>
      )}
      {/* Announced when it lands; shown as the attention list shows what an action did. */}
      {outcome !== null && (
        <Callout
          severity={outcome.severity}
          size="compact"
          data-testid="decisions-host-attention-outcome"
        >
          {outcome.message}
        </Callout>
      )}
    </>
  );
}
