import "./hybridInputShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { Project } from "@shared/types/project";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore } from "@/store";
import { AutocompleteMenu } from "../AutocompleteMenu";
import { HybridInputBar } from "../HybridInputBar";
import { TRIGGER_COPY, requireMenuCase } from "./autocompleteMenuFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the composer's autocomplete menu.
 *
 * In the app the menu only exists while a `/`, `@` or `$` token is under the
 * caret, its rows come from three async providers, and its loading and stale
 * states last a debounce window — none of it holds still long enough to judge.
 * So this mounts the real `AutocompleteMenu` with fixture rows (its props are
 * its data seam), above the real `HybridInputBar` holding the matching draft,
 * over a strip of terminal output, under the real theme tokens and `index.css`.
 *
 * The menu is anchored to the composer's outer box rather than its inner shell,
 * so it sits a few pixels higher than in the app. Everything inside the menu is
 * the product's own rendering.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?case=commands-run|…      which state to render (see autocompleteMenuFixtures)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const caseName = params.get("case") ?? "commands-run";
const menuCase = requireMenuCase(caseName);
const copy = TRIGGER_COPY[menuCase.trigger];

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

const PROJECT_ID = "preview-project";
const CWD = "/Users/dev/Projects/daintree";
const TERMINAL_ID = "autocomplete-preview";

const PROJECT: Project = {
  id: PROJECT_ID,
  path: CWD,
  name: "daintree",
  emoji: "🌳",
  lastOpened: 0,
};

useProjectStore.setState({ currentProject: PROJECT });
usePanelStore.setState({ focusedId: TERMINAL_ID });
useTerminalInputStore.setState((s) => {
  const draftInputs = new Map(s.draftInputs);
  draftInputs.set(`${PROJECT_ID}:${TERMINAL_ID}`, menuCase.draft ?? copy.draft);
  return { draftInputs };
});

const staleKeys = menuCase.stale ? new Set(menuCase.items.map((i) => i.key)) : undefined;

function Ready({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({ worktrees: new Map() });
    return true;
  });
  return ready ? children : null;
}

const noop = () => {};

const TERMINAL_LINES = [
  "⏺ I'll start by reading the autocomplete menu and its consumer.",
  "⏺ Read(src/components/Terminal/AutocompleteMenu.tsx)",
  "  ⎿  Read 243 lines",
  "⏺ Read(src/components/Terminal/HybridInputBar.tsx)",
  "  ⎿  Read 1480 lines",
  "⏺ The menu is rendered once per composer and anchored to the caret column.",
  "",
];

function Pane() {
  const [selectedIndex, setSelectedIndex] = useState(menuCase.selectedIndex);
  return (
    <div
      className="flex flex-col border border-divider bg-surface-panel"
      style={{ width: "640px", height: "560px" }}
      data-preview-case={caseName}
    >
      <pre className="m-0 min-h-0 flex-1 overflow-hidden px-3 pt-3 font-mono text-xs leading-5 text-text-secondary">
        {TERMINAL_LINES.join("\n")}
      </pre>
      <div className="relative">
        <AutocompleteMenu
          isOpen
          items={menuCase.items}
          selectedIndex={selectedIndex}
          isLoading={menuCase.isLoading}
          staleKeys={staleKeys}
          onSelect={noop}
          onHoverIndex={setSelectedIndex}
          style={{ left: "12px" }}
          title={copy.title}
          ariaLabel={copy.ariaLabel}
          emptyMessage={copy.emptyMessage}
        />
        <HybridInputBar terminalId={TERMINAL_ID} onSend={noop} cwd={CWD} agentId="claude" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={0}>
      <WorktreeStoreProvider>
        <Ready>
          <div className="p-6" data-preview-shell>
            <Pane />
          </div>
        </Ready>
      </WorktreeStoreProvider>
    </TooltipProvider>
  </StrictMode>
);
