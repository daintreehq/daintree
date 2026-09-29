import "@/components/DevPreview/__preview__/twinsShims";
import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import { PROBLEMS } from "@/components/Diagnostics/__preview__/diagnosticsFixtures";
import { HELP_PANEL_DEFAULT_WIDTH } from "@/store/helpPanelStore";
import { HelpPanelResizeHandle } from "@/components/HelpPanel/HelpPanelResizeHandle";
import { useDockPopoverResize } from "@/components/Layout/useDockPopoverResize";
import { DockPopoverResizeHandle } from "@/components/Layout/DockPopoverResizeHandle";
import { TwoPaneSplitDivider, DIVIDER_WIDTH_PX } from "@/components/Terminal/TwoPaneSplitDivider";
import { DevPreviewToolDrawerChrome } from "@/components/DevPreview/DevPreviewToolDrawerChrome";
import { cn } from "@/lib/utils";
import "@/index.css";

/**
 * Visual-review harness for the app's resize handles. Each scene renders the real
 * handle (or the real component that owns it) in a frame shaped like its home, so
 * rest, hover, focus and drag can be driven with a real mouse and real keys.
 *
 *   ?scene=assistant|dock-popover|two-pane|dev-drawer|diagnostics
 *   ?theme=daintree|bondi|…
 */

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? "assistant";
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-grid)";
document.body.style.margin = "0";

useErrorStore.setState({ errors: PROBLEMS });
useDiagnosticsStore.setState({ isOpen: true, activeTab: "problems", height: 180, maxHeight: 360 });

await primeRadix();
const { DiagnosticsDock } = await import("@/components/Diagnostics/DiagnosticsDock");

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-preview-scene={scene}
      // The dock caps itself at half its container, so it needs room to grow.
      className={cn(
        "relative m-6 w-[420px] overflow-hidden",
        scene === "diagnostics" ? "h-[420px]" : "h-[240px]"
      )}
    >
      {children}
    </div>
  );
}

function Assistant() {
  const [width, setWidth] = useState(HELP_PANEL_DEFAULT_WIDTH - 180);
  const [isResizing, setIsResizing] = useState(false);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
    <div className="flex h-full bg-surface-grid">
      <div className="min-w-0 flex-1 p-2">
        <div className="h-full rounded-md border border-divider bg-surface-canvas" />
      </div>
      <aside
        id="assistant-panel"
        className="relative flex h-full shrink-0 flex-col border-l border-border-default bg-surface-canvas"
        style={{ width }}
      >
        <HelpPanelResizeHandle
          width={width}
          isResizing={isResizing}
          isVisible
          controlsId="assistant-panel"
          onMouseDown={onMouseDown}
          onKeyDown={() => {}}
          onReset={() => setWidth(HELP_PANEL_DEFAULT_WIDTH)}
        />
      </aside>
    </div>
  );
}

function DockPopover() {
  const { height, isResizing, handleProps } = useDockPopoverResize();
  return (
    <div className="flex h-full flex-col justify-end bg-surface-grid p-2">
      <div
        className="relative w-full overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated"
        style={{ height: Math.min(height, 200) * 0.9 }}
      >
        <DockPopoverResizeHandle handleProps={handleProps} isResizing={isResizing} />
        <div className="mt-3 px-3 text-xs text-text-secondary">Docked terminal</div>
      </div>
    </div>
  );
}

function TwoPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0.5);
  return (
    <div
      ref={containerRef}
      className="grid h-full bg-surface-grid"
      style={{
        gridTemplateColumns: `minmax(0, ${ratio}fr) ${DIVIDER_WIDTH_PX}px minmax(0, ${1 - ratio}fr)`,
      }}
    >
      <div className="rounded-md border border-divider bg-surface-canvas" />
      <TwoPaneSplitDivider
        containerRef={containerRef}
        ratio={ratio}
        onRatioChange={setRatio}
        onRatioCommit={(r) => r !== undefined && setRatio(r)}
        onDoubleClick={() => setRatio(0.5)}
      />
      <div className="rounded-md border border-divider bg-surface-canvas" />
    </div>
  );
}

function DevDrawer() {
  return (
    <div className="relative flex h-full w-full bg-surface-canvas">
      <div className="min-w-0 flex-1 bg-surface-canvas p-3 text-xs text-text-secondary">Page</div>
      <DevPreviewToolDrawerChrome>
        <div className="p-3 text-xs text-text-secondary">Tool</div>
      </DevPreviewToolDrawerChrome>
    </div>
  );
}

function Diagnostics() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 bg-surface-canvas" />
      <DiagnosticsDock onRetry={() => undefined} onCancelRetry={() => undefined} />
    </div>
  );
}

const SCENES: Record<string, () => React.ReactElement> = {
  assistant: Assistant,
  "dock-popover": DockPopover,
  "two-pane": TwoPane,
  "dev-drawer": DevDrawer,
  diagnostics: Diagnostics,
};
const Scene = SCENES[scene] ?? Assistant;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Frame>
        <Scene />
      </Frame>
    </TooltipProvider>
  </StrictMode>
);
