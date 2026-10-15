import "@/lib/trustedTypesPolicy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { ForgeAnomalySignal, ForgeAuditRecord } from "@shared/types/ipc/forge";
import type { McpAnomalySignal, McpAuditRecord } from "@shared/types";
import type { PluginActionAuditRecord } from "@shared/types/ipc/pluginAudit";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { SettingsSection } from "../SettingsSection";
import { ForgeAuditLogViewer } from "../ForgeAuditLogViewer";
import { McpAuditLatencyTable } from "../McpAuditLatencyTable";
import { McpAuditLogViewer } from "../McpAuditLogViewer";
import { PluginActionAuditLogViewer } from "../PluginActionAuditLogViewer";
import "@/index.css";

/**
 * Standalone visual-review harness for the detail rows of the settings audit logs:
 * the forge audit log's records and the MCP latency-by-tool table, plus the MCP
 * dispatch and plugin-action logs, whose rows share the forge rows' grammar.
 *
 * All four are prop-driven, so this mounts the real components with fixture records
 * inside a stand-in for the settings dialog body (same column width, inset and
 * `settings-shell` paint). The fixtures carry what a short sample hides: a long
 * argument summary, a long error, an unbroken repo name, anomaly marks, and
 * namespaced tool ids that differ only in their last segment.
 *
 * Query parameters (driven by `settings-audit-rows-review.spec.ts`):
 *   ?theme=daintree|bondi|…        built-in theme id
 *   ?view=forge|latency|mcp|plugin which surface
 *   ?width=687                     dialog content column width in px, inset included
 */

installPreviewShims({});

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const view = params.get("view") ?? "forge";
const width = Number(params.get("width") ?? "687");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.margin = "0";
document.body.style.background = "var(--color-surface-canvas)";
// index.css pins the document to the viewport; an element shot of a taller frame
// would silently lose everything below the fold.
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";

const now = Date.now();
const MIN = 60_000;

function forge(
  overrides: Partial<ForgeAuditRecord> & Pick<ForgeAuditRecord, "id">
): ForgeAuditRecord {
  return {
    timestamp: now - 2 * MIN,
    providerId: "daintree.github",
    methodName: "getPR",
    result: "success",
    durationMs: 182,
    repoOwner: "daintreehq",
    repoName: "daintree",
    argsSummary: '{"number":13379}',
    schemaVersion: 1,
    severity: "info",
    ...overrides,
  };
}

const FORGE_RECORDS: ForgeAuditRecord[] = [
  forge({ id: "f1", timestamp: now - 40_000 }),
  forge({
    id: "f2",
    timestamp: now - 3 * MIN,
    methodName: "listIssues",
    result: "error",
    severity: "error",
    durationMs: 4812,
    argsSummary: '{"state":"open","labels":2,"perPage":100}',
    errorMessage:
      "API rate limit exceeded for installation 51234987. The limit resets at 18:02; requests made before then return 403.",
  }),
  forge({
    id: "f3",
    timestamp: now - 7 * MIN,
    providerId: "daintree.gitlab",
    methodName: "listIssueComments",
    result: "not-found",
    severity: "notice",
    durationMs: 96,
    repoOwner: "acme-industries",
    repoName: "billing-platform-reconciliation-service-with-a-very-long-name",
    argsSummary: '{"number":8812,"perPage":100,"paged":true}',
  }),
  forge({
    id: "f4",
    timestamp: now - 12 * MIN,
    providerId: "acme.bitbucket-cloud",
    methodName: "searchLinkedIssuesAcrossWorkspaces",
    result: "error",
    severity: "error",
    durationMs: 12406,
    repoOwner: "acme",
    repoName: "billing",
    argsSummary:
      '{"workspace":"acme-industries","projects":["BILL","LEDGER","PAYOUTS","RECON"],"query":"status in (Open, \\"In Review\\") AND labels = needs-triage","fields":["key","summary","status","assignee","updated"],"expand":"changelog","perPage":100,"cursor":"<string: 88 chars>","includeArchived":false}',
    errorMessage: "Request timed out after 12s waiting for bitbucket.org.",
  }),
  forge({
    id: "f5",
    timestamp: now - 26 * MIN,
    methodName: "mergePR",
    durationMs: 1204,
    argsSummary: '{"number":13312}',
  }),
  forge({
    id: "f6",
    timestamp: now - 41 * MIN,
    methodName: "getCIStatus",
    durationMs: 64,
    argsSummary: '{"number":13379}',
  }),
  forge({
    id: "f7",
    timestamp: now - 58 * MIN,
    methodName: "validateToken",
    durationMs: 312,
    repoOwner: undefined,
    repoName: undefined,
    argsSummary: "",
  }),
  forge({
    id: "f8",
    timestamp: now - 2 * 60 * MIN,
    methodName: "listPRs",
    durationMs: 22,
    argsSummary: '{"state":"open","perPage":50}',
  }),
];

const FORGE_SIGNALS: ForgeAnomalySignal[] = [
  {
    id: "s1",
    kind: "p95-z-score",
    providerId: "daintree.github",
    methodName: "listIssues",
    severity: "danger",
    timestamp: now - 3 * MIN,
    recordIds: ["f2"],
    zScore: 4.1,
  },
  {
    id: "s2",
    kind: "failure-cluster",
    providerId: "acme.bitbucket-cloud",
    methodName: "searchLinkedIssuesAcrossWorkspaces",
    severity: "danger",
    timestamp: now - 12 * MIN,
    recordIds: ["f4"],
    clusterSize: 3,
  },
  {
    id: "s3",
    kind: "first-seen-method",
    providerId: "daintree.github",
    methodName: "mergePR",
    severity: "danger",
    timestamp: now - 26 * MIN,
    recordIds: ["f5"],
  },
];

