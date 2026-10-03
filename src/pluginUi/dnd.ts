import { createContext, useContext, useId, type CSSProperties, type SyntheticEvent } from "react";
import { useDraggable as useDndDraggable, useDroppable as useDndDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type {
  PluginDragHandleProps,
  PluginDragId,
  PluginDraggableState,
  PluginDroppableState,
  PluginUseDraggableOptions,
  PluginUseDroppableOptions,
} from "@shared/types/plugin-sdk-react";

// The facade's drag hooks, here rather than behind the kit chunk: a hook
// forwarded through the lazily loaded kit is one the compiler can't see is a
// hook, and it would suspend the view on first render. They need only
// @dnd-kit, which the host already loads at startup, and the scope the kit's
// `DragDropProvider` provides.

export interface KitDragScope {
  /** Put on the item in hand: the faded placeholder under a provider with an overlay. */
  placeholderStyle: CSSProperties | null;
}

/** Set by the kit's `DragDropProvider`. Null anywhere else, where the hooks are inert. */
export const KitDragScopeContext = createContext<KitDragScope | null>(null);

export function isDragId(value: unknown): value is PluginDragId {
  return (
    (typeof value === "string" && value !== "") ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function readOptions(options: unknown): { id: PluginDragId | undefined; disabled: boolean } {
  if (typeof options !== "object" || options === null) return { id: undefined, disabled: true };
  const id: unknown = Reflect.get(options, "id");
  return { id: isDragId(id) ? id : undefined, disabled: Reflect.get(options, "disabled") === true };
}

function listenerOf(
  listeners: Record<string, unknown> | undefined,
  name: string
): ((event: SyntheticEvent) => void) | undefined {
  const handler = listeners?.[name];
  if (typeof handler !== "function") return undefined;
  return (event) => {
    Reflect.apply(handler, undefined, [event]);
  };
}

/**
 * Outside a kit provider the hooks still have to call dnd-kit's (hooks run in
 * a fixed order), and dnd-kit registers with the nearest context, which there
 * is the host's panel grid. A private id, disabled, keeps that registration
 * inert: it can neither be dragged nor collide with a host id.
 */
function useScopedId(scope: KitDragScope | null, id: PluginDragId | undefined): PluginDragId {
  const privateId = `kit-inert-${useId()}`;
  return scope !== null && id !== undefined ? id : privateId;
}

export function useDraggable(options: PluginUseDraggableOptions): PluginDraggableState {
  const scope = useContext(KitDragScopeContext);
  const read = readOptions(options);
  const id = useScopedId(scope, read.id);
  const inert = scope === null || read.id === undefined;
  const disabled = inert || read.disabled;
  const drag = useDndDraggable({ id, disabled });
  const isDragging = !inert && drag.isDragging;
  const handleProps: PluginDragHandleProps = {
    ref: drag.setActivatorNodeRef,
    role: "button",
    tabIndex: disabled ? -1 : 0,
    "aria-roledescription": "draggable",
    "aria-describedby": drag.attributes["aria-describedby"],
    "aria-pressed": isDragging,
    "aria-disabled": disabled,
    onMouseDown: listenerOf(drag.listeners, "onMouseDown"),
    onTouchStart: listenerOf(drag.listeners, "onTouchStart"),
    onKeyDown: listenerOf(drag.listeners, "onKeyDown"),
  };
  let style: CSSProperties | undefined;
  if (isDragging) {
    style = scope?.placeholderStyle ?? {
      transform: CSS.Translate.toString(drag.transform),
      position: "relative",
      zIndex: 1,
    };
  }
  return { ref: drag.setNodeRef, handleProps, isDragging, style };
}

export function useDroppable(options: PluginUseDroppableOptions): PluginDroppableState {
  const scope = useContext(KitDragScopeContext);
  const read = readOptions(options);
  const id = useScopedId(scope, read.id);
  const inert = scope === null || read.id === undefined;
  const drop = useDndDroppable({ id, disabled: inert || read.disabled });
  return {
    ref: drop.setNodeRef,
    isOver: !inert && drop.isOver,
    activeId: inert ? null : (drop.active?.id ?? null),
  };
}
