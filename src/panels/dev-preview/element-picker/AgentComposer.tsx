import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronRight, Clock, Pencil, RefreshCw, SquareTerminal } from "lucide-react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { getAgentConfig } from "@/config/agents";
import { BrandMark } from "@/components/icons/BrandMark";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { Spinner } from "@/components/ui/Spinner";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { useDeferredLoading, useDohertyGate } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import type { ProjectContextOutcome } from "@shared/elementPicker";
import { PropertyRow, SectionHeader } from "./InspectorSection.js";
import { SourcePath } from "./SelectionCard.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MAX_INSTRUCTION_CHARS, isAgentBusy, type AgentTarget } from "./agentTask.js";
import { buildAgentTaskPrompt, promptInventory, type PromptInventory } from "./agentPrompt.js";
import {
  elementLabel,
  isUnresolvedScope,
  matchScope,
  primaryObservation,
  promptInputFor,
  scopePlace,
  scopesFor,
  type PageScreenshot,
  type PickedSelection,
  type TaskScope,
} from "./selection.js";
import type { InspectorController, SelectionState } from "./inspectorController.js";
import { REPROVING_NOTE, STALE_COPY, missingComponentSource } from "./copy.js";
import { useAgentTargets } from "./useAgentTargets.js";
import {
  isSettledDelivery,
  isUncertainDelivery,
  removeComposerDelivery,
  updateComposerMemory,
  useComposerMemory,
  type ComposerMemory,
  type ComposerPin,
} from "./composerMemory.js";
import { deliverAgentRequest, forceAgentRequest, removeAgentRequest } from "./agentRequest.js";

const STALE_SOURCE =
  "The source changed since you picked this — select it again in the page, then send";

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
 * A suggestion is exactly the words it puts in the draft.
 *
 * They used to be a short label over a longer instruction, and the instruction
 * said more than the label: "Clarify the copy" typed "Rewrite this copy to be
 * clearer and more persuasive", an editorial call the user could only read in
 * a tooltip. Now what the chip shows is what the agent gets.
 *
 * And they follow what was picked. A copy suggestion on an image, or a canvas,
 * asked for something the element can't have; each kind of element gets the
 * changes people make to that kind, and a component or a route file gets its own.
 */
const SUGGESTIONS = {
  text: ["Make it stand out", "Make it easier to read", "Tighten the spacing", "Fix it on mobile"],
  control: ["Make it stand out", "Add a hover state", "Tighten the spacing", "Fix it on mobile"],
  media: [
    "Make it responsive",
    "Fix the crop on mobile",
    "Round the corners",
    "Add space around it",
  ],
  layout: ["Tighten the spacing", "Align the contents", "Fix it on mobile", "Make it stand out"],
  component: [
    "Polish the design",
    "Make it responsive",
    "Add a hover state",
    "Match the rest of the site",
  ],
  file: [
    "Tighten the layout",
    "Fix the page on mobile",
    "Polish the design",
    "Match the rest of the site",
  ],
} as const;

const CONTROL_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL"]);
const MEDIA_TAGS = new Set(["IMG", "PICTURE", "SVG", "VIDEO", "CANVAS", "IFRAME", "FIGURE"]);
const TEXT_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "SPAN",
  "LI",
  "BLOCKQUOTE",
  "STRONG",
  "EM",
  "SMALL",
  "FIGCAPTION",
  "DT",
  "DD",
  "TD",
  "TH",
  "CAPTION",
  "LEGEND",
  "CODE",
  "PRE",
]);

function suggestionsFor(
  scope: TaskScope | undefined,
  tagName: string | undefined
): readonly string[] {
  if (scope?.kind === "component") return SUGGESTIONS.component;
  if (scope?.kind === "file") return SUGGESTIONS.file;
  const tag = (tagName ?? "").toUpperCase();
  if (CONTROL_TAGS.has(tag)) return SUGGESTIONS.control;
  if (MEDIA_TAGS.has(tag)) return SUGGESTIONS.media;
  if (TEXT_TAGS.has(tag)) return SUGGESTIONS.text;
  return SUGGESTIONS.layout;
}

type Pinned = ComposerPin;

/**
 * Segments while the chain is short enough to read at a glance in the drawer.
 *
 * 30 characters is what fits the control's own width, and the control now gets
 * that width at every drawer size: `PropertyRow` drops its 48px label column
 * below a 340px drawer (see `InspectorSection`), so the 280px floor hands the
 * segments the full content box rather than 200px of it. Before that the
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

/**
 * `routes/pricing/+page.svelte:12`: enough of the path to tell two calls
 * apart. The page's own line, which every runtime counts from one; columns it
 * counts from either, so they are left out rather than shown a place off.
 */
