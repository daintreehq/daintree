import { useEffect, useSyncExternalStore } from "react";
import { MonitorPlay, Unplug } from "lucide-react";
import type { PanelViewProps } from "@shared/types/plugin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { WaitingRow } from "./WaitingRow.js";
import {
  acquireInspectorController,
  type InspectorController,
  type InspectorState,
} from "./inspectorController.js";
import { useInspectorContext } from "./useInspectorContext.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { SelectionCard, type SelectionActions } from "./SelectionCard.js";
import { ReceiptView } from "./ReceiptView.js";
import { AgentComposer } from "./AgentComposer.js";
import { DETACH_COPY, displayUrl, relativeTo } from "./copy.js";

const MODE_OPTIONS = [
  { value: "browse" as const, label: "Browse" },
  { value: "select" as const, label: "Select" },
];

export function SiteInspectorView({ panelId, panelRemovedSignal }: PanelViewProps) {
  const controller = acquireInspectorController(panelId, panelRemovedSignal);
  const { projectId, worktreeId, worktreePath } = useInspectorContext(panelId);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.updateContext({ projectId, worktreeId, worktreePath });
  }, [controller, projectId, worktreeId, worktreePath]);

  const actions: SelectionActions = {
    setText: (selectionId, text) => void controller.setText(selectionId, text),
    addClasses: (selectionId, tokens) => controller.addClasses(selectionId, tokens),
    removeClass: (selectionId, token) => void controller.removeClass(selectionId, token),
    completeClasses: (query) => controller.completeClasses(query),
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-surface-panel text-text-primary">
      {state.binding.status === "bound" ? (
        <PreviewBar state={state} controller={controller} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {state.binding.status === "bound" ? (
          <BoundBody
            state={state}
            controller={controller}
            worktreePath={worktreePath}
            worktreeId={worktreeId}
            actions={actions}
          />
        ) : (
          <BindingBody state={state} controller={controller} />
        )}
        {state.receipt ? (
          <ReceiptView state={state.receipt} onUndo={() => void controller.undo()} />
        ) : null}
      </div>
    </div>
  );
}

function PreviewBar({
  state,
  controller,
}: {
  state: InspectorState;
  controller: InspectorController;
}) {
  const binding = state.binding;
  const page = state.page;
  const url = page ? page.url : binding.status === "bound" ? binding.url : null;
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5">
      <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={url ?? undefined}>
        {page ? displayUrl(url) : "Waiting for the page to load"}
      </p>
      <SegmentedToggle
        density="compact"
        options={MODE_OPTIONS}
        value={state.mode}
        onChange={(mode) => void controller.setMode(mode)}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Disconnect from the dev preview"
        title="Disconnect from the dev preview"
        onClick={() => void controller.detach()}
      >
        <Unplug aria-hidden="true" />
      </Button>
    </div>
  );
}

