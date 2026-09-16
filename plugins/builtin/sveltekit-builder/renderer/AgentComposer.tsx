import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_INSTRUCTION_CHARS,
  buildAgentTaskPrompt,
  scopesFor,
  isAgentBusy,
  isUnresolvedScope,
  type AgentTarget,
} from "./agentTask.js";
import { ownerFile, type InspectorController, type SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { WaitingRow } from "./WaitingRow.js";
import { useAgentTargets } from "./useAgentTargets.js";
import { basename } from "./copy.js";
import {
  readComposerMemory,
  updateComposerMemory,
  useComposerMemory,
  type ComposerMemory,
  type ComposerPin,
} from "./composerMemory.js";
import { deliverAgentRequest, forceAgentRequest } from "./agentRequest.js";

const STALE_SOURCE =
  "The source changed since you picked this — select it again in the page, then send";

/** Pinned drafts with a definitions lookup out, across composer remounts. */
const pinnedLookups = new Set<string>();

function settlePinnedDefinitions(
  controller: InspectorController,
  memoryKey: string,
  pin: ComposerPin
): void {
  const lookup = `${memoryKey}\n${pin.selection.selectionId}`;
  if (pinnedLookups.has(lookup)) return;
  pinnedLookups.add(lookup);
  void controller
    .lookupDefinitions(pin.selection, pin.picked)
    .then((resolved) => {
      if (resolved === null) return;
      const latest = readComposerMemory(memoryKey).pinned;
      if (
        latest?.selection.selectionId === pin.selection.selectionId &&
        latest.definitions === null
      ) {
        updateComposerMemory(memoryKey, { pinned: { ...latest, ...resolved } });
      }
    })
    .finally(() => pinnedLookups.delete(lookup));
}

/** Agents offered for a fresh session, in the order people most often bring them. */
const LAUNCHABLE_AGENTS = ["claude", "codex", "gemini"] as const;

const ELEMENT_INTENTS = [
  "Rewrite this copy to be clearer and more persuasive",
  "Make this stand out more",
  "Tighten the spacing",
  "Make this look right on mobile",
];
const COMPONENT_INTENTS = [
  "Polish this component's visual design",
  "Add a subtle hover and entrance animation",
  "Make this component responsive",
  "Match the rest of the site's style",
];

type Pinned = ComposerPin;

type Destination =
  { kind: "terminal"; target: AgentTarget } | { kind: "launch"; agentId: string; name: string };

type DeliveryRecord = NonNullable<ComposerMemory["delivery"]>;

/**
 * Hand the selection to an agent — one already running in this worktree, or a
 * fresh Claude Code, Codex or Gemini session on the user's own account — with
 * the source identity the builder resolved. The terminal stays the agent: this
 * composes and delivers one request, then reports what the host can prove.
 */
export function AgentComposer({
  controller,
  selection,
  worktreeId,
  worktreePath,
  memoryKey,
}: {
  controller: InspectorController;
  selection: SelectionState;
  worktreeId: string | null;
  worktreePath: string | null;
  /** The preview this composer belongs to; its draft survives the drawer closing. */
  memoryKey: string;
}) {
  const targets = useAgentTargets(worktreeId);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const availabilityKnown = useCliAvailabilityStore((state) => state.isInitialized);
  const memory = useComposerMemory(memoryKey);
  const { draft, pinned, chosen, delivery } = memory;
  const setDraft = (next: string) => updateComposerMemory(memoryKey, { draft: next });
  const setPinned = (next: Pinned | null) => updateComposerMemory(memoryKey, { pinned: next });
  const setChosen = (next: string | null) => updateComposerMemory(memoryKey, { chosen: next });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const launchable: Destination[] = LAUNCHABLE_AGENTS.flatMap((agentId) => {
    const config = getEffectiveAgentConfig(agentId);
    if (!config) return [];
    // Until availability is known, offer them; launching a missing CLI opens
    // the host's own setup diagnostic rather than failing silently.
    if (availabilityKnown && !isAgentInstalled(availability[agentId])) return [];
    return [{ kind: "launch" as const, agentId, name: config.name }];
  });
  const destinations: Destination[] = [
    ...targets.map((target) => ({ kind: "terminal" as const, target })),
    ...launchable,
  ];
  const keyOf = (destination: Destination): string =>
    destination.kind === "terminal"
      ? `terminal:${destination.target.terminalId}`
      : `launch:${destination.agentId}`;
  // Once the user has committed to an agent, never swap it for another behind
  // their back: a vanished choice blocks sending until they pick again.
  const committed =
    chosen === null ? undefined : destinations.find((candidate) => keyOf(candidate) === chosen);
  const destination = chosen === null ? destinations[0] : committed;
  const destinationGone = chosen !== null && committed === undefined;

  const current: Pinned | null =
    selection.status === "ready"
      ? {
          selection: selection.selection,
          file: ownerFile(selection.selection, worktreePath),
          // A component picked on the page is what the request is about.
          scope: scopesFor(
            selection.selection,
            selection.scope === "component" ? selection.component : null,
            selection.definitions
          ).pickedIndex,
          picked:
            selection.scope === "component" && selection.component ? selection.component : null,
          definitions: selection.definitions,
          revisions: selection.revisions,
        }
      : null;
  const [unpinnedScope, setUnpinnedScope] = useState<{ selectionId: string; scope: number } | null>(
    null
  );
  // A draft keeps pointing at what it was written about; clicking elsewhere
  // offers to retarget instead of quietly changing the subject.
  const subject: Pinned | null =
    pinned ??
    (current && unpinnedScope?.selectionId === current.selection.selectionId
      ? { ...current, scope: unpinnedScope.scope }
      : current);
  // Definitions arrive after the selection; a draft pinned before they did
  // takes them from the live selection it was written about.
  const live =
    subject !== null &&
    current !== null &&
    subject.selection.selectionId === current.selection.selectionId;
  const definitions = live ? current.definitions : (subject?.definitions ?? null);
  const revisions = live ? current.revisions : (subject?.revisions ?? null);
  // A draft pinned before its definitions arrived settles them itself: from
  // the live selection while it is the same one, otherwise by asking main.
  useEffect(() => {
    if (!pinned || pinned.definitions !== null) return;
    if (current?.selection.selectionId === pinned.selection.selectionId) {
      if (current.definitions !== null) {
        setPinned({ ...pinned, definitions: current.definitions, revisions: current.revisions });
      }
      return;
    }
    settlePinnedDefinitions(controller, memoryKey, pinned);
  });
  // The picked component's identity travels with the pin, so a pinned request
  // keeps naming the component the user highlighted.
  const scopes = subject ? scopesFor(subject.selection, subject.picked, definitions).scopes : [];
  const activeScope = subject ? scopes[subject.scope] : undefined;
  const scopeUnproven = isUnresolvedScope(activeScope);
  const scopePending = scopeUnproven && definitions === null;
  const chooseScope = (scope: number) => {
    if (pinned) setPinned({ ...pinned, scope });
    else if (current) setUnpinnedScope({ selectionId: current.selection.selectionId, scope });
  };

  const busy =
    destination?.kind === "terminal" ? isAgentBusy(destination.target.agentState) : false;
  const sending =
    delivery?.state.status === "sending" ||
    delivery?.state.status === "starting" ||
    delivery?.state.status === "needs-you" ||
    delivery?.state.status === "unknown-readiness";
  const needsScopeChoice = scopeUnproven && !scopePending;
  // A selection the page or its source has moved past can't vouch for the
  // locations a request would name.
  const subjectStale =
    subject !== null &&
    selection.status === "ready" &&
    selection.stale !== null &&
    selection.selection.selectionId === subject.selection.selectionId;
  const canSend = Boolean(
    subject &&
    activeScope &&
    destination &&
    draft.trim() &&
    !busy &&
    !sending &&
    !scopeUnproven &&
    !subjectStale &&
    revisions !== null
  );

  const onDraftChange = (next: string) => {
    setDraft(next);
    if (next.trim() && chosen === null && destination) setChosen(keyOf(destination));
    if (next.trim() && !pinned && subject) setPinned({ ...subject, definitions, revisions });
    if (!next.trim() && pinned) setPinned(null);
  };

  const applyIntent = (intent: string) => {
    onDraftChange(intent);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const send = () => {
    if (!subject || !destination || !canSend) return;
    const request = subject;
    const scope = activeScope;
    const cited = revisions;
    const instruction = draft;
    void deliverAgentRequest({
      memoryKey,
      worktreeId,
      sentDraft: instruction,
      destination:
        destination.kind === "terminal"
          ? {
              kind: "terminal",
              terminalId: destination.target.terminalId,
              title: destination.target.title,
            }
          : { kind: "launch", agentId: destination.agentId, title: destination.name },
      // Locations in the prompt are only true of the bytes they were read from,
      // and an agent can take minutes to reach its prompt. Checked again right
      // before the request goes in; the draft stays either way.
      verify: async () =>
        (await controller.sourcesUnchanged(request.selection, cited)) ? null : STALE_SOURCE,
      buildPrompt: async () => {
        const excerpt = request.file
          ? await controller.sourceExcerpt(request.selection, request.file)
          : null;
        // Source text from other bytes than the locations were read from would
        // contradict them, even if the file is back to the old bytes by send time.
        if (excerpt && excerpt.revision !== request.selection.nodes[0]?.definition?.revision) {
          throw new Error(STALE_SOURCE);
        }
        return buildAgentTaskPrompt({
          instruction,
          selection: request.selection,
          file: request.file,
          worktreePath,
          excerpt,
          scope,
        });
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const sendAnyway = () => forceAgentRequest(memoryKey);
  const dismissDelivery = () => updateComposerMemory(memoryKey, { delivery: null });
  // What the agent actually changed is the worktree's diff, not its word.
  const reviewChanges = () =>
    void actionService.dispatch("worktree.openChanges", worktreeId ? { worktreeId } : undefined, {
      source: "user",
    });

  const openTerminal = (id: string) =>
    void actionService.dispatch("panel.focus", { panelId: id }, { source: "user" });

  const definition = subject?.selection.nodes[0]?.definition ?? null;
  const subjectLabel =
    activeScope?.kind === "component"
      ? activeScope.label
      : subject?.selection.nodes[0]?.label || definition?.tagName || "element";
  const retargetable =
    pinned !== null &&
    current !== null &&
    current.selection.selectionId !== pinned.selection.selectionId;
  const intents = activeScope?.kind === "component" ? COMPONENT_INTENTS : ELEMENT_INTENTS;
  const liveTarget = delivery?.terminalId
    ? targets.find((target) => target.terminalId === delivery.terminalId)
    : undefined;

  if (!subject) {
    return delivery ? (
      <DeliveryNotice
        delivery={delivery}
        liveTarget={liveTarget}
        onOpenTerminal={openTerminal}
        onReviewChanges={reviewChanges}
        onSendAnyway={sendAnyway}
        onDismiss={dismissDelivery}
      />
    ) : null;
  }

  return (
    <section
      aria-labelledby={`${inputId}-heading`}
      className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-surface-inset p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id={`${inputId}-heading`}
          className="flex items-center gap-1.5 text-xs font-medium text-text-primary"
        >
          <Sparkles className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
          Ask an agent
        </h2>
        {destinations.length > 0 ? (
          <Select value={destination ? keyOf(destination) : ""} onValueChange={setChosen}>
            <SelectTrigger aria-label="Agent to send to" className="h-6 max-w-[180px] text-xs">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {targets.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Running in this worktree</SelectLabel>
                  {targets.map((target) => (
                    <SelectItem key={target.terminalId} value={`terminal:${target.terminalId}`}>
                      {target.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {launchable.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Start a new session</SelectLabel>
                  {launchable.map((option) =>
                    option.kind === "launch" ? (
                      <SelectItem key={option.agentId} value={`launch:${option.agentId}`}>
                        {`New ${option.name}`}
                      </SelectItem>
                    ) : null
                  )}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-text-secondary" title={subjectLabel}>
          About <span className="text-text-primary">{subjectLabel}</span>
          {definition && activeScope?.kind !== "component" ? (
            <span className="font-mono">
              {` · ${basename(subject.file ?? definition.location.file)}:${definition.location.line}`}
            </span>
          ) : null}
        </span>
        {retargetable && current ? (
          <Button variant="ghost" size="xs" onClick={() => setPinned(current)}>
            Use current selection
          </Button>
        ) : null}
      </div>

      {subjectStale ? (
        <p className="text-xs text-text-secondary">
          This changed since you picked it — select it again in the page to send
        </p>
      ) : null}

      {needsScopeChoice && activeScope?.kind === "component" ? (
        <p className="text-xs text-text-secondary">
          {`Couldn't find where ${activeScope.label} is written — choose what this is about`}
        </p>
      ) : null}

      {scopes.length > 1 ? (
        <div role="group" aria-label="What the request is about" className="flex flex-wrap gap-1">
          {scopes.map((scope, index) => (
            <Button
              key={`${scope.kind}:${scope.label}:${index}`}
              variant={subject.scope === index ? "subtle" : "ghost"}
              size="xs"
              aria-pressed={subject.scope === index}
              title={scope.kind === "component" ? (scope.file ?? undefined) : undefined}
              onClick={() => chooseScope(index)}
            >
              {scope.kind === "element" ? "This element" : scope.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <Textarea
          ref={textareaRef}
          id={inputId}
          aria-label="Request for the agent"
          placeholder={
            activeScope?.kind === "component"
              ? `What should change in ${subjectLabel}?`
              : "What should change?"
          }
          density="compact"
          rows={3}
          resize="none"
          maxLength={MAX_INSTRUCTION_CHARS}
          value={draft}
          disabled={destinations.length === 0}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="pr-10"
        />
        <Button
          variant="default"
          size="icon-sm"
          aria-label="Send to agent"
          title="Send to agent (Enter)"
          disabled={!canSend}
          onClick={send}
          className="absolute bottom-1.5 right-1.5"
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </div>

      {!draft.trim() ? (
        <div role="group" aria-label="Suggestions" className="flex flex-wrap gap-1">
          {intents.map((intent) => (
            <button
              key={intent}
              type="button"
              onClick={() => applyIntent(intent)}
              className="rounded-full border border-border-subtle px-2 py-0.5 text-3xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            >
              {intent}
            </button>
          ))}
        </div>
      ) : null}

      {destinationGone ? (
        <p className="text-xs text-text-secondary">
          The agent you chose isn't running any more — choose where this should go
        </p>
      ) : destinations.length === 0 ? (
        <p className="text-xs text-text-secondary">
          Install Claude Code, Codex or Gemini CLI to send requests with your own account
        </p>
      ) : busy && destination?.kind === "terminal" ? (
        <p className="text-xs text-text-secondary">
          {destination.target.title} is working — wait for it to finish before sending
        </p>
      ) : null}

      {delivery ? (
        <DeliveryNotice
          delivery={delivery}
          liveTarget={liveTarget}
          onOpenTerminal={openTerminal}
          onReviewChanges={reviewChanges}
          onSendAnyway={sendAnyway}
          onDismiss={dismissDelivery}
        />
      ) : null}
    </section>
  );
}

function DeliveryNotice({
  delivery,
  liveTarget,
  onOpenTerminal,
  onReviewChanges,
  onSendAnyway,
  onDismiss,
}: {
  delivery: DeliveryRecord;
  liveTarget: AgentTarget | undefined;
  onOpenTerminal: (terminalId: string) => void;
  onReviewChanges: () => void;
  onSendAnyway: () => void;
  onDismiss: () => void;
}) {
  const { state, title, terminalId } = delivery;
  const settled =
    state.status === "sent" || state.status === "unconfirmed" || state.status === "failed";
  const open = (
    <div className="flex flex-wrap gap-1">
      {terminalId ? (
        <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
          Open terminal
        </Button>
      ) : null}
      {state.status === "sent" ? (
        <Button variant="subtle" size="xs" onClick={onReviewChanges}>
          Review changes
        </Button>
      ) : null}
      {settled ? (
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
  switch (state.status) {
    case "sending":
      return <WaitingRow label={`Sending to ${title}`} />;
    case "starting":
      return <WaitingRow label={`Starting ${title} — your request goes in when it's ready`} />;
    case "unknown-readiness":
      return (
        <InspectorNotice
          tone="warning"
          role="status"
          title={`Can't tell whether ${title} is ready`}
          action={
            <div className="flex flex-wrap gap-1">
              <Button variant="subtle" size="xs" onClick={onSendAnyway}>
                Send anyway
              </Button>
              {terminalId ? (
                <Button variant="ghost" size="xs" onClick={() => onOpenTerminal(terminalId)}>
                  Open terminal
                </Button>
              ) : null}
            </div>
          }
        >
          Check that it's waiting at its prompt, not asking you something, then send.
        </InspectorNotice>
      );
    case "needs-you":
      return (
        <InspectorNotice
          tone="warning"
          role="status"
          title={`${title} is asking you something`}
          action={open}
        >
          Answer it in the terminal; your request goes in as soon as it's ready.
        </InspectorNotice>
      );
    case "sent": {
      // Observed terminal activity, reported as such — not a claim that the
      // agent is working on this request in particular.
      const working = liveTarget ? isAgentBusy(liveTarget.agentState) : false;
      return (
        <InspectorNotice
          tone="info"
          role="status"
          title={working ? `Sent to ${title} · working` : `Sent to ${title}`}
          action={open}
        >
          The page updates as it saves changes.
        </InspectorNotice>
      );
    }
    case "unconfirmed":
      return (
        <InspectorNotice tone="warning" role="status" title="Delivery unconfirmed" action={open}>
          Check the terminal before sending again, so the agent doesn't get the request twice.
        </InspectorNotice>
      );
    case "failed":
      return (
        <InspectorNotice tone="error" role="alert" title="Couldn't send to the agent" action={open}>
          {state.partial
            ? `${state.message}. Part of the request may already be in the agent's input — check the terminal before sending again.`
            : `${state.message}. Your request is still here.`}
        </InspectorNotice>
      );
  }
}
