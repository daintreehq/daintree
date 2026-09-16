import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import type { DevPreviewToolSurfaceProps } from "@/registry/devPreviewToolRegistry";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import {
  INITIAL_INSPECTOR_STATE,
  holdBuilderController,
  peekBuilderController,
  subscribeBuilderControllers,
  type InspectorController,
  type InspectorState,
} from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { SelectionEdits, SelectionIdentity, type SelectionActions } from "./SelectionCard.js";
import { ReceiptView } from "./ReceiptView.js";
import { AgentComposer } from "./AgentComposer.js";
import {
  composerMemoryKey,
  setDrawerCollapsed,
  useComposerMemory,
  useDrawerCollapsed,
} from "./composerMemory.js";
import { WaitingRow } from "./WaitingRow.js";
import { scopesFor } from "./agentTask.js";
import { DETACH_COPY, relativeTo } from "./copy.js";

const MODE_OPTIONS = [
  { value: "browse" as const, label: "Browse" },
  { value: "select" as const, label: "Select" },
];

/**
 * The builder for the dev preview hosting it: one controller shared by the
 * strip and the drawer, held while either is mounted, told which worktree the
 * preview belongs to, and reconnected once the preview has a page to attach to.
 */
function useBuilder(props: DevPreviewToolSurfaceProps): {
  controller: InspectorController | null;
  state: InspectorState;
} {
  const { panelId, projectId, worktreeId, worktreePath, isWebviewReady, url } = props;
  const controller = useSyncExternalStore(subscribeBuilderControllers, () =>
    peekBuilderController(panelId)
  );
  // Re-held whenever the controller changes, so one released underneath a
  // mounted builder (a plugin disable/enable) is replaced rather than left dead.
  useEffect(() => holdBuilderController(panelId), [panelId, controller]);
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getSnapshot ?? initialSnapshot
  );

  useEffect(() => {
    controller?.updateContext({ projectId, worktreeId, worktreePath });
  }, [controller, projectId, worktreeId, worktreePath]);

  // A preview with no page yet refuses the bind; try again when one arrives.
  useEffect(() => {
    if (!controller || !isWebviewReady || !url) return;
    if (controller.getSnapshot().binding.status === "failed") void controller.connect();
  }, [controller, isWebviewReady, url]);

  return { controller, state };
}

const subscribeNothing = (): (() => void) => () => {};
const initialSnapshot = (): InspectorState => INITIAL_INSPECTOR_STATE;

function actionsFor(controller: InspectorController): SelectionActions {
  return {
    setText: (selectionId, text) => void controller.setText(selectionId, text),
    addClasses: (selectionId, tokens) => controller.addClasses(selectionId, tokens),
    removeClass: (selectionId, token) => void controller.removeClass(selectionId, token),
    completeClasses: (query) => controller.completeClasses(query),
  };
}

