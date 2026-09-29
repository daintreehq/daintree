import type { ReactNode } from "react";
import { RadioTower } from "lucide-react";
import { cn } from "../kit/cn.js";
import {
  resolveMockAgent,
  useMockKit,
  type MockAgent,
  type MockAgentId,
  type MockStateId,
} from "./MockKitContext.js";
import { MockAgentIcon, MockStateGlyph } from "./MockGlyphs.js";

export interface MockPaneProps {
  /** A known id, or a full descriptor for an agent the kit hasn't been given. */
  agent: MockAgentId | MockAgent;
  /** Prefix for this pane's anchors (`<anchor>-titlebar`, `-glyph`, `-armed`, `-body`, `-input`). Defaults to the agent. */
  anchor?: string;
  state?: MockStateId | null;
  armed?: boolean;
  focused?: boolean;
  /** Text shown in the input bar; the placeholder is used when empty. */
  input?: ReactNode;
  inputAddon?: ReactNode;
  /** Something is being dragged over the prompt bar: the real bar's drop highlight. */
  dragOver?: boolean;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function MockPane({
  agent,
  anchor,
  state = null,
  armed = false,
  focused = false,
  input,
  inputAddon,
  dragOver = false,
  children,
  className,
  title,
}: MockPaneProps) {
  const resolved = resolveMockAgent(useMockKit(), agent);
  const name = resolved.name;
  const anchorPrefix = anchor ?? resolved.id;
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-surface-panel",
        "transition-[border-color,box-shadow] duration-150 ease-out",
        focused
          ? "border-border-interactive shadow-[var(--theme-shadow-ambient)]"
          : "border-border-default",
        className
      )}
    >
      <div
        data-tour-anchor={`${anchorPrefix}-titlebar`}
        className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-panel-elevated px-2"
      >
        <MockAgentIcon agent={resolved} className="size-3" />
        <span className="truncate text-2xs font-medium text-text-primary">{title ?? name}</span>
        <span className="flex-1" />
        <span
          data-tour-anchor={`${anchorPrefix}-armed`}
          className={cn(
            "inline-flex text-category-amber-text transition-opacity duration-150 ease-out",
            armed ? "opacity-100" : "opacity-0"
          )}
        >
          <RadioTower className="size-3" aria-hidden="true" />
        </span>
        <span data-tour-anchor={`${anchorPrefix}-glyph`} className="inline-flex">
          <MockStateGlyph state={state} />
        </span>
      </div>
      <div
        data-tour-anchor={`${anchorPrefix}-body`}
        className="min-h-0 flex-1 overflow-hidden px-2.5 py-2"
      >
        {children}
      </div>
      <div className="shrink-0 px-1.5 pb-1.5">
        <div
          data-tour-anchor={`${anchorPrefix}-input`}
          className={cn(
            "flex h-5 items-center gap-2 rounded-md border bg-surface-input px-2 transition-[border-color] duration-150 ease-out",
            dragOver ? "border-border-strong bg-overlay-subtle" : "border-border-subtle"
          )}
        >
          {input ? (
            <span className="truncate text-2xs text-text-primary">{input}</span>
          ) : (
            <span className="truncate text-2xs text-text-secondary">Ask {name}</span>
          )}
          <span className="flex-1" />
          {inputAddon}
        </div>
      </div>
    </div>
  );
}
