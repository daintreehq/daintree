import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  ChevronRight,
  FolderCode,
  FolderTree,
  FolderX,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  SquareDashedMousePointer,
  Unplug,
  X,
} from "lucide-react";
import type { DevPreviewToolSurfaceProps } from "@/registry/devPreviewToolRegistry";
import type { SelectedNode } from "../shared/model.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { KBD_COMPACT_CLASS } from "@/components/ui/Kbd";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INITIAL_INSPECTOR_STATE,
  type InspectorController,
  type InspectorState,
  type WorkspaceState,
} from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { PropertyRow, SectionHeader } from "./InspectorSection.js";
import { SelectionIdentity } from "./SelectionCard.js";
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
import { scopesFor, type CallSite } from "./agentTask.js";
import {
  DETACH_COPY,
  UNTESTED_TOOLCHAIN_TITLE,
  relativeTo,
  untestedToolchainDetail,
} from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor, type PickedCrumb } from "./SelectionTrail.js";

const MODE_OPTIONS = [
  { value: "browse" as const, label: "Browse" },
  { value: "select" as const, label: "Select" },
];

/**
 * The builder for the dev preview hosting it: the host's session for this
 * preview, shared by the strip and the drawer and outliving both. The host
 * creates it when the builder is switched on, keeps it telling the controller
 * which worktree and page the preview is on, and disposes it when the builder,
 * the preview or the plugin ends — so a surface only reads it.
 */
function useBuilder(props: DevPreviewToolSurfaceProps<InspectorController>): {
  controller: InspectorController | null;
  state: InspectorState;
} {
  const controller = props.session;
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getSnapshot ?? initialSnapshot
  );
  return { controller, state };
}

const subscribeNothing = (): (() => void) => () => {};
const initialSnapshot = (): InspectorState => INITIAL_INSPECTOR_STATE;

/**
 * Selecting a component from a surface's trail, with focus accounted for.
 *
 * The crumb is a button that the page's answer replaces with text — and the
 * whole trail leaves while the source is being found — so a keyboard user who
 * pressed Enter on it would be dropped on the document body. When focus was in
 * the surface at the click, it is put on what `landing` finds in the surface
 * once the new selection is ready. A mouse click in Safari does not focus a
 * button, and then nothing is moved.
 *
 * The intent is for one answer: it is dropped when the pick is refused, when
 * the selection ends anywhere but ready, and after a bound wait — so a page
 * click made after an abandoned pick never has its focus pulled into a
 * surface the user has left.
 *
 * Undefined while a pick can't be made, so the crumbs are plain text rather
 * than buttons that do nothing.
 */
