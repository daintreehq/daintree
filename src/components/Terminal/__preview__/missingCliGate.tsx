import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentCliDetail } from "@shared/types/ipc";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import { MemoryPressureGate } from "@/components/Terminal/MemoryPressureGate";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the pane gates an agent launch can stop
 * at: the missing-CLI gate in each availability state, and the memory-pressure
 * gate beside it for comparison.
 *
 * Each page renders one real gate inside a stand-in pane (header plus body) at a
 * fixed size, so the gate is judged where it actually lives rather than as a
 * free-floating card. The store's re-check always rejects, so pressing it lands
 * on the "re-check failed" state.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<name>             see STATES below
 *   ?w=560&h=640              pane size in CSS px
 *   ?os=darwin|linux|win32    host platform the install steps follow
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const stateName = params.get("state") ?? "missing";
const width = Number(params.get("w") ?? "560");
const height = Number(params.get("h") ?? "640");
const os = params.get("os");
if (os === "darwin" || os === "linux" || os === "win32") setHostPlatformInfo({ platform: os });

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => undefined;

useCliAvailabilityStore.setState({
  refresh: () => Promise.reject(new Error("availability probe timed out")),
});

interface Fixture {
  agentId: string;
  title: string;
  detail?: AgentCliDetail;
}

const FIXTURES: Record<string, Fixture> = {
  missing: {
    agentId: "claude",
    title: "Claude",
    detail: { state: "missing", resolvedPath: null, via: null },
  },
  "missing-last-path": {
    agentId: "codex",
    title: "Codex",
    detail: { state: "missing", resolvedPath: "/Users/you/.local/bin/codex", via: null },
  },
  "installed-wsl": {
    agentId: "codex",
    title: "Codex",
    detail: { state: "installed", resolvedPath: null, via: "wsl", wslDistro: "Ubuntu-24.04" },
  },
  installed: {
    agentId: "codex",
    title: "Codex",
    detail: {
      state: "installed",
      resolvedPath: "/opt/homebrew/bin/codex",
      via: "which",
      message:
        "Found /opt/homebrew/bin/codex, but it is a shell function wrapper and can't be launched directly.",
    },
  },
  blocked: {
    agentId: "gemini",
    title: "Gemini",
    detail: {
      state: "blocked",
      resolvedPath: "/usr/local/bin/gemini",
      via: "which",
      message: "Execution of /usr/local/bin/gemini was denied (EPERM).",
    },
  },
  "blocked-long-path": {
    agentId: "gemini",
    title: "Gemini",
    detail: {
      state: "blocked",
      resolvedPath:
        "/Users/you/.local/share/mise/installs/node/22.23.2/lib/node_modules/@google/gemini-cli/bin/gemini",
      via: "which",
    },
  },
  ready: {
    agentId: "claude",
    title: "Claude",
    detail: { state: "ready", resolvedPath: "/Users/you/.local/bin/claude", via: "which" },
  },
  unauthenticated: {
    agentId: "codex",
    title: "Codex",
    detail: { state: "unauthenticated", resolvedPath: "/opt/homebrew/bin/codex", via: "which" },
  },
  "memory-pressure": { agentId: "claude", title: "Claude" },
};

function PaneHeader({ title }: { title: string }) {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-secondary surface-toolbar"
    >
      <span className="h-3 w-3 rounded-full bg-overlay-medium" />
      <span className="truncate font-medium text-text-primary">{title}</span>
    </div>
  );
}

function Pane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-preview-shell className="p-4" style={{ width: width + 32 }}>
      <div
        data-pane
        className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
        style={{ width, height }}
      >
        <PaneHeader title={title} />
        <div className="flex-1 min-h-0 bg-surface-canvas flex flex-col">{children}</div>
      </div>
    </div>
  );
}

const fixture = FIXTURES[stateName];
if (!fixture) throw new Error(`unknown state "${stateName}"`);

const gate =
  stateName === "memory-pressure" ? (
    <MemoryPressureGate agentId={fixture.agentId} onLaunchAnyway={noop} onCancel={noop} />
  ) : (
    <MissingCliGate
      agentId={fixture.agentId}
      detail={fixture.detail!}
      onRunAnyway={noop}
      onAvailabilityReady={noop}
      onOpenAgentSettings={noop}
    />
  );

// Radix loads lazily; a tooltip that mounts before its provider has the
// primitives throws, so prime them before the first render.
void primeRadix().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <Pane title={fixture.title}>{gate}</Pane>
      </TooltipProvider>
    </StrictMode>
  );
});
