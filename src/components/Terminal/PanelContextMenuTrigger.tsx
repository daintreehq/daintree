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

function TriggerRegion({
  triggerProps,
  children,
}: {
  triggerProps: PanelContextMenuTriggerProps;
  children: React.ReactNode;
}) {
  return (
    <ContextMenuTrigger asChild>
      <div className="contents" {...triggerProps}>
        {children}
      </div>
    </ContextMenuTrigger>
  );
}

/**
 * The trigger of one panel's menu: its children, or under `scope="header"` the
 * `PanelContextMenuTrigger` somewhere inside them. A proxy's marker stays off
 * `data-context-trigger`, so the keyboard route never lands on a row standing
 * in for the panel.
 */
export function PanelContextMenuTriggerScope({
  terminalId,
  proxy,
  scope,
  onContextMenu,
  onPointerDown,
  children,
}: {
  terminalId: string;
  proxy: boolean;
  scope: "surface" | "header";
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  children: React.ReactNode;
}) {
  const triggerProps: PanelContextMenuTriggerProps = proxy
    ? { "data-context-proxy": terminalId, onContextMenu, onPointerDown }
    : { "data-context-trigger": terminalId, onContextMenu, onPointerDown };
  if (scope === "header") {
    return (
      <PanelContextMenuTriggerContext.Provider value={triggerProps}>
        {children}
      </PanelContextMenuTriggerContext.Provider>
    );
  }
  return <TriggerRegion triggerProps={triggerProps}>{children}</TriggerRegion>;
}

/** The part of a panel that opens its menu when the menu is scoped to the header. */
export function PanelContextMenuTrigger({ children }: { children: React.ReactNode }) {
  const triggerProps = useContext(PanelContextMenuTriggerContext);
  if (!triggerProps) return <>{children}</>;
  return <TriggerRegion triggerProps={triggerProps}>{children}</TriggerRegion>;
}