/** The strip under the browser toolbar: mode, what is selected, and close. */
export function SiteBuilderToolbar(props: DevPreviewToolSurfaceProps) {
  const { controller, state } = useBuilder(props);
  const bound = state.binding.status === "bound";
  if (!controller) {
    return (
      <div
        role="toolbar"
        aria-label="Site Builder"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-overlay bg-surface px-2"
      >
        <WaitingRow label="Starting the Site Builder" />
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Site Builder"
      className="@container/strip flex h-8 shrink-0 items-center gap-2 border-b border-overlay bg-surface px-2"
    >
      <SegmentedToggle
        density="compact"
        options={MODE_OPTIONS}
        value={state.mode}
        onChange={(mode) => void controller.setMode(mode)}
      />
      <div aria-hidden="true" className="toolbar-divider h-4 w-px shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-text-secondary">
        <StripStatus state={state} controller={controller} bound={bound} />
      </div>
      <DrawerToggle panelId={props.panelId} />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close Site Builder"
        title="Close Site Builder"
        onClick={props.onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function DrawerToggle({ panelId }: { panelId: string }) {
  const collapsed = useDrawerCollapsed(panelId);
  const label = collapsed ? "Show details" : "Hide details";
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={!collapsed}
      title={label}
      onClick={() => setDrawerCollapsed(panelId, !collapsed)}
    >
      {collapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
    </Button>
  );
}

/** How to walk the page from the keyboard once something is selected. */
function KeyHints() {
  return (
    <span className="ml-auto hidden shrink-0 items-center gap-2 text-3xs @[640px]/strip:flex">
      <span>
        <kbd className="font-sans">↑↓←→</kbd> move
      </span>
      <span>
        <kbd className="font-sans">⌥↑</kbd> component
      </span>
    </span>
  );
}

function StripStatus({
  state,
  controller,
  bound,
}: {
  state: InspectorState;
  controller: InspectorController;
  bound: boolean;
}) {
  const binding = state.binding;
  if (binding.status === "detached") {
    return (
      <>
        <span className="truncate">{DETACH_COPY[binding.reason]}</span>
        <Button variant="subtle" size="xs" onClick={() => void controller.connect()}>
          Reconnect
        </Button>
      </>
    );
  }
  if (binding.status === "failed") {
    return (
      <>
        <span className="truncate" title={binding.message}>
          Waiting for the page to load
        </span>
        <Button variant="subtle" size="xs" onClick={() => void controller.retryConnect()}>
          Retry
        </Button>
      </>
    );
  }
  if (!bound) return <WaitingRow label="Connecting to the page" />;

  const selection = state.selection;
  if (selection.status === "ready") {
    const node = selection.selection.nodes[0];
    if (node) {
      const { scopes, pickedIndex } = scopesFor(
        selection.selection,
        selection.scope === "component" ? selection.component : null,
        selection.definitions
      );
      // Outermost first, ending at what was picked: the component for a
      // component selection, the element otherwise.
      const components = scopes
        .slice(pickedIndex > 0 ? pickedIndex : 1)
        .map((scope) => scope.label)
        .reverse();
      const trail =
        pickedIndex > 0
          ? components
          : [...components, node.label || node.definition?.tagName || "element"];
      const picked = pickedIndex > 0 ? scopes[pickedIndex] : undefined;
      // A component is located by the file it is written in, once that is
      // proven; never by the element it was reached through.
      const location =
        picked?.kind === "component"
          ? picked.file
          : node.definition
            ? `${selection.file ?? node.definition.location.file}:${node.definition.location.line}`
            : null;
      return (
        <>
          <ol aria-label="Selection" className="flex min-w-0 items-center gap-1 overflow-hidden">
            {trail.map((label, index) => (
              <li key={`${label}-${index}`} className="flex min-w-0 shrink items-center gap-1">
                {index > 0 ? (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : null}
                <span
                  className={
                    index === trail.length - 1
                      ? "truncate font-medium text-text-primary"
                      : "truncate"
                  }
                >
                  {label}
                </span>
              </li>
            ))}
          </ol>
          {pickedIndex > 0 ? (
            <span className="shrink-0 rounded-sm border border-border-subtle px-1 text-3xs">
              Component
            </span>
          ) : null}
          <KeyHints />
          {location ? (
            <span className="shrink-0 truncate font-mono text-3xs" title={location}>
              {location}
            </span>
          ) : null}
        </>
      );
    }
  }
  if (selection.status === "resolving") return <WaitingRow label="Finding the source" />;
  return (
    <span className="truncate">
      {state.mode === "select"
        ? "Click any element on the page"
        : "Browsing — switch to Select to pick an element"}
    </span>
  );
}

/**
 * The drawer beside the page. Closed until there is something to show, so the
 * site keeps its full width while you browse and pick.
 */
export function SiteBuilderDrawer(props: DevPreviewToolSurfaceProps) {
  const { controller, state } = useBuilder(props);
  // Held here, outside the per-selection section, so picking the next element
  // doesn't fold away the editor the user just opened.
  const [editsOpen, setEditsOpen] = useState(false);
  const memoryKey = composerMemoryKey(props.panelId, props.worktreeId);
  // A draft or an agent request outlives the selection it was about; keep
  // both reachable.
  const composer = useComposerMemory(memoryKey);
  const collapsed = useDrawerCollapsed(props.panelId);
  if (!controller) return null;
  const selection = state.selection;
  const workspaceNotice = workspaceNeedsAttention(state);
  const open =
    composer.delivery !== null ||
    composer.draft.trim() !== "" ||
    selection.status !== "none" ||
    state.receipt !== null ||
    state.issue !== null ||
    workspaceNotice;
  if (!open || collapsed) return null;

  return (
    <aside
      aria-label="Site Builder details"
      className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-overlay bg-surface-panel p-3 text-text-primary"
    >
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
      <WorkspaceStatus state={state} controller={controller} worktreePath={props.worktreePath} />
      <SelectionBody state={state} />
      {state.workspace.status === "ready" ? (
        <AgentComposer
          memoryKey={memoryKey}
          controller={controller}
          selection={selection}
          worktreeId={props.worktreeId}
          worktreePath={props.worktreePath}
        />
      ) : null}
      {selection.status === "ready" ? (
        <details
          open={editsOpen}
          onToggle={(event) => setEditsOpen(event.currentTarget.open)}
          className="group flex flex-col gap-3 border-t border-border-subtle pt-3"
        >
          <summary className="cursor-pointer select-none text-xs font-medium text-text-secondary">
            Edit directly
          </summary>
          <SelectionEdits state={state} selection={selection} actions={actionsFor(controller)} />
        </details>
      ) : null}
      {state.receipt ? (
        <ReceiptView state={state.receipt} onUndo={() => void controller.undo()} />
      ) : null}
    </aside>
  );
}

function workspaceNeedsAttention(state: InspectorState): boolean {
  const workspace = state.workspace;
  if (workspace.status === "ready") return workspace.support.level !== "full";
  return workspace.status !== "idle" && workspace.status !== "opening";
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
    case "opening":
      return null;
    case "no-worktree":
      return (
        <InspectorNotice tone="info" title="Preview only — no worktree">
          This preview isn't attached to a worktree, so elements can't be traced to source.
        </InspectorNotice>
      );
    case "no-app":
      return (
        <InspectorNotice tone="info" title="Preview only — no SvelteKit app found">
          You can select in the preview, but there's no SvelteKit source in this worktree to trace
          it to.
        </InspectorNotice>
      );
    case "ambiguous":
      return (
        <section aria-labelledby="site-builder-apps" className="flex flex-col gap-2">
          <h2 id="site-builder-apps" className="text-xs font-medium text-text-secondary">
            Which app is this preview showing?
          </h2>
          <ul className="flex flex-col gap-1">
            {workspace.appRoots.map((appRoot) => (
              <li key={appRoot}>
                <Button
                  variant="subtle"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => void controller.openWorkspace(appRoot)}
                >
                  {relativeTo(worktreePath, appRoot) === "." ? (
                    "Worktree root"
                  ) : (
                    <span className="font-mono">{relativeTo(worktreePath, appRoot)}</span>
                  )}
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
        <InspectorNotice tone="warning" title="Editing isn't supported for this project">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {workspace.support.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </InspectorNotice>
      );
  }
}

function SelectionBody({ state }: { state: InspectorState }) {
  const selection = state.selection;
  switch (selection.status) {
    case "none":
      return null;
    case "resolving":
      return <WaitingRow label="Finding the source for this element" />;
    case "observed":
      return (
        <section aria-label="Selected element" className="flex flex-col gap-1">
          <p className="truncate text-sm text-text-primary">{selection.node.label}</p>
          <p className="text-xs text-text-secondary">This element couldn't be traced to source</p>
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
          The page changed while its source was being found. Click the element again.
        </InspectorNotice>
      );
    case "failed":
      return (
        <InspectorNotice tone="error" title="Couldn't select this element" role="alert">
          {selection.message}
        </InspectorNotice>
      );
    case "ready":
      return <SelectionIdentity selection={selection} />;
  }
}
