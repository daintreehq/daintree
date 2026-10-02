import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Check, CornerDownLeft, KeyRound, Reply, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { Button } from "@/components/ui/button";
import { KBD_BARE_CLASS } from "@/components/ui/Kbd";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import type { TriageCategory } from "@shared/types/ipc/triage";
import { triageDraftKey, triagePromptKey, useTriageStore } from "@/store/triageStore";
import type { TriageItem } from "./triageModel";

const KIND_LABEL: Record<TriageCategory, string> = {
  approval: "Wants approval",
  question: "Asking you",
  error: "Stopped on an error",
  finished: "Finished",
  working: "Working",
  running: "Running",
  idle: "Idle",
};

export interface TriageCardHandlers {
  onOpen: (item: TriageItem) => void;
  onChoose: (item: TriageItem, label: string) => Promise<void>;
  onReply: (item: TriageItem, text: string) => Promise<void>;
  onTrash: (item: TriageItem) => void;
}

interface TriageCardProps extends TriageCardHandlers {
  item: TriageItem;
  domId: string;
  isFocused: boolean;
  /** Position in the card's section, for the feed's article semantics. */
  position: number;
  setSize: number;
  onFocusCard: () => void;
  /** The pointer moved over the card: it becomes the list's one cursor. */
  onPointerCursor: (element: HTMLElement) => void;
}

/**
 * An inline reply is offered only on a card main has classified: before that,
 * nothing says the prompt isn't asking for a secret. Never on an approval,
 * where typed text lands on the menu rather than in a message.
 */
export function canReplyTo(item: TriageItem): boolean {
  return (
    item.card !== null &&
    !item.stale &&
    (item.kind === "question" || item.kind === "finished") &&
    !item.card.secretPrompt
  );
}

/** Trash is offered where the run is done with or stuck: never on one at work. */
export function canTrashItem(item: TriageItem): boolean {
  return item.kind === "finished" || item.kind === "error" || item.kind === "idle";
}

/** A question's reply box is its answer, so it is always out; a follow-up is asked for. */
export function composerAlwaysOpen(item: TriageItem): boolean {
  return item.kind === "question";
}

export function triageCardDomId(runId: string): string {
  return `triage-card-${runId}`;
}

