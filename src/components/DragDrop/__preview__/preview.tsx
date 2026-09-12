import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { LazyMotion, domAnimation } from "framer-motion";
import { GripVertical } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PanelInstance } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { cn } from "@/lib/utils";
import { TerminalDragPreview } from "../TerminalDragPreview";
import { WorktreeDragPreview } from "../WorktreeDragPreview";
import { GridPlaceholder } from "../GridPlaceholder";
import { DockPlaceholder } from "../DockPlaceholder";
import { SortableTerminal } from "../SortableTerminal";
import { SortableDockItem } from "../SortableDockItem";
import {
  SortableWorktreeCard,
  getWorktreeSortDragId,
  parseWorktreeSortDragId,
} from "../SortableWorktreeCard";
import { useDragHandle } from "../DragHandleContext";
import { DndPlaceholderContext, IDLE_DND_PLACEHOLDER } from "../dndPlaceholderContext";
import {
  GHOSTS,
  WORKTREE_GHOSTS,
  PLACEHOLDER_KINDS,
  placeholderPanel,
  NEIGHBOURS,
  SIDEBAR_ROWS,
  type PlaceholderKind,
} from "./fixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for drag ghosts and drop placeholders.
 *
 * Every state this surface has exists only while a pointer (or a keyboard
 * drag) is held, which is why nothing had ever looked at it. This page makes
 * those states addressable in two ways:
 *
 * - **Forced.** The ghosts (`TerminalDragPreview`, `WorktreeDragPreview`) are
 *   rendered directly from fixtures; the placeholders (`GridPlaceholder`,
 *   `DockPlaceholder`) are rendered under a hand-built `DndPlaceholderContext`
 *   value, which is the same seam `DndProvider` feeds them through.
 * - **Sandboxed.** The source-dim and insertion-line states live inside
 *   dnd-kit's own `useSortable` and cannot be forced, so the `drag-*` scenes
 *   mount the real sortable wrappers in a bare `DndContext` (mouse sensor, no
 *   activation distance) and the screenshot spec performs a real pointer drag
 *   and captures mid-gesture. The overlay in those scenes is positioned by
 *   dnd-kit's default rect centring, not by `DndProvider`'s cursor modifier.
 *
 * What is real: every component under `src/components/DragDrop/`, the theme
 * tokens via `applyAppThemeToRoot`, and `index.css`. What is a stand-in: the
 * neighbouring grid panels, dock chips and sidebar rows, which copy the recipe
 * of `ContentPanel`, `DockedTerminalItem` and the worktree card closely enough
 * to judge whether a placeholder reads as native to its rail.
 *
 * Query parameters (the spec drives these):
 *   ?theme=daintree|bondi|…      built-in theme id
 *   ?scene=ghosts|grid|dock|drag-grid|drag-dock|drag-sidebar|sheet
 *   ?kind=terminal|agent|…|none  which panel the placeholder stands in for
 *   ?over=1                      dock scene: draw the rail's drag-over highlight
 *   ?dragging=0                  dock scene: render the idle spacer instead
 *   ?density=compact|comfortable dock scene: the dock density modes
 *   ?width=1100                  shell width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const scene = params.get("scene") ?? "ghosts";
const width = Number(params.get("width") ?? "1100");
const kindParam = params.get("kind") ?? "terminal";
const over = params.get("over") === "1";
const dragging = params.get("dragging") !== "0";
const density = params.get("density");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function resolveKind(value: string): PlaceholderKind | null {
  if (value === "none") return null;
  return PLACEHOLDER_KINDS.find((kind) => kind === value) ?? "terminal";
}

const FAUX_OUTPUT = [
  "$ npm test -- src/refund",
  "✓ partial refund is idempotent (42 ms)",
  "✓ audit trail records operator (11 ms)",
  "2 passing",
];

/** Stands in for a grid `ContentPanel`: same frame recipe, a header that is the drag handle. */
function FixturePanel({ terminal }: { terminal: PanelInstance }) {
  const handle = useDragHandle();
  const chrome = deriveTerminalChrome(terminal);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border-default bg-surface-panel shadow-[var(--theme-shadow-ambient)]">
      <div
        ref={handle?.setActivatorNodeRef}
        {...handle?.listeners}
        data-fixture-handle=""
        className="flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-border-default bg-overlay-subtle px-3 text-xs"
      >
        <TerminalIcon kind={terminal.kind} chrome={chrome} className="h-3.5 w-3.5" />
        <span className="truncate font-medium text-text-secondary">{terminal.title}</span>
      </div>
      <div className="flex-1 p-3 font-mono text-xs leading-5 text-text-secondary">
        {FAUX_OUTPUT.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </div>
  );
}

