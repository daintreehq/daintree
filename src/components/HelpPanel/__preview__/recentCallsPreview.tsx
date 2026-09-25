import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { McpAuditRecord } from "@shared/types";
import { installPreviewShims } from "./previewShims";
import { McpActivityStrip } from "../McpActivityStrip";
import "@/index.css";

/**
 * Standalone visual-review harness for the footer's recent-tool-calls popover.
 *
 * The popover's interesting states — an error beside a success in one turn, a rate
 * limit, a gate outcome with no output, a call outside any turn — need a live assistant
 * session and a particular run of luck to line up. This renders the real
 * `McpActivityStrip` (so the real `PopoverContent` width, offset and collision logic)
 * and answers its one bridge read, `mcpServer.getAuditRecords`, from fixtures that name
 * each state.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=populated        which record set to serve (see FIXTURES)
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

const SESSION = "preview-session";
const now = Date.now();

function record(overrides: Partial<McpAuditRecord> & Pick<McpAuditRecord, "id">): McpAuditRecord {
  return {
    timestamp: now - 12_000,
    toolId: "worktree.list",
    sessionId: "mcp-transport-1",
    helpSessionId: SESSION,
    tier: "workbench",
    argsSummary: "{}",
    result: "success",
    durationMs: 14,
    schemaVersion: 1,
    severity: "info",
    ...overrides,
  };
}

const POPULATED: McpAuditRecord[] = [
  record({
    id: "r1",
    turnId: "turn-2",
    timestamp: now - 12_000,
    toolId: "terminal.sendCommand",
    argsSummary:
      '{\n  "terminalId": "t-3",\n  "command": "npm test -- src/components/HelpPanel"\n}',
    result: "error",
    errorCode: "TERMINAL_NOT_FOUND",
    resultSummary: "TERMINAL_NOT_FOUND: No terminal with id t-3 in this project",
    severity: "error",
  }),
  record({
    id: "r2",
    turnId: "turn-2",
    timestamp: now - 41_000,
    toolId: "worktree.list",
    resultSummary:
      '[\n  {\n    "id": "wt-1",\n    "branch": "develop",\n    "path": "/Users/dev/daintree"\n  },\n  {\n    "id": "wt-2",\n    "branch": "design/help-recent-calls",\n    "path": "/Users/dev/daintree-worktrees/design-help-recent-calls"\n  }\n]',
  }),
  record({
    id: "r3",
    turnId: "turn-1",
    timestamp: now - 190_000,
    toolId: "git.push",
    argsSummary: '{\n  "worktreeId": "wt-2"\n}',
    result: "unauthorized",
    severity: "warning",
    tierHint: "action",
  }),
  record({
    id: "r4",
    turnId: "turn-1",
    timestamp: now - 200_000,
    toolId: "github.listIssues",
    argsSummary: '{\n  "state": "open"\n}',
    result: "rate_limited",
    resultMeta: { retryAfter: 30 },
    severity: "warning",
  }),
  record({
    id: "r5",
    timestamp: now - 3_700_000,
    toolId: "project.getCurrent",
    result: "dedup",
  }),
];

const LONG: McpAuditRecord[] = [
  record({
    id: "l1",
    turnId: "turn-9",
    timestamp: now - 8_000,
    toolId: "worktree.createFromBranchAndLaunchConfiguredAgents",
    argsSummary: JSON.stringify(
      {
        branch: "feature/a-very-long-branch-name-that-keeps-going-for-a-while",
        agents: ["claude", "codex", "gemini"],
        recipe: "full-stack-review",
        env: { NODE_ENV: "development", DAINTREE_TRACE: "1" },
      },
      null,
      2
    ),
    resultSummary: JSON.stringify(
      {
        worktreeId: "wt-19",
        path: "/Users/dev/daintree-worktrees/feature-a-very-long-branch-name-that-keeps-going-for-a-while",
        terminals: Array.from({ length: 8 }, (_, i) => ({ id: `t-${i + 20}`, agent: "claude" })),
      },
      null,
      2
    ),
  }),
  record({
    id: "l2",
    turnId: "turn-9",
    timestamp: now - 9_000,
    toolId: "confirm.awaitUserDecision",
    result: "confirmation-pending",
    severity: "warning",
  }),
  record({
    id: "l3",
    turnId: "turn-9",
    timestamp: now - 9_500,
    toolId: "worktree.list",
    result: "collision",
    severity: "warning",
  }),
];

type Fixture = "populated" | "long" | "empty" | "loading" | "error";
const FIXTURES: Record<Fixture, () => Promise<McpAuditRecord[]>> = {
  populated: () => Promise.resolve(POPULATED),
  long: () => Promise.resolve(LONG),
  empty: () => Promise.resolve([]),
  loading: () => new Promise<McpAuditRecord[]>(() => {}),
  error: () => Promise.reject(new Error("bridge unavailable")),
};

function isFixture(value: string): value is Fixture {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const fixture: Fixture = isFixture(fixtureParam) ? fixtureParam : "populated";
const width = Number(params.get("width")) || 380;

installPreviewShims({
  mcpServer: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "getAuditRecords"
          ? FIXTURES[fixture]
          : () =>
              Object.assign(() => undefined, { then: (r: (v: unknown) => void) => r(undefined) }),
    }
  ),
});

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div
        data-preview-panel
        className="flex flex-col bg-surface-panel border border-border-default"
        style={{ width: `${width}px`, height: "560px" }}
      >
        {/* Stand-in for the transcript the popover opens over. */}
        <div className="flex-1 min-h-0 px-3 py-3 space-y-2" aria-hidden="true">
          <div className="h-2 w-4/5 rounded-full bg-overlay-soft" />
          <div className="h-2 w-3/5 rounded-full bg-overlay-soft" />
          <div className="h-2 w-2/3 rounded-full bg-overlay-soft" />
        </div>
        <div
          data-preview-footer
          className="flex items-center h-8 px-2 border-t border-border-default"
        >
          <McpActivityStrip sessionId={SESSION} activity={null} />
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