function BindingBody({
  state,
  controller,
}: {
  state: InspectorState;
  controller: InspectorController;
}) {
  const binding = state.binding;
  switch (binding.status) {
    case "idle":
    case "listing":
    case "binding":
    case "bound":
      return <WaitingRow label="Connecting to the dev preview" />;
    case "starting":
      return (
        <div className="flex flex-col gap-1">
          <WaitingRow label="Starting your site" />
          <p className="text-xs text-text-secondary">
            If the dev preview asks which command runs your site, choose it there.
          </p>
        </div>
      );
    case "no-candidates":
      return (
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<MonitorPlay />}
          title="Start your site"
          description="The Site Builder works on your running SvelteKit dev server in this worktree."
          action={
            <Button variant="subtle" size="sm" onClick={() => void controller.startPreview()}>
              Start dev server
            </Button>
          }
        />
      );
    case "choosing":
      return (
        <section aria-labelledby="site-inspector-choose" className="flex flex-col gap-2">
          <h2 id="site-inspector-choose" className="text-xs font-medium text-text-secondary">
            Choose a dev preview to inspect
          </h2>
          <ul className="flex flex-col gap-1">
            {binding.candidates.map((candidate) => (
              <li key={candidate.panelId}>
                <button
                  type="button"
                  onClick={() => void controller.bindTo(candidate.panelId)}
                  className="flex w-full items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-left text-xs text-text-primary transition-colors duration-150 ease-out hover:bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
                >
                  <MonitorPlay
                    className="h-3.5 w-3.5 shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    title={candidate.url ?? undefined}
                  >
                    {candidate.url ?? "No page loaded"}
                  </span>
                  {candidate.boundSessionId ? (
                    <Badge size="xs" tone="neutral">
                      In use
                    </Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      );
    case "detached":
      return (
        <InspectorNotice
          tone={binding.reason === "requested" ? "info" : "warning"}
          title={DETACH_COPY[binding.reason]}
          action={
            <Button variant="subtle" size="xs" onClick={() => void controller.refreshCandidates()}>
              Reconnect
            </Button>
          }
        />
      );
    case "failed":
      return (
        <InspectorNotice
          tone="error"
          role="alert"
          title="Couldn't connect to the dev preview"
          action={
            <Button variant="subtle" size="xs" onClick={() => void controller.refreshCandidates()}>
              Retry
            </Button>
          }
        >
          {binding.message}
        </InspectorNotice>
      );
  }
}

function BoundBody({
  state,
  controller,
  worktreePath,
  worktreeId,
  actions,
}: {
  state: InspectorState;
  controller: InspectorController;
  worktreePath: string | null;
  worktreeId: string | null;
  actions: SelectionActions;
}) {
  return (
    <>
      {state.issue ? (
        <InspectorNotice
          tone={state.issue.severity}
          title={state.issue.message}
          role={state.issue.severity === "error" ? "alert" : "status"}
          action={
            <Button variant="ghost" size="xs" onClick={() => controller.dismissIssue()}>
              Dismiss
            </Button>
          }
        />
      ) : null}
      <WorkspaceStatus state={state} controller={controller} worktreePath={worktreePath} />
      <SelectionBody state={state} controller={controller} actions={actions} />
      {state.workspace.status === "ready" ? (
        <AgentComposer
          controller={controller}
          selection={state.selection}
          worktreeId={worktreeId}
          worktreePath={worktreePath}
        />
      ) : null}
    </>
  );
}

function WorkspaceStatus({
  state,
  controller,
  worktreePath,
}: {
  state: InspectorState;
  controller: InspectorController;
  worktreePath: string | null;
}) {
  const workspace = state.workspace;
  switch (workspace.status) {
    case "idle":
      return null;
    case "opening":
      return <WaitingRow label="Opening the site source" />;
    case "no-worktree":
      return (
        <InspectorNotice tone="info" title="Preview only — no worktree">
          This panel isn't attached to a worktree, so elements can't be traced to source.
        </InspectorNotice>
      );
    case "no-app":
      return (
        <InspectorNotice tone="info" title="Preview only — no SvelteKit app found">
          You can browse and select in the preview, but there's no SvelteKit source in this worktree
          to edit.
        </InspectorNotice>
      );
    case "ambiguous":
      return (
        <section aria-labelledby="site-inspector-apps" className="flex flex-col gap-2">
          <h2 id="site-inspector-apps" className="text-xs font-medium text-text-secondary">
            Choose the app this preview runs
          </h2>
          <p className="text-xs text-text-secondary">
            This worktree has more than one SvelteKit app
          </p>
          <ul className="flex flex-col gap-1">
            {workspace.appRoots.map((appRoot) => (
              <li key={appRoot}>
                <Button
                  variant="subtle"
                  size="sm"
                  className="w-full justify-start font-mono"
                  onClick={() => void controller.openWorkspace(appRoot)}
                >
                  {relativeTo(worktreePath, appRoot)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      );
    case "failed":
      return (
        <InspectorNotice
          tone="error"
          role="alert"
          title="Couldn't open the site source"
          action={
            <Button variant="subtle" size="xs" onClick={() => void controller.openWorkspace()}>
              Retry
            </Button>
          }
        >
          {workspace.message}
        </InspectorNotice>
      );
    case "ready":
      if (workspace.support.level === "full") return null;
      return (
        <InspectorNotice tone="warning" title="Preview only — editing isn't supported here">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {workspace.support.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </InspectorNotice>
      );
  }
}

function SelectionBody({
  state,
  controller,
  actions,
}: {
  state: InspectorState;
  controller: InspectorController;
  actions: SelectionActions;
}) {
  const selection = state.selection;
  switch (selection.status) {
    case "none":
      return state.mode === "browse" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-text-secondary">
            Switch to Select, then click an element in the preview to see the source that owns it.
          </p>
          <Button variant="subtle" size="xs" onClick={() => void controller.setMode("select")}>
            Start selecting
          </Button>
        </div>
      ) : (
        <p className="text-xs text-text-secondary">Click an element in the preview to select it</p>
      );
    case "resolving":
      return <WaitingRow label="Finding the source for this element" />;
    case "observed":
      return (
        <section aria-label="Selected element" className="flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Badge size="sm" tone="neutral" className="font-mono">
              {selection.node.tagName.toLowerCase()}
            </Badge>
            <span className="min-w-0 truncate text-sm text-text-primary">
              {selection.node.label}
            </span>
          </div>
          <p className="text-xs text-text-secondary">Source isn't available in preview-only mode</p>
        </section>
      );
    case "settling":
      return (
        <InspectorNotice tone="warning" title="This file just changed — select again" role="status">
          The preview may still be showing the old version. Wait a moment for it to update, then
          click the element again.
        </InspectorNotice>
      );
    case "lost":
      return (
        <InspectorNotice tone="warning" title="Selection changed — select again" role="status">
          The page changed while its source was being found. Click the element in the preview again.
        </InspectorNotice>
      );
    case "failed":
      return (
        <InspectorNotice tone="error" title="Couldn't select this element" role="alert">
          {selection.message}
        </InspectorNotice>
      );
    case "ready":
      return <SelectionCard state={state} selection={selection} actions={actions} />;
  }
}
