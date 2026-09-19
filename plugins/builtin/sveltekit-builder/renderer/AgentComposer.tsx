import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, SquareTerminal } from "lucide-react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { getAgentConfig } from "@/config/agents";
import { BrandMark } from "@/components/icons/BrandMark";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
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
  matchScope,
  isAgentBusy,
  isUnresolvedScope,
  type AgentTarget,
  type TaskScope,
} from "./agentTask.js";
import { ownerFile, type InspectorController, type SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { WaitingRow } from "./WaitingRow.js";
import { useAgentTargets } from "./useAgentTargets.js";
import {
  isSettledDelivery,
  readComposerMemory,
  removeComposerDelivery,
  updateComposerMemory,
  useComposerMemory,
  type ComposerMemory,
  type ComposerPin,
} from "./composerMemory.js";
import { deliverAgentRequest, forceAgentRequest, removeAgentRequest } from "./agentRequest.js";

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

/**
 * A fresh session can be any agent the launcher offers — the host's own list,
 * not a second one kept here. These lead, in the order people most often bring
 * them, and are all that's offered until the host knows what's installed.
 */
const LEADING_AGENTS = ["claude", "codex", "gemini"];

function launchOrder(ids: readonly string[]): string[] {
  const leading = LEADING_AGENTS.filter((id) => ids.includes(id));
  return [...leading, ...ids.filter((id) => !LEADING_AGENTS.includes(id))];
}

/**
 * A suggestion is two things: the words that go into the draft, and a label
 * short enough to read whole in a 280px column.
 *
 * They used to be one string, so the chip showed as much of the instruction as
 * fitted and hid the rest — "Rewrite this copy to be clear…" dropped "and more
 * persuasive", which is a stronger editorial intent than the visible half asks
 * for. A chip must not put words in the agent's mouth that the user could not
 * read before clicking.
 */
interface Intent {
  readonly label: string;
  readonly prompt: string;
}

const ELEMENT_INTENTS: readonly Intent[] = [
  { label: "Clarify the copy", prompt: "Rewrite this copy to be clearer and more persuasive" },
  { label: "Add emphasis", prompt: "Make this stand out more" },
  { label: "Tighten spacing", prompt: "Tighten the spacing" },
  { label: "Fix on mobile", prompt: "Make this look right on mobile" },
];
const COMPONENT_INTENTS: readonly Intent[] = [
  { label: "Polish the design", prompt: "Polish this component's visual design" },
  { label: "Add motion", prompt: "Add a subtle hover and entrance animation" },
  { label: "Make responsive", prompt: "Make this component responsive" },
  { label: "Match the site", prompt: "Match the rest of the site's style" },
];

type Pinned = ComposerPin;

/**
 * Segments while the chain is short enough to read at a glance in the drawer.
 *
 * 30 characters is what fits the control's own width, and the control now gets
 * that width at every drawer size: `PropertyRow` drops its 64px label column
 * below a 340px drawer (see `InspectorSection`), so the 280px floor hands the
 * segments the full content box rather than 184px of it. Before that the
 * budget was a guess about the widest case and the narrow case silently
 * overflowed into an `overflow-hidden` wrapper — which did not truncate a
 * label, it removed a scope the user could no longer reach.
 *
 * Lowering the count instead was tried and reverted: it pushed the ordinary
 * three-step chain (Element / PricingCard / +page.svelte) into the list form,
 * which is a worse control for a chain short enough to see whole.
 */
const MAX_SEGMENTS = 3;
const MAX_SEGMENT_CHARS = 30;

function fitsSegments(scopes: TaskScope[]): boolean {
  if (scopes.length > MAX_SEGMENTS) return false;
  const labels = scopes.map((scope) => (scope.kind === "element" ? "Element" : scope.label));
  return (
    new Set(labels).size === labels.length &&
    labels.reduce((total, label) => total + label.length, 0) <= MAX_SEGMENT_CHARS
  );
}

/** `routes/pricing/+page.svelte:12:4`: enough of the path, and the column, to tell two calls apart. */
function callSiteHint(site: { file: string; line: number; column: number }): string {
  const parts = site.file.split("/");
  return `${parts.slice(-2).join("/")}:${site.line}:${site.column + 1}`;
}

type Destination =
  { kind: "terminal"; target: AgentTarget } | { kind: "launch"; agentId: string; name: string };

type DeliveryRecord = ComposerMemory["deliveries"][number];

/** Said when a request's turn came and the page still couldn't vouch for what it was about. */
const SUBJECT_UNSETTLED =
  "Couldn't confirm this element again after the last change — select it in the page, then send";

/**
 * Hand the selection to an agent — one already running in this worktree, or a
 * fresh session of any agent the launcher offers, on the user's own account — with
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
  const { draft, pinned, chosen, deliveries } = memory;
  const setDraft = (next: string) => updateComposerMemory(memoryKey, { draft: next });
  const setPinned = (next: Pinned | null) => updateComposerMemory(memoryKey, { pinned: next });
  const setChosen = (next: string | null) => updateComposerMemory(memoryKey, { chosen: next });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const launchable: Destination[] = launchOrder(
    availabilityKnown ? LAUNCHABLE_AGENT_IDS : LEADING_AGENTS
  ).flatMap((agentId) => {
    const config = getEffectiveAgentConfig(agentId);
    // The request is typed in only once the agent is seen waiting at its own
    // prompt; an agent with no calibrated prompt detection can't be seen that
    // way, and a quiet sign-in screen would take the request instead.
    if (!config || !config.detection?.promptPatterns?.length) return [];
    // Until availability is known, the leading three are offered; launching a
    // missing CLI opens the host's own setup diagnostic rather than failing.
    if (availabilityKnown && !isAgentLaunchable(availability[agentId])) return [];
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
  // A selection the page proved again after a hot update is the same subject
  // on newer bytes. The draft follows it: left on the old one it would cite
  // revisions that can no longer verify, and offer "use current selection" for
  // the element it is already about.
  const supersedes = selection.status === "ready" ? selection.supersedes : undefined;
  useEffect(() => {
    if (!pinned || !current || !supersedes?.includes(pinned.selection.selectionId)) return;
    // The chosen scope by what it is, not where it sat. One the new chain no
    // longer names leaves the pin alone, and the user is offered the current
    // selection.
    const scope = matchScope(
      scopesFor(pinned.selection, pinned.picked, pinned.definitions).scopes[pinned.scope],
      scopesFor(current.selection, current.picked, current.definitions).scopes
    );
    if (scope < 0) return;
    setPinned({ ...current, scope });
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
  const needsScopeChoice = scopeUnproven && !scopePending;
  // A selection the page or its source has moved past can't vouch for the
  // locations a request would name.
  const subjectStale =
    subject !== null &&
    selection.status === "ready" &&
    selection.stale !== null &&
    selection.selection.selectionId === subject.selection.selectionId;
  // `busy` is deliberately NOT a gate. It comes from passive PTY output
  // heuristics, which are frequently wrong, and the note beside the button
  // already says what was seen. Blocking on it made a wrong guess
  // unrecoverable: the advice was to check the terminal, but checking it
  // cannot clear a heuristic that is stuck, so a finished agent could strand a
  // written request with no way to send it. Nor is a request already on its
  // way: the next one queues behind it and goes in when the agent is back at
  // its prompt. The real safeguards — an unproven scope, a stale subject — are
  // things the host can prove.
  // A request that failed part-way, or that the host couldn't confirm, may be
  // sitting in the agent's input — and whatever is typed next is appended to
  // it. Its notice says to check the terminal first; sending stays off until
  // the user has answered that notice, by sending it again or dismissing it.
  const uncertain = deliveries.some(
    (delivery) =>
      delivery.state.status === "unconfirmed" ||
      (delivery.state.status === "failed" && delivery.state.partial === true)
  );
  const canSend = Boolean(
    subject &&
    activeScope &&
    destination &&
    draft.trim() &&
    !uncertain &&
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

  /**
   * Put one request in the queue. What it is about is settled when its turn
   * comes, not now: the request ahead of it has usually just edited the same
   * file, and the page proves the selection again after that. The request
   * follows that proof — same element, same scope, newer bytes — and is held to
   * the selection it was made about only when nothing live stands for it.
   */
  const enqueue = (instruction: string, made: Pinned, target: Destination) => {
    const madeScopes = scopesFor(made.selection, made.picked, made.definitions).scopes;
    const resolve = (): { about: Pinned; scope: TaskScope | undefined } | "pending" => {
      const followed = controller.followSelection(made.selection.selectionId);
      if (followed === "pending") return "pending";
      if (followed !== null) {
        const scopes = scopesFor(followed.selection, followed.picked, followed.definitions).scopes;
        const scope = matchScope(madeScopes[made.scope], scopes);
        if (scope >= 0) return { about: { ...followed, scope }, scope: scopes[scope] };
      }
      return { about: made, scope: madeScopes[made.scope] };
    };
    let checked: { about: Pinned; scope: TaskScope | undefined } | null = null;
    let builtFor: string | null = null;
    void deliverAgentRequest({
      memoryKey,
      worktreeId,
      sentDraft: instruction,
      subject: made,
      // What the prompt is about, beside the words: the same sentence aimed at
      // another element, another scope, or bytes that have since changed builds
      // a different prompt, so it must not be folded into a run already going.
      subjectKey: `${made.selection.selectionId}\n${made.scope}\n${JSON.stringify(made.revisions)}`,
      destination:
        target.kind === "terminal"
          ? { kind: "terminal", terminalId: target.target.terminalId, title: target.target.title }
          : { kind: "launch", agentId: target.agentId, title: target.name },
      settled: () => resolve() !== "pending",
      // Locations in the prompt are only true of the bytes they were read from,
      // and an agent can take minutes to reach its prompt. Checked right before
      // the request goes in; its words stay on its row either way.
      // One subject per attempt: what the check vouched for is what the
      // prompt is built from, and the check after building is about that same
      // prompt. Resolving afresh each time let a selection proved again in
      // between put one element's locations under another's revisions.
      verify: async (after) => {
        const now = resolve();
        if (now === "pending") return SUBJECT_UNSETTLED;
        if (after === "built" && builtFor !== now.about.selection.selectionId) return STALE_SOURCE;
        if (!(await controller.sourcesUnchanged(now.about.selection, now.about.revisions))) {
          return STALE_SOURCE;
        }
        if (after !== "built") checked = now;
        return null;
      },
      buildPrompt: async () => {
        const now = checked ?? { about: made, scope: madeScopes[made.scope] };
        builtFor = now.about.selection.selectionId;
        return buildAgentTaskPrompt({
          instruction,
          selection: now.about.selection,
          file: now.about.file,
          worktreePath,
          place: await controller.pagePlace(now.about.selection),
          scope: now.scope,
        });
      },
    });
  };

  const send = () => {
    if (!subject || !destination || !canSend) return;
    enqueue(draft, { ...subject, definitions, revisions }, destination);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  // A request that finished uncertain, or failed, is over: the only way to send
  // it again is a new one, made about what it was about, which the user asks
  // for by name after looking at the terminal.
  // The words left the field when the request was accepted; a request that
  // didn't go in hands them back, to be changed or aimed somewhere else.
  const editAgain = (record: DeliveryRecord) => {
    removeComposerDelivery(memoryKey, record.id);
    setDraft(record.instruction);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const sendAgain = destination
    ? (record: DeliveryRecord) => {
        if (record.subject === null) return;
        removeComposerDelivery(memoryKey, record.id);
        enqueue(record.instruction, record.subject, destination);
      }
    : undefined;
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
  const queue =
    deliveries.length > 0 ? (
      <DeliveryQueue
        deliveries={deliveries}
        targets={targets}
        onOpenTerminal={openTerminal}
        onReviewChanges={reviewChanges}
        onSendNow={(id) => forceAgentRequest(memoryKey, id)}
        onRemove={(id) => removeAgentRequest(memoryKey, id)}
        onSendAgain={sendAgain}
        // Into an empty field only: it must never replace what is being written.
        onEditAgain={draft.trim() ? undefined : editAgain}
        onDismiss={(id) => removeComposerDelivery(memoryKey, id)}
      />
    ) : null;

  if (!subject) return queue;

  return (
    // `role="group"` is what makes the label count: an `aria-label` on a bare
    // div is ignored, so the composer had no accessible grouping at all once
    // its visible header went. This restores the name without drawing one.
    <div role="group" aria-label="Ask an agent" className="flex flex-col gap-2">
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
          {fitsSegments(scopes) ? (
            // The same segmented control the strip uses for Browse/Select: one
            // choice among peers, with the chosen one carried by a thumb rather
            // than by the others going bare. Its thumb needs stable geometry so
            // the control does not shrink; the wrapper keeps any overflow
            // inside the column instead of past the drawer's edge.
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
                // 28px, matching the destination picker in the footer and the
                // property rows above: a 24px track read as a different kind of
                // control sitting in the same column.
                className="h-7 max-w-full"
              />
            </div>
          ) : (
            // A real component chain runs deeper than a row of segments can
            // show, and repeats names (two `Card`s): a list, where each scope
            // carries the call site that tells it apart.
            <Select
              value={String(subject.scope)}
              onValueChange={(value) => chooseScope(Number(value))}
            >
              <SelectTrigger
                aria-label="What the request is about"
                className="h-7 min-w-0 flex-1 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                {scopes.map((scope, index) => (
                  <SelectItem
                    key={index}
                    value={String(index)}
                    title={scope.kind === "component" ? (scope.file ?? undefined) : undefined}
                  >
                    {/* Two lines, so the call site that tells two `Card`s apart
                        is never the part a narrow drawer clips. */}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {scope.kind === "element" ? "Element" : scope.label}
                      </span>
                      {scope.kind === "component" && scope.usedAt ? (
                        <span className="truncate font-mono text-3xs text-text-secondary">
                          {`${callSiteHint(scope.usedAt)}`}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

      {/* The composer's own action footer: where the request is going on the
          left, the trigger that sends it on the right, on one baseline — so
          "which agent gets this" is read in the same glance as Send rather
          than in a labelled row three controls further up.

          A footer row rather than a button floating inside the field: the
          plate overlapped the text, its focus ring met the field's border, and
          it was the brightest object in the drawer while being its lightest
          action. Fixed height, always present, so the drawer does not jump as
          the draft fills.
          `contrast`, not `default`: the house rule reserves accent for a single
          load-bearing signal per focus region, and the field's focus ring is
          already spending it. */}
      <div className="flex h-8 items-center justify-between gap-2">
        {destinations.length > 0 ? (
          <Select value={destination ? keyOf(destination) : ""} onValueChange={setChosen}>
            {/* Quiet by construction: a bordered field here would read as a
                second input beside the one above it, and would out-weigh Send.
                It carries the agent's own mark, so the destination is legible
                before the title is read.

                `border-transparent`, never `border-0`: this control's focus
                indicator IS its border (the house recipe is "border-shift, no
                ring"), so removing the border removes the only thing that shows
                it focused — and keeping it transparent also stops the row
                shifting by 2px when it takes focus.

                The `[&>span]` overrides undo the trigger's own `line-clamp-1`,
                which switches the value to a `-webkit-box` and drops the mark
                off the text's baseline. */}
            <SelectTrigger
              aria-label="Agent to send to"
              className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-xs hover:bg-overlay-subtle [&>span]:flex [&>span]:min-w-0 [&>span]:items-center"
            >
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            {/* Wider than its trigger, capped at 20rem. Trigger-width was right
                when the trigger was a full-width row; in the footer it is about
                200px, and two claude sessions in one worktree are told apart by
                the tail of their titles — exactly what that width cut off. The
                cap is what keeps it from spilling past the drawer's left gutter,
                and the available-width clamp keeps it inside the window when the
                panel is tiled narrow. */}
            <SelectContent className="w-[min(20rem,var(--radix-select-content-available-width))] min-w-[var(--radix-select-trigger-width)]">
              {targets.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Running in this worktree</SelectLabel>
                  {targets.map((target) => (
                    <SelectItem
                      key={target.terminalId}
                      value={`terminal:${target.terminalId}`}
                      title={target.title}
                    >
                      <DestinationLabel agentId={target.agentId} label={target.title} />
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
                        <DestinationLabel agentId={option.agentId} label={`New ${option.name}`} />
                      </SelectItem>
                    ) : null
                  )}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        ) : (
          <span />
        )}
        <Button
          variant="contrast"
          size="xs"
          disabled={!canSend}
          onClick={() => send()}
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

      {queue}

      {/* Shown, not hidden behind an "Ideas" toggle. They are the starting
          points for the one thing this panel does, and a disclosure made the
          panel's primary affordance cost a click to discover. Below the footer,
          so revealing or spending them never moves Send under the pointer.
          Not beside the queue: suggestions under "Sent to claude" read as a
          leftover. */}
      {!draft.trim() && deliveries.length === 0 ? (
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
              key={intent.label}
              variant="pill"
              size="xs"
              // The words that will actually land in the draft, for anyone who
              // wants them before committing.
              title={intent.prompt}
              className="min-w-0 justify-start font-normal text-text-secondary"
              onClick={() => applyIntent(intent.prompt)}
            >
              <span className="truncate">{intent.label}</span>
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
          Install an agent CLI, such as Claude Code, Codex or Gemini, to send requests with your own
          account
        </p>
      ) : uncertain && draft.trim() ? (
        <p className="text-xs text-text-secondary">
          Check the terminal, then dismiss the notice above to send this
        </p>
      ) : busy && destination?.kind === "terminal" ? (
        // A heads-up, not a gate. Sending is still armed — this says what the
        // terminal looked like, and leaves the call to the person who can
        // actually look at it.
        <p className="text-xs text-text-secondary">
          {`Activity in ${destination.target.title} — your request will wait its turn`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A destination, wearing the CLI's own mark.
 *
 * Radix clones the selected item's children into the trigger, so rendering the
 * mark here is what puts it on the closed control too — the destination is
 * identifiable before its session title is read, which is the whole point in a
 * worktree running two of them. `BrandMark` owns the ink: the glyph itself
 * stays on `currentColor` and the theme decides what a third-party logo is
 * allowed to look like on this backdrop.
 *
 * An agent the host can't name still gets a slot in the same column — a mark
 * that sometimes vanishes would make the titles beside it disagree about where
 * they start.
 */
function DestinationLabel({ agentId, label }: { agentId: string | null; label: string }) {
  const config = agentId ? getAgentConfig(agentId) : null;
  const Icon = config?.icon;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {Icon && config ? (
        <BrandMark brandColor={config.color}>
          <Icon size={14} className="shrink-0" />
        </BrandMark>
      ) : (
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/**
 * Every request this composer has made, oldest first: gone, going in, and
 * waiting. Sending while the agent is busy used to be one notice that the next
 * send replaced, and a warning that nothing could be seen of the agent. A
 * request now joins the end and says it is queued — which is what is happening
 * — and goes in by itself when the agent is back at its prompt.
 *
 * What needs the user keeps its notice: a prompt the agent is asking, a
 * delivery the host couldn't confirm, a failure. The newest sent request keeps
 * its notice too, with where to look next. Everything else is a row, opened to
 * read what was — or will be — sent.
 */
function DeliveryQueue({
  deliveries,
  targets,
  ...handlers
}: {
  deliveries: DeliveryRecord[];
  targets: AgentTarget[];
} & DeliveryHandlers) {
  // Only the request at the head can be pushed on: order is what a queue is for.
  const head = deliveries.find((delivery) => !isSettledDelivery(delivery))?.id;
  const newestSent = deliveries.filter((delivery) => delivery.state.status === "sent").at(-1)?.id;
  return (
    <ul aria-label="Requests" className="flex flex-col gap-1.5">
      {deliveries.map((delivery) => (
        <DeliveryItem
          key={delivery.id}
          delivery={delivery}
          isHead={delivery.id === head}
          isNewestSent={delivery.id === newestSent}
          liveTarget={
            delivery.terminalId
              ? targets.find((target) => target.terminalId === delivery.terminalId)
              : undefined
          }
          {...handlers}
        />
      ))}
    </ul>
  );
}

interface DeliveryHandlers {
  onOpenTerminal: (terminalId: string) => void;
  onReviewChanges: () => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onSendAgain: ((delivery: DeliveryRecord) => void) | undefined;
  onEditAgain: ((delivery: DeliveryRecord) => void) | undefined;
  onDismiss: (id: string) => void;
}

/**
 * One request, for as long as it is on show. It is one component through every
 * state it passes — queued, going in, sent — so that a row opened to read what
 * is waiting stays open when that request's turn comes, rather than shutting
 * because a different component took its place.
 */
function DeliveryItem({
  delivery,
  isHead,
  isNewestSent,
  liveTarget,
  onOpenTerminal,
  onReviewChanges,
  onSendNow,
  onRemove,
  onSendAgain,
  onEditAgain,
  onDismiss,
}: {
  delivery: DeliveryRecord;
  isHead: boolean;
  isNewestSent: boolean;
  liveTarget: AgentTarget | undefined;
} & DeliveryHandlers) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((value) => !value);
  const { status } = delivery.state;
  // What was typed into the agent once that exists; the user's words until then.
  const text = delivery.request ?? delivery.instruction;
  let body: ReactNode;
  if (status === "queued") {
    body = (
      <RequestRow
        label={`Queued for ${delivery.title}`}
        words={delivery.instruction}
        text={text}
        open={open}
        onToggle={toggle}
        actions={
          <>
            {isHead ? (
              <Button variant="subtle" size="xs" onClick={() => onSendNow(delivery.id)}>
                Send now
              </Button>
            ) : null}
            <Button variant="subtle" size="xs" onClick={() => onRemove(delivery.id)}>
              Remove
            </Button>
          </>
        }
      >
        {isHead
          ? "Goes in when the agent is back at its prompt."
          : "Goes in after the requests ahead of it."}
      </RequestRow>
    );
  } else if (status === "sent" && !isNewestSent) {
    body = (
      <RequestRow
        label={`Sent to ${delivery.title}`}
        words={delivery.instruction}
        text={text}
        open={open}
        onToggle={toggle}
        actions={
          <Button variant="subtle" size="xs" onClick={() => onDismiss(delivery.id)}>
            Dismiss
          </Button>
        }
      />
    );
  } else {
    // The record sits beside the notice, not inside it: a status region is
    // read out whole on every change, and nobody should hear a prompt recited.
    const settled = status === "sent" || status === "unconfirmed" || status === "failed";
    body = (
      <>
        <DeliveryStatus
          delivery={delivery}
          liveTarget={liveTarget}
          onOpenTerminal={onOpenTerminal}
          onReviewChanges={onReviewChanges}
          onSendAgain={
            onSendAgain && delivery.subject !== null ? () => onSendAgain(delivery) : undefined
          }
          onEditAgain={onEditAgain ? () => onEditAgain(delivery) : undefined}
          onDismiss={() => onDismiss(delivery.id)}
        />
        {settled ? <RequestRecord text={text} open={open} onToggle={toggle} /> : null}
      </>
    );
  }
  return <li className="flex flex-col gap-1">{body}</li>;
}

/**
 * One request as a line: what state it is in, and the user's own words. Opened,
 * it shows the full text and what can be done about it.
 */
function RequestRow({
  label,
  words,
  text,
  open,
  onToggle,
  actions,
  children,
}: {
  label: string;
  words: string;
  text: string;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="-mx-1 flex min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
            open && "rotate-90"
          )}
        />
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate text-text-primary">{words}</span>
      </button>
      {open ? (
        <div id={id} role="group" aria-label="Request text" className="flex flex-col gap-1.5">
          <RequestText text={text} />
          {children ? <p className="text-3xs text-text-secondary">{children}</p> : null}
          {actions ? <div className="flex flex-wrap gap-1">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function RequestText({ text }: { text: string }) {
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-surface-inset px-2 py-1.5 font-mono text-3xs leading-relaxed text-text-secondary">
      {text}
    </pre>
  );
}

/** What the agent was actually told — the words, the files and the route, as typed in. */
function RequestRecord({
  text,
  open,
  onToggle,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="-ml-1 flex w-fit items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-3xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("h-3 w-3 transition-transform duration-150 ease-out", open && "rotate-90")}
        />
        View request
      </button>
      {open ? (
        <div id={id} role="group" aria-label="Request text">
          <RequestText text={text} />
        </div>
      ) : null}
    </div>
  );
}

function DeliveryStatus({
  delivery,
  liveTarget,
  onOpenTerminal,
  onReviewChanges,
  onSendAgain,
  onEditAgain,
  onDismiss,
}: {
  delivery: DeliveryRecord;
  liveTarget: AgentTarget | undefined;
  onOpenTerminal: (terminalId: string) => void;
  onReviewChanges: () => void;
  onSendAgain: (() => void) | undefined;
  onEditAgain: (() => void) | undefined;
  onDismiss: () => void;
}) {
  const { state, title, terminalId } = delivery;
  const sendAgain = onSendAgain ? (
    <Button variant="subtle" size="xs" onClick={onSendAgain}>
      Send it again
    </Button>
  ) : null;
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
    // Drawn as a row by the queue; never reaches a notice.
    case "queued":
      return null;
    case "needs-you":
      return (
        <InspectorNotice
          tone="warning"
          role="status"
          // What was seen, not what it means. "May be waiting for an answer" is
          // a reading of the pattern that matched; the pattern itself is the
          // only thing the host can vouch for.
          title={`Prompt detected in ${title}`}
          action={open}
        >
          If it's asking you something, answer it there; your request goes in once it's ready.
        </InspectorNotice>
      );
    case "sent": {
      // Terminal activity, which is not evidence that the agent is working on
      // THIS request — or on anything. The title used to read
      // "Sent to X · working", and a reader takes that as confirmation the
      // delivery was picked up. The one thing proven here is the send, so that
      // is what the headline says; the observation goes below it, named as an
      // observation.
      const active = liveTarget ? isAgentBusy(liveTarget.agentState) : false;
      return (
        <InspectorNotice
          onDismiss={dismiss}
          tone="info"
          role="status"
          title={`Sent to ${title}`}
          action={open}
        >
          {/* Present tense, and no "since": `agentState` is a reading of the
              terminal RIGHT NOW, not a comparison against how it looked before
              the send. "There's been activity since" asserts a chronology
              nothing here established — a busy classification that simply
              carried across the send would have told the same story. */}
          {active ? "The terminal is showing activity. " : ""}
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
          action={
            <div className="flex flex-wrap gap-1">
              {terminalId ? (
                <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
                  Open terminal
                </Button>
              ) : null}
              {sendAgain}
            </div>
          }
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
                {sendAgain}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {onEditAgain ? (
                  <Button variant="subtle" size="xs" onClick={onEditAgain}>
                    Edit request
                  </Button>
                ) : null}
                {terminalId ? (
                  <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
                    Open terminal
                  </Button>
                ) : null}
              </div>
            )
          }
        >
          {state.partial
            ? `${state.message}. Part of the request may already be in the agent's input — check the terminal before sending again.`
            : `${state.message}. Nothing was typed into the agent.`}
        </InspectorNotice>
      );
  }
}