function WorkspaceTile({ workspace }: { workspace: TriageItem["workspace"] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-4xs shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))]"
      style={{
        background: workspace.color
          ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(workspace.color)}`
          : "var(--color-surface-sidebar)",
      }}
    >
      {workspace.emoji ? <span className="leading-none select-none">{workspace.emoji}</span> : null}
    </span>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          // The row's keys reach these; Tab stays on the controls that answer.
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Identity line shared by every row: state, agent, title, where, then the
 * row's actions and its age. The age is the last thing on the line on every
 * row, whatever actions it has, so the ages stand in one column.
 */
function CardIdentity({
  item,
  strong,
  actions,
  showActions,
}: {
  item: TriageItem;
  strong: boolean;
  actions: React.ReactNode;
  showActions: boolean;
}) {
  const { row } = item;
  const where = `${item.workspace.name}${row.worktreeLabel ? ` · ${row.worktreeLabel}` : ""}`;
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {/* Daintree's own observation, never the classifier's reading. */}
        <PilotRunState band={row.band} agentState={row.run.agentState} />
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <TerminalIcon
          chrome={row.chrome}
          className="h-4 w-4"
          brandColor={row.presetColor ?? row.chrome.color}
        />
      </span>
      <span
        title={row.title}
        className={cn(
          "min-w-0 shrink truncate text-sm leading-tight text-text-primary",
          strong && "font-medium"
        )}
      >
        {row.title}
      </span>
      <span
        title={where}
        className="flex min-w-0 shrink-[2] items-center gap-1.5 text-xs text-text-secondary"
      >
        <WorkspaceTile workspace={item.workspace} />
        <span className="truncate">{where}</span>
      </span>
      <span className="flex-1" />
      <span
        className={cn("flex shrink-0 items-center gap-0.5", !showActions && "invisible")}
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
      </span>
      <span
        aria-hidden="true"
        className="w-12 shrink-0 text-right text-2xs leading-none text-text-secondary tabular-nums"
      >
        {row.age ?? ""}
      </span>
    </div>
  );
}

/**
 * What the card says beyond its prompt. When the prompt is on screen it is the
 * ask, quoted, and the reading only adds the why; without one the reading's
 * headline carries the card.
 */
function CardWords({ item, hasQuote }: { item: TriageItem; hasQuote: boolean }) {
  const headline = hasQuote ? null : (item.card?.headline ?? null);
  const summary = item.card?.summary ?? null;
  if (headline === null && summary === null) {
    if (!item.pending || hasQuote) return null;
    return (
      <div className="flex flex-col gap-1.5 py-0.5" aria-hidden="true">
        <SkeletonBone className="h-3.5 w-2/5 rounded-[var(--radius-sm)]" heightPx={14} />
        <SkeletonBone className="h-3 w-3/5 rounded-[var(--radius-sm)]" heightPx={12} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {headline !== null && <p className="text-sm leading-snug text-text-primary">{headline}</p>}
      {summary !== null && (
        <p title={summary} className="line-clamp-2 text-xs leading-relaxed text-text-secondary">
          {summary}
        </p>
      )}
    </div>
  );
}

/** The prompt being asked, quoted as it appears on screen. */
function QuestionQuote({ question, id }: { question: string; id: string }) {
  return (
    <blockquote
      id={id}
      className="rounded-[var(--radius-sm)] border-l-2 border-state-waiting bg-surface-inset px-2.5 py-1.5 text-sm leading-snug text-text-primary"
    >
      {question}
    </blockquote>
  );
}

function Composer({
  item,
  placeholder,
  onReply,
  composerRef,
  tabbable,
  collapsible,
  onEscape,
  onSent,
}: {
  item: TriageItem;
  placeholder: string;
  onReply: TriageCardHandlers["onReply"];
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  tabbable: boolean;
  collapsible: boolean;
  onEscape: () => void;
  onSent: (text: string) => void;
}) {
  const draftKey = triageDraftKey(item.runId, item.card?.spawnedAt ?? item.row.run.spawnedAt);
  const text = useTriageStore((state) => state.drafts[draftKey] ?? "");
  const setDraft = useTriageStore((state) => state.setDraft);
  const setText = useCallback((next: string) => setDraft(draftKey, next), [setDraft, draftKey]);
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    const message = text.trim();
    if (message === "" || sending) return;
    setSending(true);
    try {
      await onReply(item, message);
      setText("");
      onSent(message);
    } catch {
      // Already reported by the handler; the draft stays for another try.
    } finally {
      setSending(false);
    }
  }, [item, onReply, onSent, sending, text, setText]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME's own Escape cancels the composition, not the draft.
    if (event.nativeEvent.isComposing) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      // Escape clears a draft first, then folds a follow-up box away; only an
      // empty box that is always out lets it through to close the dialog.
      if (text === "" && !collapsible) return;
      event.stopPropagation();
      event.preventDefault();
      if (text !== "") setText("");
      else onEscape();
      return;
    }
    // The card's and the list's keys must not fire while typing.
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex items-end gap-1.5" onClick={(event) => event.stopPropagation()}>
      <Textarea
        ref={composerRef}
        rows={1}
        density="compact"
        resize="none"
        value={text}
        // Read-only rather than disabled while sending, so focus stays put.
        readOnly={sending}
        aria-busy={sending || undefined}
        tabIndex={tabbable ? 0 : -1}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={`Message ${item.row.title}`}
        data-triage-composer=""
        className="field-sizing-content max-h-32 min-h-8"
      />
      <Button
        variant="subtle"
        size="icon"
        aria-label="Send"
        tabIndex={-1}
        disabled={text.trim() === ""}
        loading={sending}
        onClick={() => void send()}
      >
        <CornerDownLeft />
      </Button>
    </div>
  );
}

function OptionButtons({
  options,
  answered,
  tabbable,
  onPick,
}: {
  options: readonly string[];
  answered: { label: string; sent: boolean } | null;
  tabbable: boolean;
  onPick: (label: string) => void;
}) {
  if (answered?.sent) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Check className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Answered <span className="text-text-primary">{answered.label}</span>
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer">
      {options.map((label, index) => (
        <Button
          key={label}
          variant="subtle"
          size="sm"
          tabIndex={tabbable ? 0 : -1}
          disabled={answered !== null && answered.label !== label}
          loading={answered?.label === label}
          aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onPick(label);
          }}
          // A permission's scope is often in its last words, so a long label
          // wraps under its digit rather than truncating them away.
          className="h-auto min-h-7 max-w-full items-start justify-start py-1.5 text-left whitespace-normal"
        >
          {index < 9 && (
            <kbd aria-hidden="true" className={cn(KBD_BARE_CLASS, "shrink-0 leading-4")}>
              {index + 1}
            </kbd>
          )}
          <span className="min-w-0 leading-4">{label}</span>
        </Button>
      ))}
    </div>
  );
}

/**
 * One run, drawn for what it needs. Runs blocked on the user get their prompt
 * and its controls; the rest a single line, because a working agent's whole
 * story is "still going" and the newest line on its screen. Every row is the
 * same object in the same list: one cursor, one fill, no card frames.
 */
export function TriageCard({
  item,
  domId,
  isFocused,
  position,
  setSize,
  onFocusCard,
  onPointerCursor,
  onOpen,
  onChoose,
  onReply,
  onTrash,
}: TriageCardProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const card = item.card;
  const options = item.kind === "approval" ? (card?.options ?? []) : [];
  const question =
    item.kind === "approval" || item.kind === "question" ? (card?.question ?? null) : null;
  const canReply = canReplyTo(item);
  const canTrash = canTrashItem(item);
  const quoteId = `${domId}-prompt`;

  // One answer per prompt, from a click or a digit alike. Keyed on the prompt,
  // so the next menu — even one with the same labels — starts answerable.
  const promptKey = card === null ? "" : triagePromptKey(card);
  const ack = useTriageStore((state) => state.acks[item.runId]);
  const setAck = useTriageStore((state) => state.setAck);
  const answered =
    ack !== undefined && ack.kind === "answer" && ack.promptKey === promptKey
      ? { label: ack.text, sent: ack.sent }
      : null;
  const sentHere =
    ack !== undefined && ack.kind === "reply" && ack.promptKey === promptKey ? ack.text : null;
  const pick = (label: string) => {
    if (answered) return;
    const key = promptKey;
    const runId = item.runId;
    setAck(runId, () => ({ promptKey: key, kind: "answer", text: label, sent: false }));
    onChoose(item, label).then(
      () =>
        setAck(runId, (current) =>
          current?.promptKey === key && current.text === label ? { ...current, sent: true } : current
        ),
      // A failure frees only its own prompt, never a newer one answered since.
      () => setAck(runId, (current) => (current?.promptKey === key ? undefined : current))
    );
  };

  const [composerOpened, setComposerOpened] = useState(false);
  const composerOpen = canReply && (composerAlwaysOpen(item) || composerOpened);
  const openComposer = () => {
    setComposerOpened(true);
    // The box mounts this render; focus it once it is there.
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const fromCard = event.target === event.currentTarget;
    const typing = event.target instanceof Element && event.target.closest("textarea, input");
    if (typing) return;
    if (event.key === "Enter" && fromCard) {
      event.preventDefault();
      onOpen(item);
      return;
    }
    if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const label = options[Number(event.key) - 1];
      if (label !== undefined) {
        event.preventDefault();
        // A held key auto-repeats; one press is one answer.
        if (!event.repeat) pick(label);
      }
      return;
    }
    if ((event.key === "r" || event.key === "R") && canReply && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (composerOpen) composerRef.current?.focus();
      else openComposer();
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && canTrash) {
      event.preventDefault();
      onTrash(item);
    }
  };

  const compact = item.kind === "working" || item.kind === "running" || item.kind === "idle";
  // Without a reading or a prompt there is nothing under the identity line, and
  // the row keeps the one-line height its working neighbours have.
  const hasBody =
    question !== null ||
    options.length > 0 ||
    card?.headline != null ||
    card?.summary != null ||
    item.pending ||
    card?.secretPrompt === true ||
    composerOpen ||
    item.stale ||
    sentHere !== null;
  const oneLine = compact || !hasBody;
  const accessibleName = [
    item.row.title,
    item.row.chrome.label,
    item.workspace.name,
    item.row.worktreeLabel,
    KIND_LABEL[item.kind],
    item.row.agePhrase,
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== "")
    .join(", ");

  const actions = (
    <>
      {canReply && !composerAlwaysOpen(item) && !composerOpen && (
        <RowAction label="Send a follow-up" onClick={openComposer}>
          <Reply />
        </RowAction>
      )}
      {canTrash && (
        <RowAction label="Trash terminal" onClick={() => onTrash(item)}>
          <Trash2 />
        </RowAction>
      )}
      <RowAction label="Go to terminal" onClick={() => onOpen(item)}>
        <SquareArrowOutUpRight />
      </RowAction>
    </>
  );

  return (
    <div
      ref={cardRef}
      id={domId}
      role="article"
      tabIndex={isFocused ? 0 : -1}
      aria-label={accessibleName}
      aria-describedby={question !== null ? quoteId : undefined}
      aria-posinset={position}
      aria-setsize={setSize}
      data-triage-card=""
      data-kind={item.kind}
      data-selected={isFocused ? "true" : undefined}
      // Focus anywhere in the card — a button, the composer — makes it the
      // list's current card, so the arrows move on from where the user is.
      onFocus={() => {
        if (!isFocused) onFocusCard();
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (!isFocused) onPointerCursor(event.currentTarget);
      }}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(item)}
      className={cn(
        PALETTE_ROW_CLASS,
        "group cursor-pointer rounded-[var(--radius-md)] px-2.5",
        // Inside the panel's scroller, so the ring sits inset rather than clipped.
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
        oneLine ? "py-1" : "flex flex-col gap-1.5 py-1.5"
      )}
    >
      <CardIdentity item={item} strong={!compact} actions={actions} showActions={isFocused} />

      {!hasBody && !compact ? null : compact ? (
        card?.activity ? (
          <p className="-mt-0.5 truncate pb-1 pl-[46px] font-mono text-xs text-text-secondary">
            {card.activity}
          </p>
        ) : null
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5 pb-0.5 pl-[46px]">
          {question !== null && <QuestionQuote question={question} id={quoteId} />}
          <CardWords item={item} hasQuote={question !== null} />
          {options.length > 0 && (
            <OptionButtons
              options={options}
              answered={answered}
              tabbable={isFocused}
              onPick={pick}
            />
          )}
          {card?.secretPrompt === true ? (
            <p className="flex items-center gap-1.5 text-xs text-text-secondary">
              <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
              It's asking for a secret, so answer it in the terminal
            </p>
          ) : composerOpen ? (
            <Composer
              item={item}
              placeholder={item.kind === "finished" ? "Send a follow-up…" : "Reply…"}
              onReply={onReply}
              composerRef={composerRef}
              tabbable={isFocused}
              collapsible={!composerAlwaysOpen(item)}
              onEscape={() => {
                if (!composerAlwaysOpen(item)) setComposerOpened(false);
                cardRef.current?.focus();
              }}
              onSent={(text) => {
                setAck(item.runId, () => ({ promptKey, kind: "reply", text, sent: true }));
                if (!composerAlwaysOpen(item)) {
                  setComposerOpened(false);
                  // The box held focus and is about to unmount: keep the keyboard on the row.
                  cardRef.current?.focus();
                }
              }}
            />
          ) : null}
          {item.stale && card !== null && (
            <p className="text-2xs text-text-secondary">
              Changed since it was read <TimeAgo timestamp={card.observedAt} />
              {item.pending ? " · reading again…" : " · retried on the next scan"}
            </p>
          )}
          {sentHere !== null && (
            <p role="status" className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                Sent <span className="text-text-primary">{sentHere}</span>
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