function useSelectCrumb(
  controller: InspectorController | null,
  state: InspectorState,
  root: RefObject<HTMLElement | null>,
  landing: (root: HTMLElement) => HTMLElement | null
): ((usedAt: CallSite) => void) | undefined {
  // The generation the pick was made from; the answer advances it.
  const pending = useRef<{ generation: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const status = state.selection.status;
  const generation = state.selectionGeneration;
  const drop = () => {
    if (pending.current === null) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useEffect(() => {
    if (pending.current === null || status === "resolving") return;
    if (status !== "ready") {
      drop();
      return;
    }
    if (generation === pending.current.generation) return;
    drop();
    const target = root.current ? landing(root.current) : null;
    target?.focus();
  });
  useEffect(() => drop, []);
  if (controller === null || !controller.canSelectComponent()) return undefined;
  return (usedAt) => {
    drop();
    const focused = root.current?.contains(document.activeElement) ?? false;
    if (focused) {
      pending.current = { generation, timer: setTimeout(drop, CRUMB_FOCUS_WAIT_MS) };
    }
    void controller.selectComponent(usedAt).then((sent) => {
      if (!sent) drop();
    });
  };
}

/** How long a crumb's answer may take before its focus intent lapses. */
const CRUMB_FOCUS_WAIT_MS = 3000;

/**
 * Where focus lands in the strip after a crumb: the innermost crumb still
 * selectable, else the strip's first control. A button, so the toolbar's
 * roving keys keep working from there.
 */
function stripLanding(root: HTMLElement): HTMLElement | null {
  const crumbs = root.querySelectorAll<HTMLElement>('nav[aria-label="Breadcrumb"] button');
  return crumbs[crumbs.length - 1] ?? root.querySelector<HTMLElement>("button");
}

/** The drawer's identity block, which is there the moment the selection is ready. */
function drawerLanding(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[aria-label="Selected element"]');
}

/** The strip under the browser toolbar: mode, what is selected, and close. */
export function SiteBuilderToolbar(props: DevPreviewToolSurfaceProps<InspectorController>) {
  const { controller, state } = useBuilder(props);
  const bound = state.binding.status === "bound";
  // The APG toolbar contract: the whole row is one tab stop, Left/Right move
  // between its controls. The row claimed `role="toolbar"` while every control
  // kept its own tab stop, so reaching the page past it cost five presses.
  // `useToolbarRoving` is the house implementation — four other toolbars use it.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const onStripKeyDown = useToolbarRoving(stripRef);
  const drawerCollapsed = useDrawerCollapsed(props.panelId);
  const selectCrumb = useSelectCrumb(controller, state, stripRef, stripLanding);
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
        <StripStatus
          state={state}
          controller={controller}
          bound={bound}
          drawerShowing={!drawerCollapsed}
          selectCrumb={selectCrumb}
        />
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
  drawerShowing,
  selectCrumb,
}: {
  state: InspectorState;
  controller: InspectorController;
  bound: boolean;
  /** The drawer is open beside the page and already names the source. */
  drawerShowing: boolean;
  /** Select a component from the trail; absent while that can't be done. */
  selectCrumb: ((usedAt: CallSite) => void) | undefined;
}) {
  const binding = state.binding;
  if (binding.status === "detached") {
    return (
      <>
        <StripMessage icon={Unplug}>{DETACH_COPY[binding.reason]}</StripMessage>
        {/* The strip's only action: `secondary` has a fill and a ring, where
            `subtle` sat in the same grey as the sentence before it. */}
        <Button variant="secondary" size="xs" onClick={() => void controller.connect()}>
          Reconnect
        </Button>
      </>
    );
  }
  if (binding.status === "failed") {
    return (
      <>
        <StripMessage icon={AlertTriangle} tone="warning" title={binding.message}>
          {binding.retrying
            ? "Waiting for the page to load"
            : `Couldn't connect to the page — ${binding.message}`}
        </StripMessage>
        <Button variant="secondary" size="xs" onClick={() => void controller.retryConnect()}>
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
            onSelect={selectCrumb}
          />
          {pickedIndex > 0 ? (
            <Badge size="xs" tone="outline">
              Component
            </Badge>
          ) : null}
          <KeyHints />
          {location && !drawerShowing ? (
            <>
              <div aria-hidden="true" className="toolbar-divider mx-1 h-4 w-px shrink-0" />
              <span
                className="min-w-0 shrink truncate font-mono text-3xs text-text-secondary"
                title={location}
              >
                {middleTruncatePath(location, 38)}
              </span>
            </>
          ) : null}
        </>
      );
    }
  }
  if (selection.status === "resolving") return <WaitingRow label="Finding the source" />;
  if (state.mode === "select") {
    // The strip must not contradict the drawer: an invitation to click while
    // the drawer says the source could not be opened is two surfaces telling
    // two stories. The workspace's state is the strip's state too.
    const workspace = state.workspace;
    if (workspace.status === "ambiguous") {
      return <StripMessage icon={FolderTree}>Choose which app this preview shows</StripMessage>;
    }
    if (workspace.status === "no-app") {
      return <StripMessage icon={FolderX}>No SvelteKit app in this worktree</StripMessage>;
    }
    if (workspace.status === "failed") {
      return (
        <StripMessage icon={AlertTriangle} tone="warning" title={workspace.message}>
          Couldn't open the site source
        </StripMessage>
      );
    }
    // One sentence, whatever the project's Svelte version: what the builder
    // offers is the same for every app it can trace.
    return (
      <StripMessage icon={SquareDashedMousePointer}>
        Click an element to ask an agent about it
      </StripMessage>
    );
  }
  return (
    <StripMessage icon={MousePointer2}>Browsing — switch to Select to pick an element</StripMessage>
  );
}

