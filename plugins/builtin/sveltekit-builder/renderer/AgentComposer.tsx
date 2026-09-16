import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Bot } from "lucide-react";
import type { TerminalStatusResult } from "@shared/types/terminalStatus";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SiteSelection } from "../shared/model.js";
import {
  MAX_INSTRUCTION_CHARS,
  buildAgentTaskPrompt,
  deliveryFromPhase,
  isAgentBusy,
  taskScopes,
  type AgentTarget,
  type DeliveryState,
} from "./agentTask.js";
import { ownerFile, type InspectorController, type SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { useAgentTargets } from "./useAgentTargets.js";
import { basename } from "./copy.js";

const DELIVERY_POLL_MS = 250;
const DELIVERY_TIMEOUT_MS = 10_000;

interface Pinned {
  selection: SiteSelection;
  file: string | null;
  /** Index into `taskScopes(selection)`: the element, or a component around it. */
  scope: number;
}

/**
 * Hand the selected element to an agent terminal in this worktree, with the
 * source identity the Inspector resolved. The terminal stays the agent: this
 * only composes and submits one prompt, then reports what the host can prove
 * about its delivery.
 */
export function AgentComposer({
  controller,
  selection,
  worktreeId,
  worktreePath,
}: {
  controller: InspectorController;
  selection: SelectionState;
  worktreeId: string | null;
  worktreePath: string | null;
}) {
  const targets = useAgentTargets(worktreeId);
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [chosenTargetId, setChosenTargetId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ state: DeliveryState; target: AgentTarget } | null>(
    null
  );
  const sendRun = useRef(0);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const inputId = useId();

  useEffect(
    () => () => {
      sendRun.current++;
    },
    []
  );

  const current: Pinned | null =
    selection.status === "ready"
      ? {
          selection: selection.selection,
          file: ownerFile(selection.selection, worktreePath),
          scope: 0,
        }
      : null;
  // A draft keeps pointing at what it was written about; clicking elsewhere
  // offers to retarget instead of quietly changing the subject.
  const [unpinnedScope, setUnpinnedScope] = useState<{ selectionId: string; scope: number } | null>(
    null
  );
  const subject: Pinned | null =
    pinned ??
    (current && unpinnedScope?.selectionId === current.selection.selectionId
      ? { ...current, scope: unpinnedScope.scope }
      : current);
  const scopes = subject ? taskScopes(subject.selection) : [];
  const chooseScope = (scope: number) => {
    if (pinned) setPinned({ ...pinned, scope });
    else if (current) setUnpinnedScope({ selectionId: current.selection.selectionId, scope });
  };
  const target =
    targets.find((candidate) => candidate.terminalId === chosenTargetId) ??
    (targets.length === 1 ? targets[0] : undefined);
  const busy = target ? isAgentBusy(target.agentState) : false;
  const sending = delivery?.state.status === "sending";
  const canSend = Boolean(subject && target && draft.trim() && !busy && !sending);

  const onDraftChange = (next: string) => {
    setDraft(next);
    if (next.trim() && !pinned && subject) setPinned(subject);
    if (!next.trim() && pinned) setPinned(null);
  };

  const send = async () => {
    if (!subject || !target || !canSend) return;
    const run = ++sendRun.current;
    const sentDraft = draft;
    setDelivery({ state: { status: "sending" }, target });

    const excerpt = subject.file
      ? await controller.sourceExcerpt(subject.selection, subject.file)
      : null;
    if (run !== sendRun.current) return;
    const prompt = buildAgentTaskPrompt({
      instruction: draft,
      selection: subject.selection,
      file: subject.file,
      worktreePath,
      excerpt,
      scope: taskScopes(subject.selection)[subject.scope],
    });

    const result = await actionService.dispatch<{ submissionToken: string }>(
      "terminal.sendCommand",
      { terminalId: target.terminalId, command: prompt },
      { source: "user" }
    );
    if (run !== sendRun.current) return;
    if (!result.ok) {
      setDelivery({ state: { status: "failed", message: result.error.message }, target });
      return;
    }

    const token = result.result.submissionToken;
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let state: DeliveryState | null = null;
    while (state === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
      if (run !== sendRun.current) return;
      const status = await actionService.dispatch<TerminalStatusResult>(
        "terminal.getStatus",
        { terminalIds: [target.terminalId], submissionToken: token },
        { source: "user" }
      );
      if (run !== sendRun.current) return;
      const phase = status.ok ? (status.result.terminals[0]?.submission?.phase ?? null) : null;
      state = deliveryFromPhase(phase);
    }
    state ??= { status: "unconfirmed" };
    setDelivery({ state, target });
    // Only the words that went out are cleared: anything typed while sending
    // is a new request and keeps its pin.
    if (state.status === "sent" && draftRef.current === sentDraft) {
      setDraft("");
      setPinned(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  const openTerminal = (terminalId: string) =>
    void actionService.dispatch("panel.focus", { panelId: terminalId }, { source: "user" });

  const definition = subject?.selection.nodes[0]?.definition ?? null;
  const activeScope = subject ? scopes[subject.scope] : undefined;
  const subjectLabel =
    activeScope?.kind === "component"
      ? `the ${activeScope.label} component`
      : subject?.selection.nodes[0]?.label || definition?.tagName || "element";
  const retargetable =
    pinned !== null &&
    current !== null &&
    current.selection.selectionId !== pinned.selection.selectionId;

  return (
    <section
      aria-labelledby={`${inputId}-heading`}
      className="flex flex-col gap-2 border-t border-border-subtle pt-3"
    >
      <h2
        id={`${inputId}-heading`}
        className="flex items-center gap-1.5 text-xs font-medium text-text-secondary"
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        Ask an agent
      </h2>

      {targets.length === 0 ? (
        <p className="text-xs text-text-secondary">
          Start an agent in this worktree to send it a request about the selected element
        </p>
      ) : targets.length === 1 && target ? (
        <p className="truncate text-xs text-text-secondary">
          To <span className="text-text-primary">{target.title}</span>
        </p>
      ) : (
        <Select value={target?.terminalId ?? ""} onValueChange={setChosenTargetId}>
          <SelectTrigger aria-label="Agent to send to" className="h-7 text-xs">
            <SelectValue placeholder="Choose an agent" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((candidate) => (
              <SelectItem key={candidate.terminalId} value={candidate.terminalId}>
                {candidate.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {subject ? (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="min-w-0 truncate text-text-secondary" title={subjectLabel}>
            About <span className="text-text-primary">{subjectLabel}</span>
            {definition ? (
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
      ) : (
        <p className="text-xs text-text-secondary">Select an element to ask an agent about it</p>
      )}

      {scopes.length > 1 ? (
        <div role="group" aria-label="What the request is about" className="flex flex-wrap gap-1">
          {scopes.map((scope, index) => (
            <Button
              key={`${scope.kind}:${scope.label}:${index}`}
              variant={subject?.scope === index ? "subtle" : "ghost"}
              size="xs"
              aria-pressed={subject?.scope === index}
              title={scope.kind === "component" ? scope.file : undefined}
              onClick={() => chooseScope(index)}
            >
              {scope.kind === "element" ? "This element" : scope.label}
            </Button>
          ))}
        </div>
      ) : null}

      <Textarea
        id={inputId}
        aria-label="Request for the agent"
        placeholder="Describe the change"
        density="compact"
        rows={3}
        maxLength={MAX_INSTRUCTION_CHARS}
        value={draft}
        disabled={!subject || targets.length === 0}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      {busy && target ? (
        <p className="text-xs text-text-secondary">
          {target.title} is working — wait for it to finish before sending
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="subtle" size="sm" disabled={!canSend} onClick={() => void send()}>
          Send to agent
        </Button>
      </div>

      {delivery ? <DeliveryNotice delivery={delivery} onOpenTerminal={openTerminal} /> : null}
    </section>
  );
}

function DeliveryNotice({
  delivery,
  onOpenTerminal,
}: {
  delivery: { state: DeliveryState; target: AgentTarget };
  onOpenTerminal: (terminalId: string) => void;
}) {
  const { state, target } = delivery;
  const open = (
    <Button variant="subtle" size="xs" onClick={() => onOpenTerminal(target.terminalId)}>
      Open terminal
    </Button>
  );
  switch (state.status) {
    case "sending":
      return (
        <p role="status" className="text-xs text-text-secondary">
          Sending to {target.title}…
        </p>
      );
    case "sent":
      return (
        <InspectorNotice tone="info" role="status" title={`Sent to ${target.title}`} action={open}>
          The agent makes the change in its terminal. The preview updates when the file is saved.
        </InspectorNotice>
      );
    case "unconfirmed":
      return (
        <InspectorNotice tone="warning" role="status" title="Delivery unconfirmed" action={open}>
          Check the terminal before sending again, so the agent doesn't get the request twice.
        </InspectorNotice>
      );
    case "failed":
      return (
        <InspectorNotice tone="error" role="alert" title="Couldn't send to the agent" action={open}>
          {state.message}. Part of the request may already be in the agent's input — check the
          terminal before sending again.
        </InspectorNotice>
      );
  }
}
