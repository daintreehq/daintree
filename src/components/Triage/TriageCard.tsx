import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CornerDownLeft, KeyRound, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/Kbd";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import type { FleetBand } from "@/lib/fleetAttention";
import type { TriageCategory } from "@shared/types/ipc/triage";
import type { TriageItem } from "./triageModel";

/** The Pilot band whose glyph and tone say this kind, so both surfaces agree. */
const KIND_BAND: Record<TriageCategory, FleetBand> = {
  approval: "needs-you",
  question: "needs-you",
  error: "blocked",
  finished: "review",
  working: "running",
  running: "running",
  idle: "idle",
};

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
  onFocusCard: () => void;
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

/** Identity line shared by every card: state, agent, title, where, how long. */
function CardIdentity({
  item,
  compact,
  trailing,
}: {
  item: TriageItem;
  compact: boolean;
  trailing?: React.ReactNode;
}) {
  const { row } = item;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <PilotRunState band={KIND_BAND[item.kind]} agentState={row.run.agentState} />
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <TerminalIcon
          chrome={row.chrome}
          className="h-4 w-4"
          brandColor={row.presetColor ?? row.chrome.color}
        />
      </span>
      <span
        className={cn(
          "min-w-0 truncate leading-tight text-text-primary",
          compact ? "flex-initial text-sm" : "flex-initial text-sm font-medium"
        )}
      >
        {row.title}
      </span>
      <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-text-secondary">
        <WorkspaceTile workspace={item.workspace} />
        <span className="truncate">
          {item.workspace.name}
          {row.worktreeLabel ? ` · ${row.worktreeLabel}` : ""}
        </span>
      </span>
      <span className="flex-1" />
      {row.age !== null && (
        <span className="shrink-0 text-2xs leading-none text-text-secondary tabular-nums">
          {row.age}
        </span>
      )}
      {trailing}
    </div>
  );
}

/** The card's one sentence of meaning, or a bone while it is being written. */
function CardWords({ item }: { item: TriageItem }) {
  const headline = item.card?.headline ?? null;
  const summary = item.card?.summary ?? null;
  if (headline === null && summary === null) {
    if (!item.pending) return null;
    return (
      <div className="flex flex-col gap-1.5 pt-0.5" aria-hidden="true">
        <SkeletonBone className="h-3.5 w-2/5 rounded-[var(--radius-sm)]" heightPx={14} />
        <SkeletonBone className="h-3 w-3/5 rounded-[var(--radius-sm)]" heightPx={12} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {headline !== null && <p className="text-sm leading-snug text-text-primary">{headline}</p>}
      {summary !== null && <p className="text-xs leading-relaxed text-text-secondary">{summary}</p>}
    </div>
  );
}

/** The prompt being asked, quoted as it appears on screen. */
function QuestionQuote({ question }: { question: string }) {
  return (
    <blockquote className="rounded-[var(--radius-md)] border-l-2 border-state-waiting bg-surface-inset px-3 py-2 text-sm leading-snug text-text-primary">
      {question}
    </blockquote>
  );
}

function Composer({
  item,
  placeholder,
  onReply,
  composerRef,
  onEscape,
}: {
  item: TriageItem;
  placeholder: string;
  onReply: TriageCardHandlers["onReply"];
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onEscape: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    const message = text.trim();
    if (message === "" || sending) return;
    setSending(true);
    try {
      await onReply(item, message);
      setText("");
    } catch {
      // Already reported by the handler; the draft stays for another try.
    } finally {
      setSending(false);
    }
  }, [item, onReply, sending, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      // Escape clears a draft first; with nothing typed it belongs to the dialog.
      if (text === "") return;
      event.stopPropagation();
      event.preventDefault();
      setText("");
      onEscape();
      return;
    }
    // The card's and the list's keys must not fire while typing.
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex items-end gap-2" onClick={(event) => event.stopPropagation()}>
      <Textarea
        ref={composerRef}
        rows={1}
        density="compact"
        resize="none"
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={`Message ${item.row.title}`}
        className="field-sizing-content max-h-32 min-h-8"
      />
      <Button
        variant="subtle"
        size="icon"
        aria-label="Send"
        disabled={text.trim() === "" || sending}
        onClick={() => void send()}
      >
        <CornerDownLeft />
      </Button>
    </div>
  );
}

function OptionButtons({
  options,
  disabled,
  onPick,
}: {
  options: readonly string[];
  disabled: boolean;
  onPick: (label: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer">
      {options.map((label, index) => (
        <Button
          key={label}
          variant="subtle"
          size="sm"
          disabled={disabled}
          aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onPick(label);
          }}
          className="max-w-full justify-start"
        >
          {index < 9 && <Kbd className="shrink-0">{index + 1}</Kbd>}
          <span className="truncate">{label}</span>
        </Button>
      ))}
    </div>
  );
}

