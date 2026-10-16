import { createContext, useContext } from "react";
import type React from "react";
import { ContextMenuTrigger } from "@/components/ui/context-menu";

export interface PanelContextMenuTriggerProps {
  "data-context-trigger"?: string;
  "data-context-proxy"?: string;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

/**
 * Set by a panel's `TerminalContextMenu` when only part of the panel opens it
 * (`triggerScope="header"`), so the title bar can claim the right-click while
 * the body keeps its own menus. Absent, the trigger renders nothing extra.
 */
export const PanelContextMenuTriggerContext = createContext<PanelContextMenuTriggerProps | null>(
  null
);

/** The part of a panel that opens its menu when the menu is scoped to the header. */
export function PanelContextMenuTrigger({ children }: { children: React.ReactNode }) {
  const triggerProps = useContext(PanelContextMenuTriggerContext);
  if (!triggerProps) return <>{children}</>;
  return (
    <ContextMenuTrigger asChild>
      <div className="contents" {...triggerProps}>
        {children}
      </div>
    </ContextMenuTrigger>
  );
}