/**
 * Every strip sentence leads with a glyph in the same slot, so the text starts
 * at one x whatever the state; states without one made the sentence jump as
 * the page connected, armed and detached.
 */
function StripMessage({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  tone?: "warning";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={title}>
      <Icon
        className={cn("h-3.5 w-3.5 shrink-0", tone === "warning" && "text-status-warning")}
        aria-hidden="true"
      />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * The strip's trail ends at what is selected: the component when a component
 * was picked, the element otherwise. The strip has no header, so the selection
 * is its terminal crumb; every crumb above it selects that component.
 */
function StripTrail({
  node,
  picked,
  onSelect,
}: {
  node: SelectedNode;
  picked: PickedCrumb | null;
  onSelect: ((usedAt: CallSite) => void) | undefined;
}) {
  const { above, current } = trailFor(node, picked);
  return (
    <SelectionTrail
      crumbs={[...above, current]}
      currentIndex={above.length}
      currentLabel={current.label}
      onSelect={
        onSelect
          ? (crumb) => {
              if (crumb.usedAt) onSelect(crumb.usedAt);
            }
          : undefined
      }
      className="min-w-0 flex-1"
    />
  );
}

/**
 * The drawer beside the page. Closed until there is something to show, so the
 * site keeps its full width while you browse and pick.
 */
export function SiteBuilderDrawer(props: DevPreviewToolSurfaceProps<InspectorController>) {
  const { controller, state } = useBuilder(props);
  const memoryKey = composerMemoryKey(props.panelId, props.worktreeId);
  // A draft or an agent request outlives the selection it was about; keep
  // both reachable.
  const composer = useComposerMemory(memoryKey);
  const collapsed = useDrawerCollapsed(props.panelId);
  const drawerRef = useRef<HTMLElement | null>(null);
  const selectCrumb = useSelectCrumb(controller, state, drawerRef, drawerLanding);
  if (!controller) return null;
  const selection = state.selection;
  const workspaceNotice = workspaceNeedsAttention(state);
  const open =
    composer.delivery !== null ||
    composer.draft.trim() !== "" ||
    selection.status !== "none" ||
    state.issue !== null ||
    workspaceNotice;
  if (!open || collapsed) return null;

  return (
    <aside
      ref={drawerRef}
      aria-label="Site Builder details"
      // Width, resizing, the narrow-pane policy and the `@container/drawer` the
      // rows below answer to all belong to the host's drawer chrome
      // (`src/components/DevPreview/DevPreviewToolDrawerChrome.tsx`); this fills
      // whatever it is given. Rendering nothing is still how the drawer stays
      // shut — the chrome hides itself when there is nothing inside it.
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Pinned. A desktop inspector always says what is selected; a form
          scrolls it away. */}
      {selection.status === "ready" ? (
        <div className="shrink-0 border-b border-border-subtle px-3 pb-2 pt-3">
          <SelectionIdentity
            selection={selection}
            worktreePath={props.worktreePath}
            onSelectComponent={selectCrumb}
          />
        </div>
      ) : selection.status === "resolving" ? (
        <ResolvingHeader />
      ) : null}

      {/* One inset in every state. The two used to differ because a disclosure
          header carried its own padding under the rule; with the composer
          starting directly there, a 4px gap read as the panel touching its own
          divider. */}
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

        {/* The panel's one route, and therefore not a section of it. There is no
          header, no glyph and no disclosure: this plugin exists to hand a
          selection to an agent, so the composer is what the drawer *is* below
          its identity. A header would have named the obvious and spent 32px of
          a 360px panel doing it; a disclosure would have let the user fold away
          the only thing here. `aria-label` on the composer keeps the grouping
          for assistive technology without drawing one. */}
        {state.workspace.status === "ready" &&
        (selection.status === "ready" ||
          composer.draft.trim() !== "" ||
          composer.delivery !== null) ? (
          <AgentComposer
            memoryKey={memoryKey}
            controller={controller}
            selection={selection}
            worktreeId={props.worktreeId}
            worktreePath={props.worktreePath}
          />
        ) : null}
      </ScrollShadow>
    </aside>
  );
}

function workspaceNeedsAttention(state: InspectorState): boolean {
  const workspace = state.workspace;
  // Several apps keep the drawer open for the switcher: choosing the wrong one
  // must stay fixable before anything is selected, and after a switch clears it.
  //
  // A ready workspace's only other subject is the support verdict, and a
  // diagnostic nobody has to act on does not earn opening the drawer: it waits
  // in Site source for something else to open it. It used to also raise whether
  // direct editing and class completion were available here — neither of which
  // the builder does, so their absence is not a gap the user can do anything
  // about, and saying so was a warning about a road that isn't there.
  if (workspace.status === "ready") return workspace.appRoots.length > 1;
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
  if (workspace.status === "ready" && !readyHasSomethingToSay(workspace)) return null;
  // One surface for everything about the project rather than the element, so
  // a setup problem and an element-level limitation never look like the same
  // kind of notice sat in the same column.
  return (
    <section aria-label="Site source" className="flex flex-col gap-1">
      <SectionHeader title="Site source" icon={FolderCode} />
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
          <ul
            // Bled to the rows' own padding so their text lines up with the
            // sentence above; the dividers run the row's full width.
            className="-mx-2 flex flex-col divide-y divide-border-subtle"
            aria-label="Choose site source"
          >
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
          {/* A sentence first; then the diagnostic — EACCES, ENOENT — which is
              the one thing the user can act on, in its own face so it reads as
              a diagnostic rather than as prose that ran on. */}
          <span className="block">Daintree couldn't read this site's source.</span>
          <span className="mt-1 block break-all font-mono text-3xs">{workspace.message}</span>
        </InspectorNotice>
      );
    case "ready": {
      if (!readyHasSomethingToSay(workspace)) return null;
      const untested = workspace.support.level === "untested" ? workspace.support.reasons : null;
      return (
        <div className="flex flex-col gap-1">
          {untested ? (
            // What the bundled compiler was tested against, said once and left
            // alone: an observation, so `info` and no action. It does not open
            // the drawer by itself — nothing about the app is worse for it, and
            // the builder offers exactly what it offers either way.
            <InspectorNotice tone="info" title={UNTESTED_TOOLCHAIN_TITLE} density="compact">
              {untestedToolchainDetail(untested)}
            </InspectorNotice>
          ) : null}
          {/* Choosing the wrong app has to be recoverable from where the
              choice shows, not by closing the builder to be asked again. */}
          {workspace.appRoots.length > 1 ? (
            <PropertyRow label="App">
              <Select
                value={workspace.appRoot}
                onValueChange={(appRoot) => controller.switchApp(appRoot)}
              >
                <SelectTrigger
                  aria-label="Site source app"
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="w-[var(--radix-select-trigger-width)]">
                  {workspace.appRoots.map((appRoot) => {
                    const relative = relativeTo(worktreePath, appRoot);
                    return (
                      <SelectItem
                        key={appRoot}
                        value={appRoot}
                        title={appRoot}
                        className="font-mono"
                      >
                        {/* A monorepo path runs longer than a trigger-width
                            popup; without asking to truncate it is cut at the
                            edge with no ellipsis. */}
                        <span className="block truncate">{relative === "." ? "./" : relative}</span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </PropertyRow>
          ) : null}
        </div>
      );
    }
  }
}

/** A ready workspace shows the section for the app switcher, or for the verdict. */
function readyHasSomethingToSay(workspace: Extract<WorkspaceState, { status: "ready" }>): boolean {
  return workspace.appRoots.length > 1 || workspace.support.level === "untested";
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
