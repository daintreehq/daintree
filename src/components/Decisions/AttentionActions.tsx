import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { decisionsClient } from "@/clients/decisionsClient";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { WorktreeSnapshot } from "@shared/types";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerDestinations,
  DecisionsAttentionItem,
} from "@shared/types/decisionsAttention";
import {
  RESUME_PENDING,
  STILL_WORKING,
  agentLabel,
  aliasLabel,
  canCopy,
  copyLabel,
  destinationGroups,
  destinationRowDetail,
  fromLines,
  handledConfirmBody,
  handledConfirmTitle,
  moveConfirmBody,
  paneName,
  subjectOf,
  toLines,
  type PaneLines,
} from "./decisionsAttentionModel";
import type { AttentionActions, AttentionBusy } from "./useAttentionActions";

/** A question's actions, so focus can land on the next one when its item leaves. */
export const ATTENTION_ACTIONS = "[data-attention-action]";

/** Past this, a resume's wait says it is still going. */
const STILL_WORKING_MS = 5_000;

export type WorktreeName = (id: string, fallback: string | null) => string | null;

const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

/**
 * The project's own names for its worktrees, where the actions show in a
 * project view. The Canopy window holds no project: there each answer keeps
 * the name it was asked under.
 */
export function useWorktreeNames(): WorktreeName {
  const worktreeMap = useWorktreeStoreOptional((state) => state.worktrees, NO_WORKTREES);
  return useCallback(
    (id: string, fallback: string | null) => {
      const known = worktreeMap.get(id);
      return worktreeDisplayName(known) ?? fallback;
    },
    [worktreeMap]
  );
}

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

/** What a resume does while it runs, and that it is still going once it runs long. */
export function ResumePending({ alias, active }: { alias: number; active: boolean }) {
  const label = aliasLabel(alias);
  const stillWorking = useHeldFor(active, STILL_WORKING_MS);
  const announce = useAnnouncerStore((state) => state.announce);
  // The wait's reassurance reaches a screen reader too, once, outside the busy item.
  useEffect(() => {
    if (stillWorking) announce(`${label}: ${STILL_WORKING}`);
  }, [stillWorking, label, announce]);
  if (!active) return null;
  return (
    <p className="text-xs text-text-secondary [text-wrap:pretty]">
      {stillWorking ? `${RESUME_PENDING} ${STILL_WORKING}` : RESUME_PENDING}
    </p>
  );
}

interface AttentionActionRowProps {
  item: DecisionsAttentionItem;
  worktreeName: WorktreeName;
  busy: AttentionBusy | null;
  onResume: () => void;
  onChoose: (destination: DecisionsAnswerDestination) => void;
  onHandled: () => void;
  /**
   * The item may no longer be what main holds, while it is read again: the
   * actions keep their place and the keyboard, but don't act on what was read.
   */
  held?: boolean;
  className?: string;
}

/**
 * Whichever of Try resume, Choose destination, Copy and Mark handled apply to
 * a stalled answer, as main read it: Try resume and Choose destination only
 * while they could deliver it, Copy only while everything it holds can be copied.
 */
