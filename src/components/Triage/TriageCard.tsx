import { Suspense, lazy, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, KeyRound, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { isMac } from "@/lib/platform";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { triagePromptKey, useTriageStore } from "@/store/triageStore";
import type { TriageItem } from "./triageModel";
import { KIND_LABEL } from "./TriageRow";
import { TriageTerminal, type TriageStreamState } from "./TriageTerminal";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

export interface TriageCardHandlers {
  onOpen: (item: TriageItem) => void;
  onChoose: (item: TriageItem, label: string) => Promise<void>;
  onTrash: (item: TriageItem) => void;
  /** Something was typed and sent to the run from the pane. */
  onSent: (item: TriageItem) => void;
  /** Main refused what the composer sent; the draft is already gone. */
  onSendFailed: (item: TriageItem, error: unknown) => void;
}

/** What the list can ask of the pane for the agent it has selected. */
export interface TriageCardHandle {
  /** Handle a key aimed at the list's selected row; true when it was used. */
  handleKey: (event: KeyboardEvent<HTMLElement>) => boolean;
}

interface TriageCardProps extends TriageCardHandlers {
  item: TriageItem;
  domId: string;
  /** Main is scanning right now. */
  scanning: boolean;
  ref?: React.Ref<TriageCardHandle>;
}

/**
 * The composer is offered unless a secret is being asked for — by the card's
 * reading or by the live screen itself, which covers a run not read yet. A
 * composer keeps history, and a password must never land in it; a secret is
 * typed straight into the live terminal instead, which keeps nothing.
 */
export function canReplyTo(item: TriageItem, liveSecretPrompt = false): boolean {
  return !liveSecretPrompt && !(item.card?.secretPrompt === true && !item.stale);
}

/** Trash is offered where the run is done with or stuck: never on one at work. */
export function canTrashItem(item: TriageItem): boolean {
  return item.kind === "finished" || item.kind === "error" || item.kind === "idle";
}

export function triageCardDomId(runId: string): string {
  return `triage-card-${runId}`;
}

function OptionButtons({
  options,
  answered,
  onPick,
}: {
  options: readonly string[];
  answered: { label: string; sent: boolean } | null;
  onPick: (label: string) => void;
}) {
  const sent = answered?.sent === true;
  return (
    <>
      {!sent && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answer">
          {options.map((label, index) => (
            <Button
              key={label}
              variant="outline"
              size="sm"
              disabled={answered !== null && answered.label !== label}
              loading={answered?.label === label}
              aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
              onClick={() => onPick(label)}
              // A permission's scope is often in its last words, so a long label
              // wraps under its digit rather than truncating them away.
              className="h-auto min-h-8 max-w-full items-start justify-start py-1.5 text-left whitespace-normal"
            >
              {index < 9 && (
                <KbdChord
                  shortcut={String(index + 1)}
                  density="bare"
                  // The button says its key through aria-keyshortcuts already.
                  rootAttributes={{ "aria-hidden": "true" }}
                  className="h-4 shrink-0"
                />
              )}
              <span className="min-w-0 leading-4">{label}</span>
            </Button>
          ))}
        </div>
      )}
      <AckLine text={sent ? answered.label : null} />
    </>
  );
}

/**
 * What main took from the panel. Mounted before there is anything to say, so
 * the acknowledgement is announced when it lands rather than inserted unheard.
 */
function AckLine({ text }: { text: string | null }) {
  return (
    <p
      role="status"
      className={
        text === null ? "sr-only" : "flex items-center gap-1.5 text-xs text-text-secondary"
      }
    >
      {text === null ? null : (
        <>
          <Check className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">
            Answered: <span className="text-text-primary">{text}</span>
          </span>
        </>
      )}
    </p>
  );
}

/**
 * The selected agent: what the readers made of its screen, quick answers for a
 * menu, and then the terminal itself — live, on the WebGL renderer — with the
 * real composer under it. Type, press Enter, and it goes to that agent, from
 * whichever project it is in.
 */
