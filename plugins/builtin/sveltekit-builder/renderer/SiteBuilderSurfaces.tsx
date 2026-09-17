import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  SquareDashedMousePointer,
  X,
} from "lucide-react";
import type { DevPreviewToolSurfaceProps } from "@/registry/devPreviewToolRegistry";
import type { SelectedNode } from "../shared/model.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
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
import { InspectorDisclosure, SectionHeader } from "./InspectorSection.js";
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
import { IdentitySkeleton } from "./IdentitySkeleton.js";
import { useDeferredLoading, useDohertyGate } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { scopesFor } from "./agentTask.js";
import { DETACH_COPY, relativeTo } from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";

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
  // The APG toolbar contract: the whole row is one tab stop, Left/Right move
  // between its controls. The row claimed `role="toolbar"` while every control
  // kept its own tab stop, so reaching the page past it cost five presses.
  // `useToolbarRoving` is the house implementation — four other toolbars use it.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const onStripKeyDown = useToolbarRoving(stripRef);
  if (!controller) {
    return (
      <div
        ref={stripRef}
        role="toolbar"
        aria-label="Site Builder"
        onKeyDown={onStripKeyDown}
        className="flex h-8 shrink-0 items-center gap-2 border-b border-overlay bg-surface px-2"
      >
        <WaitingRow label="Starting the Site Builder" />
      </div>
    );
  }

  return (
    <div
      ref={stripRef}
      role="toolbar"
      aria-label="Site Builder"
      onKeyDown={onStripKeyDown}
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
    // `KBD_COMPACT_CLASS`, not a hand-rolled box: the product already has one
    // key-cap grammar and this row is exactly the dense case it was tightened
    // for. Unstyled, the two hints and the file path beside them read as one
    // running sentence.
    <span className="ml-auto hidden shrink-0 items-center gap-2 text-3xs text-text-secondary @[640px]/strip:flex">
      <span className="flex items-center gap-1">
        <kbd className={KBD_COMPACT_CLASS}>↑↓←→</kbd>
        move
      </span>
      <span className="flex items-center gap-1">
        <kbd className={KBD_COMPACT_CLASS}>⌥↑</kbd>
        component
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
          {/* The same trail the drawer draws, from the same function. The two
              used to build their own and disagreed about where the chain starts
              and whether `each` counts as a step. */}
          {/* The strip has no header, so its trail ends at what is selected —
              the component when a component was picked, the element otherwise.
              It used to always end at the element, so a component selection was
              presented as though an element were current. */}
          <StripTrail
            node={node}
            picked={
              picked?.kind === "component" ? { label: picked.label, usedAt: picked.usedAt } : null
            }
          />
          {pickedIndex > 0 ? (
            <Badge size="xs" tone="outline">
              Component
            </Badge>
          ) : null}
          <KeyHints />
          {location ? (
            <span
              className="ml-2 min-w-0 shrink truncate font-mono text-3xs text-text-secondary"
              title={location}
            >
              {middleTruncatePath(location, 38)}
            </span>
          ) : null}
        </>
      );
    }
  }
  if (selection.status === "resolving") return <WaitingRow label="Finding the source" />;
  if (state.mode === "select") {
    // The armed state has a glyph: without one, "click any element" read as
    // placeholder text in a disabled field, and nothing said picking was live.
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <SquareDashedMousePointer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Select an element to edit it or ask an agent</span>
      </span>
    );
  }
  return <span className="truncate">Browsing — switch to Select to pick an element</span>;
}

/**
 * The strip's trail ends at what is selected: the component when a component
 * was picked, the element otherwise. Current is passed by position — a label
 * match would pick the first of two nested components sharing a name, so the
 * LAST crumb carrying the picked label is taken, which is the innermost.
 */
function StripTrail({
  node,
  picked,
}: {
  node: SelectedNode;
  picked: { label: string; usedAt: { file: string; line: number; column: number } | null } | null;
}) {
  // The trail ends at the selection: crumbs inside a picked component are the
  // route the selection was reached THROUGH, not where it is. The picked
  // component is matched by its call site, never by label — two nested
  // components can share a name.
  const all = trailFor(node, { includeSelf: picked === null });
  let currentIndex = all.length - 1;
  if (picked?.usedAt) {
    const site = picked.usedAt;
    const index = all.findIndex(
      (crumb) =>
        crumb.usedAt !== null &&
        crumb.usedAt.file === site.file &&
        crumb.usedAt.line === site.line &&
        crumb.usedAt.column === site.column
    );
    if (index !== -1) currentIndex = index;
  }
  const crumbs = all.slice(0, currentIndex + 1);
  return (
    <SelectionTrail
      crumbs={crumbs}
      currentIndex={currentIndex}
      currentLabel={picked?.label ?? node.label ?? "element"}
      className="min-w-0 flex-1"
    />
  );
}