function callSiteHint(site: { file: string; line: number }): string {
  const parts = site.file.split("/");
  return `${parts.slice(-2).join("/")}:${site.line}`;
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
 * the source identity the picker resolved. The terminal stays the agent: this
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
  // Stable: two effects below take it as a dependency, and a fresh identity
  // each render would make their dependency arrays meaningless.
  const setPinned = useCallback(
    (next: Pinned | null) => updateComposerMemory(memoryKey, { pinned: next }),
    [memoryKey]
  );
  const setChosen = (next: string | null) => updateComposerMemory(memoryKey, { chosen: next });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const noteId = useId();

  const launchable: Destination[] = launchOrder(
    availabilityKnown ? BUILT_IN_AGENT_IDS : LEADING_AGENTS
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
    destination.kind === "launch"
      ? `launch:${destination.agentId}`
      : `terminal:${destination.target.terminalId}`;
  // Once the user has committed to an agent, never swap it for another behind
  // their back: a vanished choice blocks sending until they pick again.
  const committed =
    chosen === null ? undefined : destinations.find((candidate) => keyOf(candidate) === chosen);
  const destination = chosen === null ? destinations[0] : committed;
  const destinationGone = chosen !== null && committed === undefined;

  // Memoised so the effects below can depend on it: `selection` is the
  // controller's own snapshot and only changes when the controller publishes.
  const current: Pinned | null = useMemo(
    () =>
      selection.status === "ready"
        ? // A component picked on the page is what the request is about.
          { selection: selection.selection, scope: scopesFor(selection.selection).pickedIndex }
        : null,
    [selection]
  );
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
      scopesFor(pinned.selection).scopes[pinned.scope],
      scopesFor(current.selection).scopes
    );
    if (scope < 0) return;
    setPinned({ ...current, scope });
  }, [pinned, current, supersedes, setPinned]);
  const scopes = subject ? scopesFor(subject.selection).scopes : [];
  // Read once per subject and shared by the preview and the send, so what the
  // user opened is what an immediate request is built from.
  const material = useRequestMaterial(controller, subject?.selection ?? null);
  const announcement = useDeliveryAnnouncement(deliveries);
  const activeScope = subject ? scopes[subject.scope] : undefined;
  const scopeUnproven = isUnresolvedScope(activeScope);
  const chooseScope = (scope: number) => {
    if (pinned) setPinned({ ...pinned, scope });
    else if (current) setUnpinnedScope({ selectionId: current.selection.selectionId, scope });
  };

  const busy =
    destination?.kind === "terminal" ? isAgentBusy(destination.target.agentState) : false;
  // A selection the page or its source has moved past can't vouch for the
  // locations a request would name.
  const staleSelection =
    subject !== null &&
    selection.status === "ready" &&
    selection.stale !== null &&
    selection.selection.selectionId === subject.selection.selectionId
      ? { reason: selection.stale, reproving: selection.reproving === true }
      : null;
  const subjectStale = staleSelection !== null;
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
  // it. Its row says to check the terminal first; sending stays off until the
  // user has answered that row, by retrying it or dismissing it.
  const uncertainCount = deliveries.filter(isUncertainDelivery).length;
  const uncertain = uncertainCount > 0;
  const canSend = Boolean(
    subject &&
    activeScope &&
    destination &&
    draft.trim() &&
    !uncertain &&
    !scopeUnproven &&
    !subjectStale
  );

  const onDraftChange = (next: string) => {
    setDraft(next);
    if (next.trim() && chosen === null && destination) setChosen(keyOf(destination));
    if (next.trim() && !pinned && subject) setPinned(subject);
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
  const enqueue = (
    instruction: string,
    made: Pinned,
    target: Destination,
    seen: RequestMaterial | null = null
  ) => {
    const madeScopes = scopesFor(made.selection).scopes;
    const resolve = (): { about: Pinned; scope: TaskScope | undefined } | "pending" => {
      const followed = controller.followSelection(made.selection.selectionId);
      if (followed === "pending") return "pending";
      if (followed !== null) {
        const scopes = scopesFor(followed).scopes;
        const scope = matchScope(madeScopes[made.scope], scopes);
        if (scope >= 0) return { about: { selection: followed, scope }, scope: scopes[scope] };
      }
      return { about: made, scope: madeScopes[made.scope] };
    };
    let checked: { about: Pinned; scope: TaskScope | undefined } | null = null;
    let builtFor: string | null = null;
    controller.holdWhile(
      deliverAgentRequest({
        memoryKey,
        worktreeId,
        sentDraft: instruction,
        subject: made,
        // What the prompt is about, beside the words: the same sentence aimed at
        // another element, or another scope, builds a different prompt, so it
        // must not be folded into a run already going. A selection carries the
        // revisions it cites, so its id stands for its bytes too.
        subjectKey: `${made.selection.selectionId}\n${made.scope}`,
        destination:
          target.kind === "launch"
            ? { kind: "launch", agentId: target.agentId, title: target.name }
            : {
                kind: "terminal",
                terminalId: target.target.terminalId,
                title: target.target.title,
              },
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
          if (after === "built" && builtFor !== now.about.selection.selectionId)
            return STALE_SOURCE;
          if (!(await controller.sourcesUnchanged(now.about.selection))) return STALE_SOURCE;
          if (after !== "built") checked = now;
          return null;
        },
        buildPrompt: async () => {
          const now = checked ?? { about: made, scope: madeScopes[made.scope] };
          const about = now.about.selection;
          builtFor = about.selectionId;
          // The picture and project the preview showed, when the request is
          // still about the selection they were read for — a selection's id
          // stands for its bytes. One that followed a re-proved selection
          // reads afresh, and its row keeps the text it was sent as.
          const [picture, project] =
            seen !== null && seen.selectionId === about.selectionId
              ? [seen.picture, seen.project]
              : await Promise.all([
                  controller.pagePicture(about.selectionId),
                  controller.projectFor(about),
                ]);
          return buildAgentTaskPrompt(
            promptInputFor({
              instruction,
              selection: about,
              scope: now.scope,
              worktreePath,
              project,
              picture,
            })
          );
        },
      })
    );
  };

  const send = () => {
    if (!subject || !destination || !canSend) return;
    enqueue(draft, subject, destination, material);
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
  // didn't go in hands them back with the subject they were written about, so
  // an edit is still about that element until the user retargets it.
  const editAgain = (record: DeliveryRecord) => {
    removeComposerDelivery(memoryKey, record.id);
    updateComposerMemory(memoryKey, {
      draft: record.instruction,
      ...(record.subject ? { pinned: record.subject } : {}),
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  // Back to the session it went to while that session is still here: the row
  // names that session, and the composer may since point somewhere else. Only a
  // session that has gone falls back to where the composer points now.
  const retryTarget = (record: DeliveryRecord): Destination | undefined => {
    const live = record.terminalId
      ? targets.find((target) => target.terminalId === record.terminalId)
      : undefined;
    return live ? { kind: "terminal", target: live } : destination;
  };
  const retryFor = (record: DeliveryRecord): { run: () => void; label: string } | undefined => {
    const target = retryTarget(record);
    const subjectOf = record.subject;
    if (subjectOf === null || !target) return undefined;
    const original = target.kind === "terminal" && target.target.terminalId === record.terminalId;
    return {
      // A fallback is named on the button: the row says where it went, and a
      // bare "Retry" would send it somewhere else without saying so.
      label: original ? "Retry" : `Retry in ${destinationTitle(target)}`,
      run: () => {
        removeComposerDelivery(memoryKey, record.id);
        enqueue(record.instruction, subjectOf, target);
      },
    };
  };
  // What the agent actually changed is the worktree's diff, not its word.
  const reviewChanges = () =>
    void actionService.dispatch("worktree.openChanges", worktreeId ? { worktreeId } : undefined, {
      source: "user",
    });

  const openTerminal = (id: string) =>
    void actionService.dispatch("panel.focus", { panelId: id }, { source: "user" });

  const subjectLabel =
    activeScope?.kind === "component" || activeScope?.kind === "file"
      ? activeScope.label
      : elementLabel(subject ? primaryObservation(subject.selection) : undefined);
  const retargetable =
    pinned !== null &&
    current !== null &&
    current.selection.selectionId !== pinned.selection.selectionId;
  const suggestions = suggestionsFor(
    activeScope,
    subject ? primaryObservation(subject.selection)?.tagName : undefined
  );
  const history =
    deliveries.length > 0 ? (
      <DeliveryQueue
        deliveries={deliveries}
        targets={targets}
        onOpenTerminal={openTerminal}
        onReviewChanges={reviewChanges}
        onSendNow={(id) => forceAgentRequest(memoryKey, id)}
        onRemove={(id) => removeAgentRequest(memoryKey, id)}
        onRetry={retryFor}
        // Into an empty field only: it must never replace what is being written.
        onEditAgain={draft.trim() ? undefined : editAgain}
        onDismiss={(id) => removeComposerDelivery(memoryKey, id)}
      />
    ) : null;

  // The status region is mounted before the first request exists, so the
  // first change is heard; an alert is announced as it is inserted, so it only
  // exists while there is a failure to say. Rows are not live regions
  // themselves, so nobody hears a prompt recited.
  const announcer = (
    <>
      <span role="status" className="sr-only">
        {announcement && !announcement.urgent ? announcement.text : ""}
      </span>
      {announcement?.urgent ? (
        <span role="alert" className="sr-only">
          {announcement.text}
        </span>
      ) : null}
    </>
  );

  if (!subject) {
    return (
      <>
        {history}
        {announcer}
      </>
    );
  }

  // Why Send is off, or what pressing it will do — said once, under Send, and
  // tied to it as its description. Blockers first, in the order a user can
  // clear them, then an empty field, then the consequence of sending.
  const blocker: { text: string; settings?: boolean } | null =
    destinations.length === 0
      ? {
          text: "No agent CLI found — install Claude Code, Codex or Gemini CLI to send from here",
          settings: true,
        }
      : destinationGone
        ? { text: "The session you chose has closed — choose where to send this" }
        : staleSelection
          ? {
              // The identity's own headline, so the two never word one cause
              // two ways. While the page is being asked again the drawer says
              // nothing, and so does this: nobody is told to click yet.
              text: staleSelection.reproving
                ? REPROVING_NOTE
                : STALE_COPY[staleSelection.reason].title,
            }
          : scopeUnproven && activeScope?.kind === "component"
            ? {
                text: `${missingComponentSource(activeScope.label)} — choose another target`,
              }
            : uncertain
              ? {
                  text: `Check the terminal, then retry or dismiss ${
                    uncertainCount === 1
                      ? "the request below"
                      : `the ${uncertainCount} requests below`
                  }`,
                }
              : null;
  const consequence =
    destination?.kind === "launch"
      ? availabilityKnown
        ? `Starts a new ${destination.name} session in this worktree`
        : `Starts a new ${destination.name} session in this worktree, if ${destination.name} is installed`
      : busy
        ? // A heads-up, not a gate: what the terminal looked like, and the
          // call left to the person who can look at it.
          "The terminal is showing activity — this waits its turn"
        : null;
  // An empty field is a reason too, said in the same place; what Send will do
  // takes the line once there are words to send.
  const emptyReason = blocker === null && !draft.trim() ? "Write what should change first" : null;
  const note = blocker?.text ?? emptyReason ?? consequence;
  const sendLabel = !destination
    ? "Send"
    : destination.kind === "launch"
      ? `Start a new ${destination.name} session and send`
      : `Send to ${destination.target.title}`;

  return (
    // `role="group"` is what makes the label count: an `aria-label` on a bare
    // div is ignored, so the composer had no accessible grouping at all once
    // its visible header went. This restores the name without drawing one.
    <div role="group" aria-label="Ask an agent" className="flex flex-col gap-2">
      {retargetable && current ? (
        // Both subjects, in the offer itself: what the draft is about, and what
        // is selected now. "Use current selection" made the user read the
        // identity block to learn what "current" was.
        <div className="flex min-w-0 flex-col items-start gap-1 text-xs">
          <TruncatedTooltip content={`Draft is about ${subjectLabel}`}>
            <span className="max-w-full min-w-0 truncate text-text-secondary">
              Draft is about <span className="text-text-primary">{subjectLabel}</span>
            </span>
          </TruncatedTooltip>
          <Button
            variant="subtle"
            size="xs"
            className="max-w-full min-w-0"
            onClick={() => setPinned(current)}
          >
            <span className="truncate">
              {`Switch to ${elementLabel(primaryObservation(current.selection))}`}
            </span>
          </Button>
        </div>
      ) : null}

      {scopes.length > 1 ? (
        <PropertyRow label="Target" align="start">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {fitsSegments(scopes) ? (
              // The same segmented control the strip uses for Browse/Inspect: one
              // choice among peers, with the chosen one carried by a thumb rather
              // than by the others going bare. Its thumb needs stable geometry so
              // the control does not shrink; the wrapper keeps any overflow
              // inside the column instead of past the drawer's edge.
              <div className="flex w-fit min-w-0 max-w-full overflow-hidden">
                <SegmentedRadioGroup
                  // Default density is 28px, matching the destination picker in the
                  // footer and the property rows above: a 24px track read as a
                  // different kind of control sitting in the same column.
                  aria-label="What the request targets"
                  options={scopes.map((scope, index) => ({
                    value: String(index),
                    label: scope.kind === "element" ? "Element" : scope.label,
                  }))}
                  value={String(subject.scope)}
                  onChange={(value) => chooseScope(Number(value))}
                  className="min-w-0 max-w-full shrink"
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
                  aria-label="What the request targets"
                  className="h-7 min-w-0 flex-1 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="w-[var(--radix-select-trigger-width)]">
                  {scopes.map((scope, index) => (
                    <SelectItem key={index} value={String(index)}>
                      {/* Two lines, so the call site that tells two `Card`s apart
                          is never the part a narrow drawer clips. */}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {scope.kind === "element" ? "Element" : scope.label}
                        </span>
                        {scope.kind === "component" && scope.usedAt ? (
                          <span className="truncate font-mono text-3xs text-text-secondary">
                            {`used at ${callSiteHint(scope.usedAt)}`}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* The file the request points the agent at, for whichever target
                is chosen — a scope is a promise about where the request lands,
                and it used to be kept in a tooltip. */}
            <TargetFile selection={subject.selection} scope={activeScope} />
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

      <RequestPreview
        material={material}
        selection={subject.selection}
        scope={activeScope}
        draft={draft}
        worktreePath={worktreePath}
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
      <div className="flex flex-col gap-1">
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
              <TruncatedTooltip content={destination ? destinationTitle(destination) : ""}>
                <SelectTrigger
                  aria-label="Where to send it"
                  className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-xs hover:bg-overlay-subtle [&>span]:flex [&>span]:min-w-0 [&>span]:items-center"
                >
                  <SelectValue
                    placeholder={<DestinationLabel agentId={null} label="Choose where to send" />}
                  />
                </SelectTrigger>
              </TruncatedTooltip>
              {/* Wider than its trigger, capped at 20rem. Trigger-width was right
                  when the trigger was a full-width row; in the footer it is about
                  200px, and two claude sessions in one worktree are told apart by
                  the tail of their titles — exactly what that width cut off. The
                  cap is what keeps it from spilling past the drawer's left gutter,
                  and the available-width clamp keeps it inside the window when the
                  panel is tiled narrow. Titles wrap rather than truncate, for the
                  same reason. */}
              <SelectContent className="w-[min(20rem,var(--radix-select-content-available-width))] min-w-[var(--radix-select-trigger-width)] [&_[data-destination-label]]:items-start [&_[data-destination-title]]:break-words [&_[data-destination-title]]:whitespace-normal">
                {targets.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Running in this worktree</SelectLabel>
                    {targets.map((target) => (
                      <SelectItem key={target.terminalId} value={`terminal:${target.terminalId}`}>
                        <DestinationLabel agentId={target.agentId} label={target.title} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {launchable.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>
                      {availabilityKnown
                        ? "Start a new session"
                        : "Start a new session · not checked yet"}
                    </SelectLabel>
                    {launchable.map((option) =>
                      option.kind === "launch" ? (
                        <SelectItem key={option.agentId} value={`launch:${option.agentId}`}>
                          <DestinationLabel
                            agentId={option.agentId}
                            label={destinationTitle(option)}
                          />
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
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Off is `aria-disabled`, not `disabled`: a disabled button leaves
                  the tab order, and with it the only way a keyboard user finds
                  out why it is off. The click is guarded instead. Off is quiet,
                  not faded: a faded contrast fill is still the heaviest object
                  in the drawer (and white-on-grey on a light theme). */}
              <Button
                variant="contrast"
                size="xs"
                aria-disabled={canSend ? undefined : true}
                aria-describedby={noteId}
                onClick={() => {
                  if (canSend) send();
                }}
                aria-label={sendLabel}
                className="gap-1.5 aria-disabled:cursor-default aria-disabled:bg-overlay-subtle aria-disabled:text-text-secondary aria-disabled:shadow-none aria-disabled:ring-0 aria-disabled:hover:bg-overlay-subtle aria-disabled:active:scale-100"
              >
                Send
                <kbd
                  className={cn(KBD_COMPACT_CLASS, "border-current/30 bg-transparent text-inherit")}
                >
                  ⏎
                </kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{blocker?.text ?? emptyReason ?? sendLabel}</TooltipContent>
          </Tooltip>
        </div>
        {/* Always mounted, so a reason that appears is announced; empty, it
            costs no line. */}
        <p
          id={noteId}
          aria-live="polite"
          className={cn("text-xs text-text-secondary", note ? null : "sr-only")}
        >
          {note}
          {blocker?.settings ? (
            <>
              <br />
              <Button
                variant="link"
                size="inline"
                onClick={() =>
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "agents" },
                    { source: "user" }
                  )
                }
              >
                Open agent settings
              </Button>
            </>
          ) : null}
        </p>
      </div>

      {/* Shown, not hidden behind an "Ideas" toggle. They are the starting
          points for the one thing this panel does, and a disclosure made the
          panel's primary affordance cost a click to discover. Below the footer,
          so revealing or spending them never moves Send under the pointer.
          Whenever the field is empty, history or not: they used to go for
          good once anything had been sent. */}
      {!draft.trim() && destinations.length > 0 ? (
        <div
          id={`${inputId}-ideas`}
          role="group"
          aria-label="Suggestions"
          className="flex flex-wrap gap-1"
        >
          {/* The shared pill variant, not a hand-rolled one. Prose, so
              proportional. */}
          {suggestions.map((words) => (
            <Button
              key={words}
              variant="pill"
              size="xs"
              className="max-w-full min-w-0 font-normal text-text-secondary"
              onClick={() => applyIntent(words)}
            >
              <span className="truncate">{words}</span>
            </Button>
          ))}
        </div>
      ) : null}

      {history}
      {announcer}
    </div>
  );
}

/** The file a target points the agent at, or why there isn't one to show. */
function TargetFile({
  selection,
  scope,
}: {
  selection: PickedSelection;
  scope: TaskScope | undefined;
}) {
  // An unproven component has no file to show; the note under Send says why
  // that stops the request, once.
  if (isUnresolvedScope(scope)) return null;
  const place = scopePlace(selection, scope);
  if (place === null) {
    return (
      <p className="text-2xs text-text-secondary">
        No file traced — the agent finds it from the page
      </p>
    );
  }
  return <SourcePath file={place.path} line={place.line} className="text-2xs" />;
}

/**
 * What Send types besides the user's words, before it is typed.
 *
 * The summary and the text come from one input: the same `promptInputFor` and
 * `buildAgentTaskPrompt` the delivery builds from, over the same picture taken
 * at pick time and the same project read. So the row can't name a route the
 * request leaves out, and the text open here is the text that goes in — for
 * this subject; a request that waits in a queue is built again when its turn
 * comes, against whatever the page shows then, and its row keeps that text.
 */
function RequestPreview({
  material,
  selection,
  scope,
  draft,
  worktreePath,
}: {
  material: RequestMaterial | null;
  selection: PickedSelection;
  scope: TaskScope | undefined;
  draft: string;
  worktreePath: string | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Nothing provisional is shown as the request: until the picture and the
  // project read are in, the row says it is reading, past the usual gate.
  const reading = useDohertyGate(material === null);
  const input = material
    ? promptInputFor({
        instruction: draft,
        selection,
        scope,
        worktreePath,
        project: material.project,
        picture: material.picture,
      })
    : null;
  const inventory = input ? promptInventory(input) : null;
  const thumbnail = material?.thumbnail ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        data-composer-includes=""
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1 flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-2xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-text-primary">Includes</span>
          {/* A list, so a wrap breaks after a comma like any sentence. */}
          {/* Non-breaking inside a part, so "3 components" never splits. */}
          {inventory
            ? ` ${inventoryParts(inventory)
                .map((part) => part.replaceAll(" ", "\u00a0"))
                .join(", ")}`
            : reading
              ? " reading the page…"
              : null}
        </span>
        {/* Open, the screenshot is drawn full size below; once is enough. */}
        {thumbnail && !open ? (
          <img
            src={thumbnail}
            alt="Screenshot of the selection"
            className="h-5 w-auto max-w-12 shrink-0 rounded-[var(--radius-xs)] object-cover ring-1 ring-border-subtle"
          />
        ) : null}
      </button>
      {open ? (
        <div
          id={id}
          role="group"
          aria-label="What Send types into the agent"
          className="flex flex-col gap-1.5"
        >
          {input && inventory ? (
            <>
              {inventory.screenshot.status === "omitted" ? (
                <p className="text-2xs text-text-secondary">
                  {`No screenshot — ${inventory.screenshot.reason}`}
                </p>
              ) : thumbnail ? (
                // The picture the request points the agent at, at a size its
                // crop can be checked: what it frames, and what else got in.
                <img
                  src={thumbnail}
                  alt="Screenshot of the selection, cropped from the preview"
                  className="max-h-30 w-auto max-w-full self-start rounded-[var(--radius-xs)] object-contain ring-1 ring-border-subtle"
                />
              ) : null}
              <RequestText text={buildAgentTaskPrompt(input)} />
              <p className="text-2xs text-text-secondary">
                Checked again before it goes in, if it waits its turn
              </p>
            </>
          ) : (
            <p className="text-2xs text-text-secondary">Reading the page…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** `/about` for `http://localhost:4321/about`: the part of the address that names the page. */
function pagePath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function inventoryParts(inventory: PromptInventory): string[] {
  const parts: string[] = [];
  parts.push(inventory.route ? `route ${inventory.route}` : `page ${pagePath(inventory.page)}`);
  if (inventory.files > 0) parts.push(pluralize(inventory.files, "file"));
  if (inventory.selectors > 0) parts.push("selector");
  if (inventory.markup) parts.push("markup");
  if (inventory.styles) parts.push("styles");
  if (inventory.components > 0) parts.push(pluralize(inventory.components, "component"));
  if (inventory.screenshot.status !== "attached") parts.push("no screenshot");
  return parts;
}

/** Pixels, so the open preview's 120px-tall image stays sharp on a 2x display. */
const SCREENSHOT_PREVIEW_HEIGHT = 240;

interface RequestMaterial {
  selectionId: string;
  picture: PageScreenshot;
  project: ProjectContextOutcome | null;
  thumbnail: string | null;
}

async function readThumbnail(path: string, height: number): Promise<string | null> {
  try {
    const result = await window.electron.clipboard.thumbnailFromPath(path, { height });
    return result.thumbnailDataUrl;
  } catch {
    return null;
  }
}

/** The picture and project read a request about this selection is built from, and the picture's thumbnail. */
function useRequestMaterial(
  controller: InspectorController,
  selection: PickedSelection | null
): RequestMaterial | null {
  const [material, setMaterial] = useState<RequestMaterial | null>(null);
  useEffect(() => {
    if (selection === null) return;
    let live = true;
    void Promise.all([
      controller.pagePicture(selection.selectionId),
      controller.projectFor(selection),
    ]).then(async ([picture, project]) => {
      // The capture sits where agents read pasted images, which is a root the
      // thumbnail reader already allows. Big enough to inspect when the preview
      // is open; the closed row draws the same image small. Optional: the row
      // and the text stand without it.
      const thumbnail =
        picture.status === "attached"
          ? await readThumbnail(picture.path, SCREENSHOT_PREVIEW_HEIGHT)
          : null;
      if (live) setMaterial({ selectionId: selection.selectionId, picture, project, thumbnail });
    });
    return () => {
      live = false;
    };
  }, [controller, selection]);
  return selection !== null && material?.selectionId === selection.selectionId ? material : null;
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
  // One line wherever it is drawn; the open list lets the title wrap through
  // the data hooks, because Radix copies the chosen item into the closed
  // trigger and a wrapped copy there broke the footer's fixed height.
  return (
    <span data-destination-label="" className="flex min-w-0 items-center gap-1.5">
      {Icon && config ? (
        <BrandMark brandColor={config.color}>
          <Icon size={14} className="shrink-0" />
        </BrandMark>
      ) : (
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      <span data-destination-title="" className="min-w-0 truncate">
        {label}
      </span>
    </span>
  );
}

function destinationTitle(destination: Destination): string {
  return destination.kind === "launch"
    ? `New ${destination.name} session`
    : destination.target.title;
}

/**
 * Every request this composer has made: what is happening now, in the order it
 * will go in, then what happened, newest first.
 *
 * One row for every state. A request used to change shape as it moved — a
 * disclosure row while queued, a spinner line while going in, a callout once
 * sent with a separate "View request" under it — so the newest outcome looked
 * different from everything else exactly when it mattered, and two failures
 * read the same with nothing to say which request each was. Now each row is
 * the state and where it went, then the user's own words; the ones that need
 * the user, and the newest outcome, carry a line of detail and their actions
 * open, and the rest stay one quiet pair of lines that opens to the text.
 */
function DeliveryQueue({
  deliveries,
  targets,
  ...handlers
}: {
  deliveries: DeliveryRecord[];
  targets: AgentTarget[];
} & DeliveryHandlers) {
  const active = deliveries.filter((delivery) => !isSettledDelivery(delivery));
  const settled = deliveries.filter(isSettledDelivery).reverse();
  // Only the request at the head can be pushed on: order is what a queue is for.
  const head = active[0]?.id;
  const newest = settled[0]?.id;
  return (
    <div className="flex flex-col">
      <SectionHeader title="Requests" />
      <ul aria-label="Requests" className="flex flex-col gap-1">
        {[...active, ...settled].map((delivery) => (
          <DeliveryRow
            key={delivery.id}
            delivery={delivery}
            isHead={delivery.id === head}
            isNewest={delivery.id === newest}
            liveTarget={
              delivery.terminalId
                ? targets.find((target) => target.terminalId === delivery.terminalId)
                : undefined
            }
            {...handlers}
          />
        ))}
      </ul>
    </div>
  );
}

/** The latest state change among the requests, as one sentence; nothing for what was already there. */
function useDeliveryAnnouncement(
  deliveries: DeliveryRecord[]
): { text: string; urgent: boolean } | null {
  const seen = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; urgent: boolean } | null>(null);
  useEffect(() => {
    const first = seen.current === null;
    const known = seen.current ?? new Map<string, string>();
    const changed: DeliveryRecord[] = [];
    for (const delivery of deliveries) {
      const status = delivery.state.status;
      if (known.get(delivery.id) !== status && !first) changed.push(delivery);
      known.set(delivery.id, status);
    }
    seen.current = known;
    // Every change in the batch, failures first, so one landing beside another
    // is never the one that goes unheard.
    if (changed.length > 0) {
      const failed = changed.filter((delivery) => delivery.state.status === "failed");
      const ordered = [...failed, ...changed.filter((delivery) => !failed.includes(delivery))];
      setAnnouncement({
        text: ordered
          .map((delivery) => `${headingFor(delivery, false)}: ${delivery.instruction}`)
          .join(". "),
        urgent: failed.length > 0,
      });
    }
  }, [deliveries]);
  return announcement;
}

interface DeliveryHandlers {
  onOpenTerminal: (terminalId: string) => void;
  onReviewChanges: () => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  /** The retry for this record and what its button says, or undefined when there is nowhere to send it again. */
  onRetry: (delivery: DeliveryRecord) => { run: () => void; label: string } | undefined;
  onEditAgain: ((delivery: DeliveryRecord) => void) | undefined;
  onDismiss: (id: string) => void;
}

/** "Sent to Claude Code": the state, and where it went. */
function headingFor(delivery: DeliveryRecord, isHead: boolean): string {
  const { title } = delivery;
  switch (delivery.state.status) {
    case "queued":
      return isHead ? `Next for ${title}` : `Queued for ${title}`;
    case "sending":
      return `Sending to ${title}`;
    case "starting":
      return `Starting ${title}`;
    case "needs-you":
      // What was seen, not what it means: the pattern that matched is the only
      // thing the host can vouch for.
      return `Prompt detected in ${title}`;
    case "sent":
      return `Sent to ${title}`;
    case "unconfirmed":
      return `Unconfirmed in ${title}`;
    case "failed":
      return delivery.state.partial ? `Partly sent to ${title}` : `Couldn't send to ${title}`;
  }
}

/**
 * One request, for as long as it is on show. It is one component through every
 * state it passes — queued, going in, sent — so that a row opened to read what
 * is waiting stays open when that request's turn comes, rather than shutting
 * because a different component took its place.
 */
function DeliveryRow({
  delivery,
  isHead,
  isNewest,
  liveTarget,
  onOpenTerminal,
  onReviewChanges,
  onSendNow,
  onRemove,
  onRetry,
  onEditAgain,
  onDismiss,
}: {
  delivery: DeliveryRecord;
  isHead: boolean;
  isNewest: boolean;
  liveTarget: AgentTarget | undefined;
} & DeliveryHandlers) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { state, terminalId } = delivery;
  const status = state.status;
  const settled = isSettledDelivery(delivery);
  const needsUser = status === "needs-you" || status === "unconfirmed" || status === "failed";
  // Older outcomes that ask nothing of the user, and requests waiting behind
  // the head: two quiet lines, opened for their text and actions.
  const quiet = (settled && !needsUser && !isNewest) || (status === "queued" && !isHead);
  const waiting = status === "sending" || status === "starting";
  const slow = useDeferredLoading(waiting, UI_STILL_WORKING_MS);
  // What was typed into the agent once that exists; the user's words until then.
  const text = delivery.request ?? delivery.instruction;
  const retry = onRetry(delivery);
  // The session this went to has closed, so Retry goes somewhere else: said
  // in full here, where the button's own label may be cut short.
  const elsewhere = retry && retry.label !== "Retry" ? retry.label.replace(/^Retry in /, "") : null;
  const fallbackNote = elsewhere ? ` Its session has closed; Retry sends it to ${elsewhere}.` : "";

  // Only a session that is still here can be opened; a closed one would be a
  // button that does nothing.
  const openTerminalButton =
    terminalId && liveTarget ? (
      <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(terminalId)}>
        Open terminal
      </Button>
    ) : null;
  const retryButton = retry ? (
    <Button variant="subtle" size="xs" className="max-w-full min-w-0" onClick={retry.run}>
      <RefreshCw aria-hidden="true" />
      <span className="truncate">{retry.label}</span>
    </Button>
  ) : null;

  let detail: string | null = null;
  let actions: ReactNode = null;
  switch (state.status) {
    case "queued":
      detail = isHead
        ? "Goes in when the agent is back at its prompt"
        : "Goes in after the requests above it";
      actions = (
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
      );
      break;
    case "sending":
      detail = slow ? "Still working…" : null;
      break;
    case "starting":
      detail = slow ? "Goes in when it's ready — still working…" : "Goes in when it's ready";
      break;
    case "needs-you":
      detail =
        "If it's asking you something, answer it there; your request goes in once it's ready";
      actions = openTerminalButton;
      break;
    case "sent": {
      // Terminal activity is not evidence the agent is working on THIS
      // request, or on anything: the one thing proven is the send, so that is
      // the heading, and the observation is named as one, in the present tense.
      const active = liveTarget ? isAgentBusy(liveTarget.agentState) : false;
      detail = active
        ? "The terminal is showing activity. File changes it saves appear in the preview."
        : "File changes it saves appear in the preview";
      actions = (
        <>
          {openTerminalButton}
          <Button variant="subtle" size="xs" onClick={onReviewChanges}>
            View changes
          </Button>
        </>
      );
      break;
    }
    case "unconfirmed":
      detail = elsewhere
        ? `Check the terminal before retrying, so the agent doesn't get the request twice.${fallbackNote}`
        : "Check the terminal before retrying, so the agent doesn't get the request twice";
      actions = (
        <>
          {retryButton}
          {openTerminalButton}
        </>
      );
      break;
    case "failed":
      detail = state.partial
        ? `${state.message}. Part of it may already be in the agent's input — check the terminal before retrying.${fallbackNote}`
        : `${state.message}. Nothing was typed into the agent.${fallbackNote}`;
      actions = state.partial ? (
        <>
          {retryButton}
          {openTerminalButton}
        </>
      ) : (
        <>
          {retryButton}
          {onEditAgain ? (
            <Button variant="subtle" size="xs" onClick={() => onEditAgain(delivery)}>
              <Pencil aria-hidden="true" />
              Edit request
            </Button>
          ) : null}
        </>
      );
      break;
  }
  const showActions = Boolean(actions) && (open || !quiet);

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="group/row flex min-w-0 flex-1 items-start gap-2 rounded-[var(--radius-sm)] py-0.5 pr-1 text-left transition-colors duration-150 ease-out hover:bg-overlay-subtle"
        >
          <DeliveryGlyph
            status={status}
            partial={state.status === "failed" && state.partial === true}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "text-2xs",
                // Opened, the whole destination: two sessions that share the
                // start of their titles are told apart by the end.
                open ? "break-words" : "truncate",
                quiet ? "text-text-secondary" : "font-medium text-text-primary"
              )}
            >
              {headingFor(delivery, isHead)}
            </span>
            <span
              className={cn(
                "text-xs",
                open ? "whitespace-pre-wrap break-words" : "truncate",
                quiet ? "text-text-secondary" : "text-text-primary"
              )}
            >
              {delivery.instruction}
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "mt-0.5 h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
              open && "rotate-90"
            )}
          />
        </button>
        {/* The slot is held on every row, so the chevrons line up whether or
            not a row can be dismissed. */}
        {settled ? (
          <DismissButton aria-label="Dismiss" onClick={() => onDismiss(delivery.id)} />
        ) : (
          <span aria-hidden="true" className="h-6 w-6 shrink-0" />
        )}
      </div>
      {detail && (!quiet || open) ? (
        <p className="pl-6 text-2xs text-text-secondary">{detail}</p>
      ) : null}
      {showActions ? <div className="flex flex-wrap gap-1 pl-6">{actions}</div> : null}
      {open ? (
        <div id={id} className="pl-6">
          <RequestText text={text} />
        </div>
      ) : null}
    </li>
  );
}

/** The row's state as a glyph in the spinner's slot: neutral unless it asks for the user. */
function DeliveryGlyph({
  status,
  partial = false,
}: {
  status: DeliveryRecord["state"]["status"];
  partial?: boolean;
}) {
  const waiting = status === "sending" || status === "starting";
  // The spinner waits out the same gate every inline wait does; until then the
  // slot holds its place empty, so the words beside it never move.
  const visible = useDohertyGate(waiting);
  // 16px, with the gap, is the 24px the detail line is inset by, so the glyph
  // column and every line under it share one edge.
  const box = "mt-px flex h-4 w-4 shrink-0 items-center justify-center";
  if (waiting) return <span className={box}>{visible ? <Spinner size="xs" /> : null}</span>;
  if (status === "needs-you" || status === "unconfirmed" || status === "failed") {
    // A part-way failure is a warning, like an unconfirmed one: both may have
    // left text in the agent's input, and both ask for the same check.
    const { Icon, toneClass } =
      SEVERITY_VISUAL[status === "failed" && !partial ? "error" : "warning"];
    return (
      <span className={box}>
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", toneClass)} data-severity-glyph="" />
      </span>
    );
  }
  const Icon = status === "queued" ? Clock : Check;
  return (
    <span className={box}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-text-secondary" />
    </span>
  );
}

function RequestText({ text }: { text: string }) {
  // The house scroll fade, so a long request reads as continuing rather than
  // as a line cut through its letters at the box's edge.
  return (
    <ScrollShadow
      compact
      className="max-h-48 rounded-md border border-border-subtle bg-surface-inset"
      scrollClassName="px-2 py-1.5"
      role="group"
      tabIndex={0}
      aria-label="Request text"
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-3xs leading-relaxed text-text-secondary">
        {text}
      </pre>
    </ScrollShadow>
  );
}