/** Stands in for `DockedTerminalItem`: the chip recipe, as a drag handle. */
function FixtureChip({ terminal }: { terminal: PanelInstance }) {
  const handle = useDragHandle();
  const chrome = deriveTerminalChrome(terminal);
  return (
    <button
      type="button"
      ref={handle?.setActivatorNodeRef}
      {...handle?.listeners}
      data-dock-item=""
      className="flex h-[var(--dock-item-height)] max-w-[280px] cursor-grab items-center gap-1.5 rounded-md border border-[var(--dock-item-border)] bg-[var(--dock-item-bg)] px-3 text-xs text-text-secondary"
    >
      <TerminalIcon kind={terminal.kind} chrome={chrome} className="h-3.5 w-3.5" />
      <span className="truncate">{terminal.title}</span>
    </button>
  );
}

/** Stands in for a sidebar worktree card: grip, title line, branch line. */
function FixtureRow({
  worktree,
  listeners,
  activatorRef,
}: {
  worktree: WorktreeSnapshot;
  listeners: SyntheticListenerMap | undefined;
  activatorRef: (node: HTMLElement | null) => void;
}) {
  const title = worktree.issueTitle ?? worktree.branch ?? worktree.name;
  return (
    <div className="mx-2 my-0.5 flex items-start gap-2 rounded-md border border-border-default bg-surface-panel px-2 py-2">
      <button
        type="button"
        ref={activatorRef}
        {...listeners}
        aria-label="Reorder worktree"
        className="mt-0.5 flex h-4 w-4 shrink-0 cursor-grab items-center justify-center text-text-secondary"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-text-primary">{title}</div>
        <div className="truncate font-mono text-2xs text-text-secondary">{worktree.branch}</div>
      </div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <div className="font-mono text-2xs text-text-secondary">{children}</div>;
}

function GhostGallery() {
  return (
    <div
      data-preview-shell=""
      className="flex flex-col gap-10 bg-noise bg-[var(--color-grid-bg)] p-6"
      style={{ width }}
    >
      <div className="grid grid-cols-4 gap-x-6 gap-y-8">
        {Object.entries(GHOSTS).map(([name, fixture]) => (
          <figure key={name} className="m-0 flex flex-col gap-2">
            {/* Padding keeps the group badge, which hangs outside the card, inside the crop. */}
            <div data-shot={`ghost-${name}`} className="inline-flex self-start p-3">
              <TerminalDragPreview
                terminal={fixture.terminal}
                groupTabCount={fixture.groupTabCount}
              />
            </div>
            <figcaption className="m-0">
              <Caption>{name}</Caption>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-x-6 gap-y-8">
        {Object.entries(WORKTREE_GHOSTS).map(([name, fixture]) => (
          <figure key={name} className="m-0 flex flex-col gap-2">
            <div data-shot={`wt-${name}`} className="inline-flex self-start p-3">
              <WorktreeDragPreview worktree={fixture.worktree} />
            </div>
            <figcaption className="m-0">
              <Caption>worktree · {name}</Caption>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The grid container recipe from `ContentGridDefault`. */
function GridShell({ children, rows = 240 }: { children: ReactNode; rows?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-1 bg-noise bg-[var(--color-grid-bg)] p-1"
      style={{ gridAutoRows: rows }}
    >
      {children}
    </div>
  );
}

function GridScene() {
  const kind = resolveKind(kindParam);
  const active = kind ? placeholderPanel(kind) : null;
  return (
    <DndPlaceholderContext.Provider
      value={{
        ...IDLE_DND_PLACEHOLDER,
        activeTerminal: active,
        isDragging: true,
        sourceContainer: "grid",
        placeholderIndex: 1,
      }}
    >
      <div data-preview-shell="" className="flex flex-col" style={{ width }}>
        <GridShell>
          <FixturePanel terminal={NEIGHBOURS[0]!} />
          <div data-shot="grid-placeholder" className="h-full min-w-0">
            <GridPlaceholder />
          </div>
          <FixturePanel terminal={NEIGHBOURS[2]!} />
          <FixturePanel terminal={NEIGHBOURS[3]!} />
        </GridShell>
      </div>
    </DndPlaceholderContext.Provider>
  );
}

/** The dock rail recipe from `ContentDock`, including its drag-over highlight. */
function DockRail({
  children,
  highlighted = false,
}: {
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <div className="border-t border-border-default bg-[var(--dock-bg)] px-1 py-[var(--dock-padding-y)]">
      <div
        className={cn(
          "flex min-h-[var(--dock-item-height)] items-center gap-[var(--dock-gap)] px-1",
          highlighted && "rounded-md bg-overlay-soft ring-2 ring-inset ring-border-default"
        )}
      >
        <div className="flex min-h-[calc(var(--dock-item-height)-4px)] min-w-[100px] items-center gap-[var(--dock-gap)]">
          {children}
        </div>
      </div>
    </div>
  );
}

function DockScene() {
  const kind = resolveKind(kindParam) ?? "terminal";
  return (
    <DndPlaceholderContext.Provider
      value={{
        ...IDLE_DND_PLACEHOLDER,
        activeTerminal: placeholderPanel(kind),
        isDragging: dragging,
        sourceContainer: "grid",
      }}
    >
      <div
        data-preview-shell=""
        data-dock-density={density ?? undefined}
        className="flex flex-col gap-6 bg-surface-canvas"
        style={{ width }}
      >
        <div className="flex flex-col">
          <div className="h-12 bg-noise bg-[var(--color-grid-bg)]" />
          <DockRail highlighted={over}>
            <div data-shot="dock-placeholder" className="h-full">
              <DockPlaceholder />
            </div>
          </DockRail>
          <div className="px-2 pt-1">
            <Caption>
              empty dock during a drag{over ? ", pointer over the rail" : ""} — the only place the
              dock placeholder renders
            </Caption>
          </div>
        </div>
        <div className="flex flex-col">
          <div className="h-12 bg-noise bg-[var(--color-grid-bg)]" />
          <DockRail>
            {NEIGHBOURS.slice(0, 3).map((terminal) => (
              <FixtureChip key={terminal.id} terminal={terminal} />
            ))}
          </DockRail>
          <div className="px-2 pt-1">
            <Caption>reference — real chip recipe at the same density</Caption>
          </div>
        </div>
      </div>
    </DndPlaceholderContext.Provider>
  );
}

/**
 * A bare DndContext for the states only dnd-kit can produce. Publishes the
 * active id on the shell so the spec can wait for the gesture to register.
 */
function Sandbox({
  overlay,
  children,
}: {
  overlay: (activeId: string | null) => ReactNode;
  children: (activeId: string | null) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(MouseSensor));
  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragEnd={() => setActiveId(null)}
      onDragCancel={() => setActiveId(null)}
    >
      <div data-sandbox-active={activeId ?? undefined}>{children(activeId)}</div>
      <DragOverlay dropAnimation={null}>{overlay(activeId)}</DragOverlay>
    </DndContext>
  );
}

function panelById(id: string | null): PanelInstance | undefined {
  return NEIGHBOURS.find((p) => p.id === id);
}

function GridSandbox() {
  return (
    <Sandbox
      overlay={(id) => {
        const t = panelById(id);
        return t ? <TerminalDragPreview terminal={t} /> : null;
      }}
    >
      {() => (
        <SortableContext items={NEIGHBOURS.map((p) => p.id)} strategy={rectSortingStrategy}>
          <GridShell>
            {NEIGHBOURS.map((terminal, index) => (
              <SortableTerminal
                key={terminal.id}
                terminal={terminal}
                sourceLocation="grid"
                sourceIndex={index}
              >
                <FixturePanel terminal={terminal} />
              </SortableTerminal>
            ))}
          </GridShell>
        </SortableContext>
      )}
    </Sandbox>
  );
}

function DockSandbox() {
  const chips = NEIGHBOURS.slice(0, 3);
  return (
    <Sandbox
      overlay={(id) => {
        const t = panelById(id);
        return t ? <TerminalDragPreview terminal={t} /> : null;
      }}
    >
      {() => (
        <SortableContext items={chips.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          <DockRail>
            {chips.map((terminal, index) => (
              <SortableDockItem key={terminal.id} terminal={terminal} sourceIndex={index}>
                <FixtureChip terminal={terminal} />
              </SortableDockItem>
            ))}
          </DockRail>
        </SortableContext>
      )}
    </Sandbox>
  );
}

function SidebarSandbox() {
  const order = SIDEBAR_ROWS.map((w) => getWorktreeSortDragId(w.id));
  return (
    <Sandbox
      overlay={(id) => {
        const worktreeId = id ? parseWorktreeSortDragId(id) : null;
        const w = SIDEBAR_ROWS.find((row) => row.id === worktreeId);
        return w ? <WorktreeDragPreview worktree={w} /> : null;
      }}
    >
      {() => (
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div role="grid" aria-label="Worktrees" className="w-[280px] bg-surface-sidebar py-1">
            {SIDEBAR_ROWS.map((worktree, index) => (
              <SortableWorktreeCard
                key={worktree.id}
                worktreeId={worktree.id}
                dragStartOrder={SIDEBAR_ROWS.map((w) => w.id)}
                ariaRowIndex={index + 1}
                isActive={index === 0}
              >
                {({ dragHandleListeners, dragHandleActivatorRef }) => (
                  <FixtureRow
                    worktree={worktree}
                    listeners={dragHandleListeners}
                    activatorRef={dragHandleActivatorRef}
                  />
                )}
              </SortableWorktreeCard>
            ))}
          </div>
        </SortableContext>
      )}
    </Sandbox>
  );
}

function DragScene({ which }: { which: "grid" | "dock" | "sidebar" }) {
  return (
    <div data-preview-shell="" className="flex flex-col bg-surface-canvas" style={{ width }}>
      {which === "grid" && <GridSandbox />}
      {which === "dock" && (
        // Left and bottom room for the overlay ghost, which dnd-kit positions
        // from the source chip's rect and which hangs below the rail mid-drag.
        <div className="flex flex-col pl-48">
          <div className="h-12 bg-noise bg-[var(--color-grid-bg)]" />
          <DockSandbox />
          <div className="h-44" />
        </div>
      )}
      {which === "sidebar" && (
        <div className="pb-24">
          <SidebarSandbox />
        </div>
      )}
    </div>
  );
}

/** One page per theme for the 15-theme sweep: the whole system side by side. */
function Sheet() {
  const sheetGhosts = ["claude-working", "browser", "review"] as const;
  return (
    <DndPlaceholderContext.Provider
      value={{
        ...IDLE_DND_PLACEHOLDER,
        activeTerminal: placeholderPanel("agent"),
        isDragging: true,
        sourceContainer: "grid",
        placeholderIndex: 1,
      }}
    >
      <div
        data-preview-shell=""
        className="grid grid-cols-[minmax(0,1fr)_300px] gap-4 bg-surface-canvas p-4"
        style={{ width }}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-start gap-6 bg-noise bg-[var(--color-grid-bg)] p-4">
            {sheetGhosts.map((name) => (
              <TerminalDragPreview
                key={name}
                terminal={GHOSTS[name]!.terminal}
                groupTabCount={name === "claude-working" ? 3 : undefined}
              />
            ))}
            <WorktreeDragPreview worktree={WORKTREE_GHOSTS.issue!.worktree} />
          </div>
          <GridShell rows={200}>
            <FixturePanel terminal={NEIGHBOURS[0]!} />
            <div className="h-full min-w-0">
              <GridPlaceholder />
            </div>
          </GridShell>
          <DockRail highlighted>
            <DockPlaceholder />
          </DockRail>
          <div data-sheet-dock="">
            <DockSandbox />
          </div>
          <div className="h-44" />
        </div>
        <div data-sheet-sidebar="" className="self-start">
          <SidebarSandbox />
        </div>
      </div>
    </DndPlaceholderContext.Provider>
  );
}

function Preview() {
  switch (scene) {
    case "grid":
      return <GridScene />;
    case "dock":
      return <DockScene />;
    case "drag-grid":
      return <DragScene which="grid" />;
    case "drag-dock":
      return <DragScene which="dock" />;
    case "drag-sidebar":
      return <DragScene which="sidebar" />;
    case "sheet":
      return <Sheet />;
    default:
      return <GhostGallery />;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <Preview />
    </LazyMotion>
  </StrictMode>
);