let seq = 0;
function mcp(toolId: string, durationMs: number, extra: Partial<McpAuditRecord> = {}) {
  seq += 1;
  const record: McpAuditRecord = {
    id: `m${seq}`,
    timestamp: now - seq * 20_000,
    toolId,
    sessionId: "mcp-transport-1",
    tier: "core",
    argsSummary: "{}",
    result: "success",
    durationMs,
    schemaVersion: 1,
    severity: "info",
    ...extra,
  };
  return record;
}

const MCP_RECORDS: McpAuditRecord[] = [
  mcp("daintree.terminal.sendCommand", 48, {
    argsSummary: '{"terminalId":"t-3","command":"npm test -- src/components/Settings"}',
  }),
  mcp("daintree.terminal.sendCommandMany", 214, {
    argsSummary:
      '{"terminalIds":"<object>","command":"git fetch origin develop && git rebase origin/develop","waitForIdle":true,"timeoutMs":120000,"label":"rebase every worktree onto develop before the release cut","stopOnFirstFailure":false,"echo":true}',
  }),
  mcp("daintree.terminal.sendCommand", 3150, {
    result: "error",
    severity: "error",
    errorCode: "TERMINAL_NOT_FOUND",
    argsSummary: '{"terminalId":"t-9","command":"npm run check"}',
  }),
  mcp("daintree.terminal.sendCommandMany", 388),
  mcp("plugin.acme-observability.queryDistributedTracesForWorktree", 7420, {
    argsSummary: '{"worktreeId":"wt-2","since":"15m","service":"billing-api"}',
  }),
  mcp("plugin.acme-observability.queryDistributedTracesForWorktree", 5120),
  mcp("worktree.createFromBranchAndLaunchConfiguredAgents", 1840, {
    argsSummary: '{"branch":"feature/a-long-branch-name","agents":"<object>","recipe":"review"}',
  }),
  mcp("git.getDiff", 6120, { argsSummary: '{"worktreeId":"wt-2","staged":false}' }),
  mcp("git.getDiff", 410),
  mcp("project.getCurrent", 6, { result: "dedup", argsSummary: "" }),
  mcp("project.getCurrent", 9, { argsSummary: "" }),
  mcp("daintree.terminal.sendCommand", 92),
];

const MCP_SIGNALS: McpAnomalySignal[] = [
  {
    id: "ms1",
    kind: "p95-z-score",
    toolId: "plugin.acme-observability.queryDistributedTracesForWorktree",
    severity: "warning",
    timestamp: now - 100_000,
    recordIds: ["m5"],
  },
  {
    id: "ms2",
    kind: "first-seen-combination",
    toolId: "daintree.terminal.sendCommandMany",
    severity: "info",
    timestamp: now - 40_000,
    recordIds: ["m2"],
  },
];

const PLUGIN_RECORDS: PluginActionAuditRecord[] = [
  {
    id: "p1",
    ts: now - 30_000,
    pluginId: "acme.deploy-tools",
    actionId: "acme.deploy-tools.promoteReleaseCandidateToProduction",
    source: "agent",
    argsHash: "9f2c4e1a7b3d5f6081a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
    argsPlaintext:
      '{"environment":"production","service":"billing-api","releaseCandidate":"rc-2026.10.15-3","strategy":"canary","canaryPercent":10,"bakeMinutes":30,"notifyChannel":"#deploys","dryRun":false,"skipChecks":"<object>"}',
    durationMs: 2380,
    result: "error",
    errorMessage: "Deploy gate refused the promotion: 2 required checks are still pending.",
    schemaVersion: 1,
  },
  {
    id: "p2",
    ts: now - 6 * MIN,
    pluginId: "acme.deploy-tools",
    actionId: "acme.deploy-tools.listEnvironments",
    source: "user",
    argsHash: "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a",
    durationMs: 41,
    result: "success",
    schemaVersion: 1,
  },
];

await primeRadix();

const noop = () => {};

function ForgeView() {
  return (
    <SettingsSection
      title="Forge audit log"
      description="Each call Daintree makes to a forge provider, with arguments redacted, for tracing slow or failing providers. Keeps the last 1,000 calls on this machine."
    >
      <ForgeAuditLogViewer
        records={FORGE_RECORDS}
        loading={false}
        maxRecords={1000}
        anomalySignals={FORGE_SIGNALS}
        anomalySuppressed={false}
        onRefresh={noop}
        onExport={noop}
        onClear={noop}
      />
    </SettingsSection>
  );
}

function LatencyView() {
  return (
    <SettingsSection title="Advanced diagnostics">
      <McpAuditLatencyTable records={MCP_RECORDS} />
    </SettingsSection>
  );
}

function McpView() {
  return (
    <SettingsSection title="Advanced diagnostics">
      <McpAuditLogViewer
        records={MCP_RECORDS}
        loading={false}
        onRefresh={noop}
        anomalySignals={MCP_SIGNALS}
        anomalySuppressed={false}
      />
    </SettingsSection>
  );
}

function PluginView() {
  return (
    <SettingsSection title="Plugin action audit">
      <PluginActionAuditLogViewer
        records={PLUGIN_RECORDS}
        loading={false}
        maxRecords={500}
        onRefresh={noop}
        onExport={noop}
        onClear={noop}
      />
    </SettingsSection>
  );
}

function Harness() {
  return (
    <div className="p-6">
      <div
        data-preview-frame=""
        className="settings-shell rounded-[var(--radius-xl)] border border-border-default py-6 px-6"
        style={{ width: `${width}px` }}
      >
        {view === "latency" ? (
          <LatencyView />
        ) : view === "mcp" ? (
          <McpView />
        ) : view === "plugin" ? (
          <PluginView />
        ) : (
          <ForgeView />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
