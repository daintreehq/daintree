import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, Lightbulb } from "lucide-react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
import { cn } from "@/lib/utils";
import { PropertyRow } from "./InspectorSection.js";
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
  const deliveryDismissed = memory.deliveryDismissed === true;
  const setDraft = (next: string) => updateComposerMemory(memoryKey, { draft: next });
  const setPinned = (next: Pinned | null) => updateComposerMemory(memoryKey, { pinned: next });
  const setChosen = (next: string | null) => updateComposerMemory(memoryKey, { chosen: next });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const [ideasOpen, setIdeasOpen] = useState(false);

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
  // A delivery that failed part-way has already put some of the prompt into the
  // agent's input, and the notice says to check the terminal before sending
  // again. Leaving Enter armed contradicts that in the one state where sending
  // twice is genuinely harmful, so the second send has to be asked for.
  const blockedByPartial = delivery?.state.status === "failed" && delivery.state.partial === true;
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
    !blockedByPartial &&
    revisions !== null
  );

  const onDraftChange = (next: string) => {
    // Editing the request after a partial delivery is the acknowledgement: the
    // user has been told to check the terminal and has come back to the words.
    if (blockedByPartial && next !== draft) {
      updateComposerMemory(memoryKey, { delivery: null, deliveryDismissed: false });
    }
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
  // Dismiss hides the notice; it does not decide that the half-delivered request
  // is safe to send again. Those were the same act, so closing the warning
  // rearmed Enter on the unchanged draft — the guard's own escape hatch.
  const dismissDelivery = () => {
    if (delivery?.state.status === "failed" && delivery.state.partial === true) {
      updateComposerMemory(memoryKey, { deliveryDismissed: true });
      return;
    }
    updateComposerMemory(memoryKey, { delivery: null });
  };
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
    return delivery && !deliveryDismissed ? (
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
    <div aria-label="Ask an agent" className="flex flex-col gap-2">
      {destinations.length > 0 ? (
        <PropertyRow label="Agent">
          <Select value={destination ? keyOf(destination) : ""} onValueChange={setChosen}>
            {/* Full width, not a 180px stub: the session name is how two claudes
                in the same worktree are told apart, and it was truncating to
                `claude · pricing polis…` beside 280px of empty row. */}
            <SelectTrigger aria-label="Agent to send to" className="h-7 min-w-0 flex-1 text-xs">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            {/* As wide as its trigger: session titles run long, and a menu
                sized to them spilled past the drawer's left gutter. */}
            <SelectContent className="w-[var(--radix-select-trigger-width)]">
              {targets.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Running in this worktree</SelectLabel>
                  {targets.map((target) => (
                    <SelectItem
                      key={target.terminalId}
                      value={`terminal:${target.terminalId}`}
                      title={target.title}
                    >
                      <span className="block truncate">{target.title}</span>
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
        </PropertyRow>
      ) : null}

      {retargetable && current ? (
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-text-secondary" title={subjectLabel}>
            {`Still about ${subjectLabel}`}
          </span>
          <Button variant="ghost" size="xs" onClick={() => setPinned(current)}>
            Use current selection
          </Button>
        </div>
      ) : null}

      {needsScopeChoice && activeScope?.kind === "component" ? (
        <p className="text-xs text-text-secondary">
          {`Couldn't find where ${activeScope.label} is written — choose what this is about`}
        </p>
      ) : null}

      {scopes.length > 1 ? (
        <PropertyRow label="About" align="start">
          {/* The same segmented control the strip uses for Browse/Select: one
              choice among peers, with the chosen one carried by a thumb rather
              than by the others going bare. Its thumb needs stable geometry so
              the control does not shrink; the wrapper keeps any overflow
              inside the column instead of past the drawer's edge. */}
          <div className="w-fit min-w-0 max-w-full overflow-hidden">
            <SegmentedToggle
              density="compact"
              options={scopes.map((scope, index) => ({
                value: String(index),
                label: scope.kind === "element" ? "Element" : scope.label,
                // The file main resolved for the component, once it has: a scope
                // is a promise about where the request will land.
                ...(scope.kind === "component" && scope.file ? { title: scope.file } : {}),
              }))}
              value={String(subject.scope)}
              onChange={(value) => chooseScope(Number(value))}
              // The select above it is 28px; a 24px track in the next row read
              // as a different kind of control.
              className="h-7 max-w-full"
            />
          </div>
        </PropertyRow>
      ) : null}

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
        className="placeholder:text-text-secondary"
      />

      {/* A footer row rather than a button floating inside the field: the
          plate overlapped the text, its focus ring met the field's border, and
          it was the brightest object in the drawer while being its lightest
          action. Ideas sits at the left of the same row, so the row is always
          there and the drawer's height no longer jumps as the draft fills.
          `contrast`, not `default`: the house rule reserves accent for a single
          load-bearing signal per focus region, and the class input's focus ring
          is already spending it. */}
      <div className="flex h-8 items-center justify-between gap-2">
        {!draft.trim() && !(delivery && !deliveryDismissed) ? (
          <button
            type="button"
            aria-expanded={ideasOpen}
            aria-controls={`${inputId}-ideas`}
            onClick={() => setIdeasOpen((open) => !open)}
            className="-ml-1 flex h-6 items-center gap-1 rounded-[var(--radius-sm)] px-1 text-3xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
          >
            <Lightbulb className="h-3 w-3" aria-hidden="true" />
            Ideas
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 transition-transform duration-150 ease-out",
                ideasOpen && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span />
        )}
        <Button
          variant="contrast"
          size="xs"
          disabled={!canSend}
          onClick={send}
          aria-label="Send to agent"
          title="Send to agent (Enter)"
          // Disabled is quiet, not faded: a faded contrast fill is still the
          // heaviest object in the drawer (and white-on-grey on a light theme).
          className="gap-1.5 disabled:bg-overlay-subtle disabled:text-text-secondary disabled:opacity-100 disabled:shadow-none disabled:ring-0"
        >
          Send
          <kbd className={cn(KBD_COMPACT_CLASS, "bg-transparent text-inherit opacity-70")}>⏎</kbd>
        </Button>
      </div>

      {delivery && !deliveryDismissed ? (
        <DeliveryNotice
          delivery={delivery}
          liveTarget={liveTarget}
          onOpenTerminal={openTerminal}
          onReviewChanges={reviewChanges}
          onSendAnyway={sendAnyway}
          onDismiss={dismissDelivery}
        />
      ) : null}

      {/* Not beside a delivery notice: an "Ideas" prompt under "Sent to claude"
          read as a leftover, and the row appearing and vanishing as the draft
          filled made the panel's height jump. */}
      {!draft.trim() && ideasOpen && !(delivery && !deliveryDismissed) ? (
        <div
          id={`${inputId}-ideas`}
          role="group"
          aria-label="Suggestions"
          className="grid grid-cols-2 gap-1"
        >
          {/* The shared pill variant, not a hand-rolled one: these sat beside the
              scope chips and the class tokens as a third geometry for the same
              idea. Prose, so proportional — the class tokens stay monospace
              because they are code. */}
          {intents.map((intent) => (
            <Button
              key={intent}
              variant="pill"
              size="xs"
              title={intent}
              className="min-w-0 justify-start font-normal text-text-secondary"
              onClick={() => applyIntent(intent)}
            >
              <span className="truncate">{intent}</span>
            </Button>
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
          {`Activity in ${destination.target.title} — check the terminal before sending`}
        </p>
      ) : null}
    </div>
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
  // Dismiss is the notice's own corner control rather than a third button in
  // the row: three subtle buttons wrapped to two ragged lines in a 360px drawer.
  const open = (
    <div className="flex flex-wrap gap-1">
      {terminalId ? (
        <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
          Open terminal
        </Button>
      ) : null}
      {state.status === "sent" ? (
        <Button variant="subtle" size="xs" onClick={onReviewChanges}>
          View worktree changes
        </Button>
      ) : null}
    </div>
  );
  const dismiss = settled ? onDismiss : undefined;
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
          title={`No sign yet whether ${title} can take input`}
          action={
            <div className="flex flex-wrap gap-1">
              <Button variant="subtle" size="xs" onClick={onSendAnyway}>
                Send anyway
              </Button>
              {terminalId ? (
                <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
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
          title={`${title} may be waiting for an answer`}
          action={open}
        >
          A prompt was detected in the terminal. Answer it there; your request goes in once it's
          ready.
        </InspectorNotice>
      );
    case "sent": {
      // Observed terminal activity, reported as such — not a claim that the
      // agent is working on this request in particular.
      const working = liveTarget ? isAgentBusy(liveTarget.agentState) : false;
      return (
        <InspectorNotice
          onDismiss={dismiss}
          tone="info"
          role="status"
          title={working ? `Sent to ${title} · working` : `Sent to ${title}`}
          action={open}
        >
          File changes it saves appear in the preview.
        </InspectorNotice>
      );
    }
    case "unconfirmed":
      return (
        <InspectorNotice
          onDismiss={dismiss}
          tone="warning"
          role="status"
          title="Delivery unconfirmed"
          action={open}
        >
          Check the terminal before sending again, so the agent doesn't get the request twice.
        </InspectorNotice>
      );
    case "failed":
      return (
        <InspectorNotice
          onDismiss={dismiss}
          tone="error"
          role="alert"
          title="Couldn't send to the agent"
          action={
            state.partial ? (
              <div className="flex flex-wrap gap-1">
                {terminalId ? (
                  <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
                    Open terminal
                  </Button>
                ) : null}
                <Button variant="subtle" size="xs" onClick={onSendAnyway}>
                  Send it again
                </Button>
              </div>
            ) : (
              open
            )
          }
        >
          {state.partial
            ? `${state.message}. Part of the request may already be in the agent's input — check the terminal before sending again.`
            : `${state.message}. Your request is still here.`}
        </InspectorNotice>
      );
  }
}