function SecondaryActions({
  item,
  onOpen,
  onTrash,
  canTrash,
}: {
  item: TriageItem;
  onOpen: TriageCardHandlers["onOpen"];
  onTrash: TriageCardHandlers["onTrash"];
  canTrash: boolean;
}) {
  return (
    <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <Button variant="ghost" size="xs" onClick={() => onOpen(item)}>
        <SquareArrowOutUpRight />
        Go to terminal
      </Button>
      {canTrash && (
        <Button variant="ghost" size="xs" onClick={() => onTrash(item)}>
          <Trash2 />
          Trash terminal
        </Button>
      )}
    </div>
  );
}

/**
 * One run, drawn for what it needs. Full cards for runs that are blocked on the
 * user; a single line for the rest, because a working agent's whole story is
 * "still going" and the newest line on its screen.
 */
export function TriageCard({
  item,
  domId,
  isFocused,
  onFocusCard,
  onOpen,
  onChoose,
  onReply,
  onTrash,
}: TriageCardProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const card = item.card;
  const options = item.kind === "approval" ? (card?.options ?? []) : [];
  const question = card?.question ?? null;
  const canReply = canReplyTo(item);
  const canTrash = canTrashItem(item);

  // One answer per prompt, from a click or a digit alike. Keyed on the prompt,
  // so the next menu — even one with the same labels — starts answerable.
  const promptKey = card === null ? "" : `${card.spawnedAt}:${card.revision}`;
  const [answeredPrompt, setAnsweredPrompt] = useState<string | null>(null);
  const answered = answeredPrompt === promptKey;
  const pick = (label: string) => {
    if (answered) return;
    const key = promptKey;
    setAnsweredPrompt(key);
    // A failure frees only its own prompt, never a newer one answered since.
    onChoose(item, label).catch(() =>
      setAnsweredPrompt((current) => (current === key ? null : current))
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
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
      composerRef.current?.focus();
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && canTrash) {
      event.preventDefault();
      onTrash(item);
    }
  };

  const compact = item.kind === "working" || item.kind === "running" || item.kind === "idle";
  const accessibleName = [
    item.row.title,
    item.workspace.name,
    KIND_LABEL[item.kind],
    item.row.agePhrase,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");

  return (
    <div
      ref={cardRef}
      id={domId}
      role="article"
      tabIndex={isFocused ? 0 : -1}
      aria-label={accessibleName}
      data-triage-card=""
      data-kind={item.kind}
      // Focus anywhere in the card — a button, the composer — makes it the
      // list's current card, so the arrows move on from where the user is.
      onFocus={() => {
        if (!isFocused) onFocusCard();
      }}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(item)}
      className={cn(
        "group cursor-pointer rounded-[var(--radius-md)] ring-1 transition-[background-color,box-shadow] duration-150 ease-out",
        // Inside the panel's scroller, so the ring sits inset rather than clipped.
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
        compact
          ? "bg-transparent px-3 py-2 ring-transparent hover:bg-overlay-hover"
          : "flex flex-col gap-2.5 bg-surface-panel px-3.5 py-3 ring-border-subtle shadow-[var(--theme-shadow-ambient)] hover:ring-border-default",
        isFocused && !compact && "ring-border-strong",
        isFocused && compact && "bg-overlay-subtle"
      )}
    >
      <CardIdentity
        item={item}
        compact={compact}
        trailing={
          item.kind === "idle" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Trash ${item.row.title}`}
              tabIndex={-1}
              className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onTrash(item);
              }}
            >
              <Trash2 />
            </Button>
          ) : undefined
        }
      />

      {compact ? (
        card?.activity ? (
          <p className="mt-1 truncate pl-[46px] font-mono text-xs text-text-secondary">
            {card.activity}
          </p>
        ) : null
      ) : (
        <>
          <CardWords item={item} />
          {question !== null && (item.kind === "approval" || item.kind === "question") && (
            <QuestionQuote question={question} />
          )}
          {options.length > 0 && (
            <OptionButtons options={options} disabled={answered} onPick={pick} />
          )}
          {card?.secretPrompt === true ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
              It's asking for a secret — answer it in the terminal.
            </p>
          ) : canReply ? (
            <Composer
              item={item}
              placeholder={item.kind === "finished" ? "Send a follow-up…" : "Reply…"}
              onReply={onReply}
              composerRef={composerRef}
              onEscape={() => cardRef.current?.focus()}
            />
          ) : null}
          <SecondaryActions item={item} onOpen={onOpen} onTrash={onTrash} canTrash={canTrash} />
        </>
      )}
    </div>
  );
}