export function AttentionActionRow({
  item,
  worktreeName,
  busy,
  onResume,
  onChoose,
  onHandled,
  held = false,
  className,
}: AttentionActionRowProps) {
  const alias = aliasLabel(item.alias);
  const groupIdBase = useId();
  const [destinations, setDestinations] = useState<DecisionsAnswerDestinations | null>(null);
  const [destinationsError, setDestinationsError] = useState<string | null>(null);
  const locked = busy !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The token of the reading of the stall the listed agents go with; null
   * until the open menu has listed any. Agents listed for one reading never
   * pair with another (#18027).
   */
  const [listedFor, setListedFor] = useState<string | null>(null);
  const listedNow = !held && listedFor === item.token;
  // A menu whose trigger went with Choose destination is closed: it never comes back open.
  if (menuOpen && !item.canReassign) {
    setMenuOpen(false);
    setListedFor(null);
  }

  // Every listing and every closing starts a new generation, so a lookup from a listing already
  // replaced can't overwrite the agents (or the error) of the menu showing now.
  const destinationsGenerationRef = useRef(0);
  // An open menu lists the agents as it opens, and again for the reading the stall has once it
  // changes under it; while the stall is being read again, it lists none.
  useEffect(() => {
    if (!menuOpen || !item.canReassign || held || listedFor === item.token) return;
    const generation = ++destinationsGenerationRef.current;
    setListedFor(item.token);
    setDestinations(null);
    setDestinationsError(null);
    decisionsClient.listAnswerDestinations(item.questionId).then(
      (listed) => {
        if (generation === destinationsGenerationRef.current) setDestinations(listed);
      },
      (error) => {
        if (generation !== destinationsGenerationRef.current) return;
        setDestinationsError(formatErrorMessage(error, "Couldn't list the running agents"));
      }
    );
  }, [menuOpen, held, listedFor, item.canReassign, item.token, item.questionId]);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {item.canResume && (
        <Button
          variant="outline"
          size="xs"
          aria-label={`Try resume for ${alias}`}
          aria-busy={busy === "resume" || undefined}
          aria-disabled={busy === "resume" || held || undefined}
          data-attention-action=""
          disabled={locked && busy !== "resume"}
          // Busy keeps its focus and its width: the glyph turns while it runs.
          onClick={busy === "resume" || held ? undefined : onResume}
        >
          {/* Resuming restarts the session that asked: the restart glyph, turning while it runs. */}
          <SpinningIcon icon={RotateCw} active={busy === "resume"} aria-hidden="true" />
          Try resume
        </Button>
      )}
      {item.canReassign && (
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            if (open && held) return;
            setMenuOpen(open);
            // Each opening lists afresh; a closing keeps its rows through the exit.
            if (open) setListedFor(null);
            else destinationsGenerationRef.current += 1;
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant={item.canResume ? "ghost" : "outline"}
              size="xs"
              aria-label={`Choose destination for ${alias}`}
              aria-disabled={held || undefined}
              className="data-[state=open]:bg-overlay-soft"
              data-attention-action=""
              loading={busy === "reassign"}
              disabled={locked && busy !== "reassign"}
            >
              Choose destination
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            {(!listedNow || (destinations === null && destinationsError === null)) && (
              <DropdownMenuItem disabled>Looking…</DropdownMenuItem>
            )}
            {listedNow && destinationsError !== null && (
              <DropdownMenuItem disabled>{destinationsError}</DropdownMenuItem>
            )}
            {listedNow && destinations !== null && destinations.result !== "listed" && (
              <DropdownMenuItem disabled>
                {destinations.result === "not-running"
                  ? "Decisions isn't running"
                  : "This answer can't be moved now"}
              </DropdownMenuItem>
            )}
            {listedNow &&
              destinations?.result === "listed" &&
              destinations.destinations.length === 0 && (
                <DropdownMenuItem disabled>No agents are running here</DropdownMenuItem>
              )}
            {listedNow &&
              destinations?.result === "listed" &&
              destinationGroups(destinations.destinations, item.origin.projectId).map(
                (group, index) => (
                  <DropdownMenuGroup
                    key={group.projectId}
                    aria-labelledby={`${groupIdBase}-${index}`}
                  >
                    {index > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel id={`${groupIdBase}-${index}`}>
                      {group.label}
                    </DropdownMenuLabel>
                    {group.destinations.map((destination) => (
                      <DropdownMenuItem
                        key={destination.terminalId}
                        focusHandoff
                        onSelect={() => {
                          if (listedNow) onChoose(destination);
                        }}
                        className="flex-col items-start gap-0.5"
                      >
                        <span className="flex w-full items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-text-primary">
                            {destination.title}
                          </span>
                          {destination.askedHere && (
                            <span className="shrink-0 text-2xs text-text-secondary">
                              asked here
                            </span>
                          )}
                        </span>
                        <span className="w-full truncate text-2xs text-text-secondary">
                          {destinationRowDetail(
                            destination,
                            worktreeName(destination.worktreeId, destination.worktreeName)
                          )}
                          {/* The section label shows the project; a row heard alone still names it. */}
                          {destination.projectName !== null && (
                            <span className="sr-only">{` · ${destination.projectName}`}</span>
                          )}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                )
              )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canCopy(item) && (
        <CopyButton
          label={copyLabel(item)}
          aria-label={`${copyLabel(item)} to ${alias}`}
          variant={item.canResume || item.canReassign ? "ghost" : "outline"}
          size="xs"
          data-attention-action=""
          disabled={locked}
          aria-disabled={held || undefined}
          // Main copies what it holds now, which may be more than the label read names.
          onClick={(event) => {
            if (held) event.preventDefault();
          }}
          text={() => decisionsClient.copyAnswer(item.questionId)}
        />
      )}
      {/* Pulled out by its own padding, so its words end on the column's edge. */}
      <Button
        variant="ghost"
        size="xs"
        className="-mr-2.5 ml-auto"
        aria-label={`Mark ${alias} handled`}
        aria-disabled={held || undefined}
        data-attention-action=""
        loading={busy === "handled"}
        disabled={locked && busy !== "handled"}
        onClick={held ? undefined : onHandled}
      >
        Mark handled
      </Button>
    </div>
  );
}

/** A pane in the move confirmation: what it's called, then its agent and place. */
function PaneLinesValue({ lines }: { lines: PaneLines }) {
  return (
    <dd className="flex min-w-0 flex-col">
      <span className="text-text-primary [text-wrap:pretty]">{lines.primary}</span>
      <span className="text-text-secondary [text-wrap:pretty]">{lines.detail}</span>
    </dd>
  );
}

/**
 * What the action sends on or sets aside, as the item it acts on was read: the
 * answer and each follow-up beside it, whole, since the confirmation is where
 * they are checked. A notice is never sent to another agent.
 */
function SubjectRows({ item }: { item: DecisionsAttentionItem }) {
  const { answer } = item;
  return (
    <>
      {answer !== null && (
        <>
          <dt className="text-text-secondary">Answer</dt>
          <dd className="flex min-w-0 flex-col">
            {answer.choices.length > 0 && (
              <span className="font-medium text-text-primary [overflow-wrap:anywhere] [text-wrap:pretty]">
                {answer.choices.join(", ")}
              </span>
            )}
            {answer.text !== null && (
              <span className="whitespace-pre-wrap text-text-primary [overflow-wrap:anywhere] [text-wrap:pretty]">
                {answer.text}
              </span>
            )}
          </dd>
        </>
      )}
      {item.followUps.map((followUp) => (
        <Fragment key={followUp.messageId}>
          <dt className="text-text-secondary">Follow-up</dt>
          <dd
            className={
              followUp.text !== null
                ? "min-w-0 whitespace-pre-wrap text-text-primary [overflow-wrap:anywhere] [text-wrap:pretty]"
                : "min-w-0 text-text-secondary [text-wrap:pretty]"
            }
          >
            {followUp.text ??
              (followUp.unreadable ? "Couldn't be opened on this computer" : "No words to type in")}
          </dd>
        </Fragment>
      ))}
    </>
  );
}

interface AttentionConfirmationsProps {
  actions: AttentionActions;
  worktreeName: WorktreeName;
  /**
   * Where a confirmation's close lands once the control that opened it has
   * gone: a fast action may already have taken its row away.
   */
  restoreFocusTo: () => HTMLElement | null;
  /**
   * False while the surface under them is closing: a confirmation it takes
   * with it leaves focus to that surface's own close.
   */
  restoreFocusOnClose?: boolean;
  /**
   * Name the answer and follow-ups each confirmation acts on, where nothing
   * beside the actions shows them from the same read.
   */
  showSubject?: boolean;
}

/**
 * The two questions an action asks before it goes: sending the answer to
 * another pane, naming both, and marking handled one that could still be
 * resumed or sent on.
 */
export function AttentionConfirmations({
  actions,
  worktreeName,
  restoreFocusTo,
  restoreFocusOnClose = true,
  showSubject = false,
}: AttentionConfirmationsProps) {
  const { move, handling } = actions;
  return (
    <>
      <ConfirmDialog
        isOpen={move !== null}
        onClose={actions.cancelMove}
        zIndex="nested"
        variant="default"
        title={
          move === null
            ? ""
            : `Send ${aliasLabel(move.item.alias)}'s ${subjectOf(move.item)} to ${paneName(
                move.destination.title,
                agentLabel(move.destination)
              )}?`
        }
        description={
          <span className="[text-wrap:pretty]">
            {move === null ? "" : moveConfirmBody(subjectOf(move.item), move.destination.waitsFor)}
          </span>
        }
        restoreFocusTo={restoreFocusTo}
        restoreFocusOnClose={restoreFocusOnClose}
        confirmLabel={move === null ? "Send answer" : `Send ${subjectOf(move.item)}`}
        onConfirm={actions.confirmMove}
      >
        {move !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
            {move.item.question !== null && (
              <>
                <dt className="text-text-secondary">Question</dt>
                <dd className="text-text-primary [text-wrap:pretty]">{move.item.question}</dd>
              </>
            )}
            {showSubject && <SubjectRows item={move.item} />}
            <dt className="text-text-secondary">From</dt>
            <PaneLinesValue
              lines={fromLines(
                move.item,
                worktreeName(move.item.origin.worktreeId, move.item.origin.worktreeName)
              )}
            />
            <dt className="text-text-secondary">To</dt>
            <PaneLinesValue
              lines={toLines(
                move.destination,
                worktreeName(move.destination.worktreeId, move.destination.worktreeName)
              )}
            />
          </dl>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={handling !== null}
        onClose={actions.cancelHandling}
        zIndex="nested"
        variant="destructive"
        title={handling === null ? "" : handledConfirmTitle(handling.alias)}
        description={
          <span className="[text-wrap:pretty]">
            {handledConfirmBody(handling === null ? "answer" : subjectOf(handling))}
          </span>
        }
        restoreFocusTo={restoreFocusTo}
        restoreFocusOnClose={restoreFocusOnClose}
        confirmLabel="Mark handled"
        onConfirm={actions.confirmHandled}
      >
        {handling !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
            {handling.question !== null && (
              <>
                <dt className="text-text-secondary">Question</dt>
                <dd className="text-text-primary [text-wrap:pretty]">{handling.question}</dd>
              </>
            )}
            {showSubject && <SubjectRows item={handling} />}
            <dt className="text-text-secondary">From</dt>
            <PaneLinesValue
              lines={fromLines(
                handling,
                worktreeName(handling.origin.worktreeId, handling.origin.worktreeName)
              )}
            />
          </dl>
        )}
      </ConfirmDialog>
    </>
  );
}