/**
 * The drawer beside the page. Closed until there is something to show, so the
 * site keeps its full width while you browse and pick.
 */
export function SiteBuilderDrawer(props: DevPreviewToolSurfaceProps) {
  const { controller, state } = useBuilder(props);
  // Open by default, and held here rather than per-selection so picking the next
  // element doesn't fold away the editors.
  //
  // Direct editing is one of the two answers to "can I change this" — the other
  // being the composer below it — and the user in the tight loop (spot it,
  // click it, fix it) is reaching for it dozens of times a session. Starting it
  // collapsed made the cheapest route the one that costs an extra click, while
  // the empty composer held ~280px above it. Collapsing is a preference the
  // user expresses once and this remembers.
  const [editsOpen, setEditsOpen] = useState(true);
  // Its peer. Two section headers of the same rank, one with a chevron and one
  // without, left the reader guessing which of them folds.
  const [agentOpen, setAgentOpen] = useState(true);
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
      className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-overlay bg-surface-panel text-text-primary"
    >
      {/* Pinned. A desktop inspector always says what is selected; a form
          scrolls it away. */}
      {selection.status === "ready" ? (
        <div className="shrink-0 border-b border-border-subtle px-3 pb-2 pt-3">
          <SelectionIdentity
            selection={selection}
            worktreePath={props.worktreePath}
            reselecting={state.reselecting}
          />
        </div>
      ) : selection.status === "resolving" ? (
        <ResolvingHeader />
      ) : null}

      <ScrollShadow className="min-h-0 flex-1" scrollClassName="flex flex-col gap-3 p-3">
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
        {selection.status === "ready" ? null : <SelectionBody state={state} />}

        {/* The two routes, as peers. Direct editing used to sit below the composer
          inside a native `details`, which made a two-keystroke fix a
          disclose-and-scroll operation and put the editors below the fold on any
          laptop viewport — while the empty composer held ~280px above them. They
          answer the same question ("can I change it, and how"), so they get the
          same weight and the same section grammar. */}
        {selection.status === "ready" ? (
          <InspectorDisclosure title="Edit directly" open={editsOpen} onOpenChange={setEditsOpen}>
            <SelectionEdits state={state} selection={selection} actions={actionsFor(controller)} />
          </InspectorDisclosure>
        ) : null}

        {state.workspace.status === "ready" &&
        (selection.status === "ready" ||
          composer.draft.trim() !== "" ||
          composer.delivery !== null) ? (
          <InspectorDisclosure
            title="Ask an agent"
            icon={Sparkles}
            open={agentOpen}
            onOpenChange={setAgentOpen}
            // Full-bleed like the header's rule: an inset hairline beside a
            // full-width one was two divider treatments in one panel.
            className={
              selection.status === "ready"
                ? "-mx-3 border-t border-border-subtle px-3 pt-1"
                : undefined
            }
          >
            <AgentComposer
              memoryKey={memoryKey}
              controller={controller}
              selection={selection}
              worktreeId={props.worktreeId}
              worktreePath={props.worktreePath}
            />
          </InspectorDisclosure>
        ) : null}
      </ScrollShadow>

      {/* Pinned to the foot of the drawer, not trailing the content: a write and
          its Undo land in the same place every time. `mt-auto` only
          bottom-aligned it when the content happened to be short, so after any
          real edit the receipt was below the fold — the one control the user
          most needs to reach in a hurry. */}
      {state.receipt ? (
        <div className="shrink-0 border-t border-border-subtle px-3 pb-3 pt-2">
          <ReceiptView state={state.receipt} onUndo={() => void controller.undo()} />
        </div>
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
  if (workspace.status === "idle" || workspace.status === "opening") return null;
  if (workspace.status === "ready" && workspace.support.level === "full") return null;
  // One surface for everything about the project rather than the element, so
  // a setup problem and an element-level limitation never look like the same
  // kind of notice sat in the same column.
  return (
    <section aria-label="Site source" className="flex flex-col gap-1">
      <SectionHeader title="Site source" />
      <SiteSourceBody state={state} controller={controller} worktreePath={worktreePath} />
    </section>
  );
}

function SiteSourceBody({
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
        <InspectorNotice tone="info" title="Preview only — no worktree" density="compact">
          This preview isn't attached to a worktree, so elements can't be traced to source.
        </InspectorNotice>
      );
    case "no-app":
      return (
        <InspectorNotice
          tone="info"
          title="Preview only — no SvelteKit app found"
          density="compact"
        >
          You can select in the preview, but there's no SvelteKit source in this worktree to trace
          it to.
        </InspectorNotice>
      );
    case "ambiguous":
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-text-secondary">
            More than one SvelteKit app lives in this worktree. Choose the one this preview is
            showing.
          </p>
          {/* 28px path rows with a chevron: a choice list, not three bordered
              boxes that read as empty inputs. Every path in the same face. */}
          <ul className="flex flex-col" aria-label="Choose site source">
            {workspace.appRoots.map((appRoot) => {
              const relative = relativeTo(worktreePath, appRoot);
              return (
                <li key={appRoot}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full justify-between gap-2 px-2 font-mono text-xs font-normal"
                    title={appRoot}
                    onClick={() => void controller.openWorkspace(appRoot)}
                  >
                    <span className="min-w-0 truncate">{relative === "." ? "./" : relative}</span>
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-text-secondary"
                      aria-hidden="true"
                    />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      );
    case "failed":
      return (
        <InspectorNotice
          tone="error"
          role="alert"
          title="Couldn't open the site source"
          density="compact"
          action={
            <Button variant="subtle" size="xs" onClick={() => void controller.openWorkspace()}>
              Retry
            </Button>
          }
        >
          {/* The message is a runtime diagnostic — EACCES, ENOENT — and it is
              the one thing the user can act on, so it stays. In its own face,
              so it reads as a diagnostic rather than as prose that ran on. */}
          <span className="block break-all font-mono text-3xs">{workspace.message}</span>
        </InspectorNotice>
      );
    case "ready": {
      if (workspace.support.level === "full") return null;
      // Suggestions and direct editing are independent capabilities. Each is
      // a row that says whether it works here and why not, and whatever still
      // works is still offered.
      const suggestions = workspace.support.reasons.filter((reason) =>
        /tailwind|suggestion|completion/i.test(reason)
      );
      const editing = workspace.support.reasons.filter((reason) => !suggestions.includes(reason));
      return (
        <div className="flex flex-col gap-1">
          <CapabilityRow
            label="Direct editing"
            available={editing.length === 0}
            reasons={editing}
            note="You can still select elements and ask an agent to change them."
          />
          <CapabilityRow
            label="Class suggestions"
            available={suggestions.length === 0}
            reasons={suggestions}
            note={
              editing.length === 0
                ? "Classes you type are still written exactly as typed."
                : "Class names can't be checked for this project."
            }
          />
        </div>
      );
    }
  }
}

function CapabilityRow({
  label,
  available,
  reasons,
  note,
}: {
  label: string;
  available: boolean;
  reasons: string[];
  note: string;
}) {
  // A flat block rather than a 64px-labelled row: two capabilities are not a
  // property list, and the names that describe them accurately ("Class
  // suggestions") do not fit a label column. The name and its verdict share a
  // line; the reasons and what still works follow.
  return (
    <div className="flex flex-col gap-0.5 py-1 text-xs">
      <p className="flex items-center gap-1.5 text-text-primary">
        {available ? null : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-warning" aria-hidden="true" />
        )}
        <span className="font-medium">{label}</span>
        <span className="text-text-secondary">{available ? "available" : "unavailable"}</span>
      </p>
      {available
        ? null
        : reasons.map((reason) => (
            <p key={reason} className="text-text-secondary">
              {sentence(reason)}
            </p>
          ))}
      {available ? null : <p className="text-text-secondary">{note}</p>}
    </div>
  );
}

/**
 * The identity's own geometry, in the identity's own slot, while main finds
 * the source. Under the Doherty gate nothing; past it the skeleton of the block
 * that is coming, so a slow resolve settles into the panel it was always going
 * to become rather than swapping a status line for it. The row heights match
 * `SelectionIdentity` exactly (28/24/20), which is what keeps the sections
 * below from moving when the answer lands.
 */
function ResolvingHeader() {
  const visible = useDohertyGate(true);
  const slow = useDeferredLoading(true, UI_STILL_WORKING_MS);
  return (
    <div className="shrink-0 border-b border-border-subtle px-3 pb-2 pt-3" aria-busy="true">
      {visible ? (
        <IdentitySkeleton label={slow ? "Finding the source — still working…" : undefined} />
      ) : (
        <div className="h-20" aria-hidden="true" />
      )}
    </div>
  );
}

function SelectionBody({ state }: { state: InspectorState }) {
  const selection = state.selection;
  switch (selection.status) {
    case "none":
      return null;
    case "resolving":
      // The pinned header holds the skeleton; the body has nothing to add.
      return null;
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
      return <SelectionIdentity selection={selection} worktreePath={null} />;
  }
}

/** Main's reasons are clauses; followed by a second sentence they need a stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text : `${text}.`;
}
