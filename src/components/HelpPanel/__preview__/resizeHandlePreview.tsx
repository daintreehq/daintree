import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HELP_PANEL_DEFAULT_WIDTH } from "@/store/helpPanelStore";
import { cn } from "@/lib/utils";
import { installPreviewShims } from "./previewShims";
import { HelpPanelHeader } from "../HelpPanelHeader";
import { HelpPanelResizeHandle } from "../HelpPanelResizeHandle";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the assistant panel's left-edge resize handle.
 *
 * Renders the real `HelpPanelResizeHandle` and `HelpPanelHeader` inside an aside that
 * carries the panel's own clipping and border classes, beside a stand-in grid area, so
 * rest, hover, focus and drag can be driven with a real mouse and real keys.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?width=500                starting panel width in CSS px (default: the app default)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const startWidth = Number(params.get("width")) || HELP_PANEL_DEFAULT_WIDTH;

function Scene() {
  const [width, setWidth] = useState(startWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const from = width;
      const onMove = (ev: MouseEvent) => setWidth(from + (startX - ev.clientX));
      const onUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width]
  );

  return (
    <TooltipProvider>
      <div
        data-preview-scene
        data-width={width}
        className="flex h-[420px] w-[900px] bg-surface-grid"
      >
        <div className="flex-1 min-w-0 p-3">
          <div className="h-full rounded-md border border-divider bg-surface-canvas" />
        </div>
        <aside
          id="daintree-assistant-panel"
          className={cn(
            "relative shrink-0 flex flex-col h-full overflow-hidden",
            "bg-surface-canvas border-l border-border-default"
          )}
          style={{ width }}
        >
          <HelpPanelResizeHandle
            width={width}
            isResizing={isResizing}
            isVisible
            controlsId="daintree-assistant-panel"
            onMouseDown={handleMouseDown}
            onKeyDown={() => {}}
            onReset={() => setWidth(HELP_PANEL_DEFAULT_WIDTH)}
          />
          <HelpPanelHeader
            agentState={null}
            canRestartConversation
            canEndSession
            onRestartConversation={() => {}}
            onEndSession={() => {}}
            onResumePastSession={() => {}}
            onOpenDocs={() => {}}
            onClose={() => {}}
          />
          <div className="flex-1 bg-surface-canvas" />
        </aside>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Scene />
  </StrictMode>
);