export function TriageCard({
  item,
  domId,
  scanning,
  ref,
  onOpen,
  onChoose,
  onTrash,
  onSent,
  onSendFailed,
}: TriageCardProps) {
  const [stream, setStream] = useState<TriageStreamState>({
    watchId: null,
    ended: false,
    secretPrompt: false,
  });
  const composerRef = useRef<HybridInputBarHandle>(null);
  const card = item.card;
  const { row } = item;
  const run = row.run;
  const options = item.kind === "approval" && !item.stale ? (card?.options ?? []) : [];
  const canReply = canReplyTo(item, stream.secretPrompt);
  const canTrash = canTrashItem(item);

  // One answer per prompt, from a click or a digit alike. Keyed on the prompt,
  // so the next menu — even one with the same labels — starts answerable.
  const promptKey = card === null ? "" : triagePromptKey(card);
  const ack = useTriageStore((state) => state.acks[item.runId]);
  const setAck = useTriageStore((state) => state.setAck);
  const answered =
    ack !== undefined && ack.kind === "answer" && ack.promptKey === promptKey
      ? { label: ack.text, sent: ack.sent }
      : null;
  const pick = (label: string) => {
    if (answered) return;
    const key = promptKey;
    const runId = item.runId;
    setAck(runId, () => ({ promptKey: key, kind: "answer", text: label, sent: false }));
    onChoose(item, label).then(
      () =>
        setAck(runId, (current) =>
          current?.promptKey === key && current.text === label
            ? { ...current, sent: true }
            : current
        ),
      // A failure frees only its own prompt, never a newer one answered since.
      () => setAck(runId, (current) => (current?.promptKey === key ? undefined : current))
    );
  };

  const handleKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const label = options[Number(event.key) - 1];
      if (label === undefined) return false;
      event.preventDefault();
      // A held key auto-repeats; one press is one answer.
      if (!event.repeat) pick(label);
      return true;
    }
    if ((event.key === "r" || event.key === "R") && canReply && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      composerRef.current?.focus();
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && canTrash) {
      event.preventDefault();
      onTrash(item);
      return true;
    }
    return false;
  };
  useImperativeHandle(ref, () => ({ handleKey }));

  const question =
    item.kind === "approval" || item.kind === "question" ? (card?.question ?? null) : null;
  const headline = card?.headline ?? question;
  const summary = card?.summary ?? null;
  const reading = card?.describing === true || scanning;
  const where = [item.workspace.name, row.worktreeLabel].filter(Boolean).join(" · ");
  const agentId = isBuiltInAgentId(run.agentId) ? run.agentId : undefined;

  // Through the open stream only, so main sends to the incarnation on screen
  // or to nothing.
  const send = (text: string, imagePaths?: string[]) => {
    const watchId = stream.watchId;
    if (watchId === null) return;
    window.electron.triage.terminalSubmit(watchId, text, imagePaths).then(
      () => onSent(item),
      (error: unknown) => onSendFailed(item, error)
    );
  };

  return (
    <section
      id={domId}
      aria-label={`${row.title}, ${KIND_LABEL[item.kind]}`}
      data-triage-detail=""
      // Keys pressed on the pane's own buttons act on its agent too; keys in
      // the terminal or the composer are theirs.
      onKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("textarea, input, [contenteditable], [data-triage-terminal]")
        ) {
          return;
        }
        handleKey(event);
      }}
      className="flex h-full min-h-0 flex-col gap-2.5"
    >
      <header className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          <TerminalIcon
            chrome={row.chrome}
            className="h-5 w-5"
            brandColor={row.presetColor ?? row.chrome.color}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium break-words text-text-primary">
            {row.title}
            <span className="font-normal text-text-secondary"> · {where}</span>
          </h3>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <PilotRunState band={row.band} agentState={run.agentState} />
            </span>
            <span className="shrink-0">{KIND_LABEL[item.kind]}</span>
            {row.age !== null && <span className="shrink-0">· {row.age}</span>}
            {item.stale && card !== null && (
              <span className="truncate">
                · read <TimeAgo timestamp={card.observedAt} />
                {reading ? ", reading again…" : ", refresh to read again"}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canTrash && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onTrash(item)}
              aria-keyshortcuts={isMac() ? "Meta+Backspace" : "Control+Backspace"}
            >
              <Trash2 />
              Trash
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpen(item)}>
            <SquareArrowOutUpRight />
            Go to terminal
          </Button>
        </div>
      </header>

      {(headline !== null || summary !== null) && (
        <div className="flex flex-col gap-0.5 pl-7.5">
          {headline !== null && (
            <p className="text-sm leading-snug text-text-primary">{headline}</p>
          )}
          {summary !== null && (
            <p className="text-xs leading-relaxed text-text-secondary">{summary}</p>
          )}
        </div>
      )}
      {headline === null && summary === null && item.pending && (
        // Nothing polls, so a screen that moved since the last scan stays unread
        // until the user refreshes; only claim a read while one is in flight.
        <p className="pl-7.5 text-xs text-text-secondary">
          {reading ? "Reading the screen…" : "Changed since the last scan. Refresh to read it."}
        </p>
      )}

      {options.length > 0 && (
        <div className="pl-7.5">
          <OptionButtons options={options} answered={answered} onPick={pick} />
        </div>
      )}

      <div
        className="flex min-h-0 flex-1 flex-col gap-2"
        // Escape belongs to the agent here — it interrupts or backs out of a
        // menu — so it must not also close the dialog around it.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        <TriageTerminal
          key={`${item.runId}:${run.spawnedAt}`}
          runId={item.runId}
          spawnedAt={run.spawnedAt}
          onStreamChange={setStream}
        />

        {canReply ? (
          <div data-keybindings-isolated="" className="contents">
            <Suspense fallback={null}>
              <LazyHybridInputBar
                ref={composerRef}
                isolated
                terminalId={item.runId}
                cwd={run.cwd ?? ""}
                agentId={agentId}
                agentState={run.agentState}
                disabled={stream.watchId === null}
                onSend={({ text, imagePaths }) => send(text, imagePaths)}
                onSendKey={(key) => {
                  const watchId = stream.watchId;
                  if (watchId === null) return;
                  window.electron.triage.terminalSendKey(watchId, key).then(
                    () => onSent(item),
                    (error: unknown) => onSendFailed(item, error)
                  );
                }}
              />
            </Suspense>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
            It's asking for a secret: type it straight into the terminal above
          </p>
        )}
      </div>
    </section>
  );
}
