import { readFileSync } from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Every surface that states a validation error or draws an error / warning box
 * through the shared `InlineError` and `Callout`. A new one belongs here too.
 */
const MIGRATED_FILES = [
  "src/components/Project/CloneRepoDialog.tsx",
  "src/components/Project/MoveOrRenameProjectDialog.tsx",
  "src/components/Project/GitInitDialog.tsx",
  "src/components/Project/CreateProjectFolderDialog.tsx",
  "src/components/Settings/ImageViewerTab.tsx",
  "src/components/Project/AutomationTab.tsx",
  "src/components/Worktree/LifecycleCommandApprovalDialog.tsx",
  "src/components/Project/CodeForgeTab.tsx",
  "src/components/Terminal/UpdateCwdDialog.tsx",
  "src/components/Commands/CommandBuilder.tsx",
  "src/components/Worktree/NewWorktreeDialog.tsx",
  "src/components/Settings/DaintreeAssistantSettingsTab.tsx",
  "src/components/Worktree/WorktreeCard/WorktreeDetailsSection.tsx",
  "src/components/Worktree/ReviewHub/CommitPanel.tsx",
  "src/components/Setup/SystemRequirementsSection.tsx",
  "src/components/Terminal/MissingCliGate.tsx",
  "src/components/Project/ContextTab.tsx",
  "src/components/Recovery/CrashRecoveryDialog.tsx",
  "src/components/ui/TypedNameConfirmInput.tsx",
  "src/components/Plugin/PluginMcpServersSection.tsx",
  "src/components/Plugin/PluginManagerView.tsx",
  "src/components/Plugin/ProjectPluginSection.tsx",
  "src/components/Plugin/PluginLogsSection.tsx",
  "src/components/Plugin/PluginArchiveInstallConfirmDialog.tsx",
  "src/components/Plugin/PluginDetailPane.tsx",
  "src/components/McpConfirmDialog.tsx",
  "src/components/Settings/SettingsLoadErrorBanner.tsx",
  "src/components/Settings/ResourceEnvironmentsSection.tsx",
  "src/components/Settings/WorktreeSettingsTab.tsx",
  "src/components/KeyboardShortcuts/SettingsShortcutCapture.tsx",
  "src/components/Project/GeneralTab.tsx",
  "src/components/Project/WelcomeScreen.tsx",
  "src/components/Pilot/PilotParkEditor.tsx",
  "src/components/Config/ImportConfigDialog.tsx",
  "src/components/Settings/EditorIntegrationTab.tsx",
  "src/components/Settings/ForgeIntegrationsTab.tsx",
  "src/components/Settings/EnvironmentSettingsTab.tsx",
  "src/components/Project/EnvironmentVariablesEditor.tsx",
  "src/components/Plugin/PluginMcpConfirmDialog.tsx",
  "src/components/Project/ProjectSwitcherPalette.tsx",
  "plugins/builtin/sveltekit-builder/renderer/InspectorNotice.tsx",
];

/**
 * Status-coloured strings in migrated files that are not messages, each for a
 * reason the error and callout contract does not reach.
 */
const EXEMPT: Record<string, string[]> = {
  // A requirement tile's one-word verdict ("Missing", "Outdated") beside its mark.
  "src/components/Setup/SystemRequirementsSection.tsx": [
    "flex items-center gap-1.5 ml-auto text-2xs text-status-error",
    "flex items-center gap-1.5 ml-auto text-2xs text-status-warning",
  ],
  // The broken-plugins summary is a button that opens the list, not a callout.
  "src/components/Plugin/PluginManagerView.tsx": [
    "text-2xs text-status-danger min-w-0 flex-1",
    "text-2xs text-status-danger underline underline-offset-2 shrink-0",
  ],
  // A destructive row button ("Delete all"), not a message.
  "src/components/Project/ProjectSwitcherPalette.tsx": [
    "text-xs font-medium text-status-error transition-colors hover:bg-status-error/10",
  ],
  // Raw setup output behind a "Show details" disclosure: a log, not a callout.
  "src/components/Worktree/WorktreeCard/WorktreeDetailsSection.tsx": [
    "mt-1.5 max-h-32 overflow-auto rounded-[var(--radius-md)] bg-status-error/5 p-2 font-mono text-2xs text-text-secondary whitespace-pre-wrap break-all select-text",
  ],
};

const TEXT_SIZE = /^text-(3xs|2xs|xs|sm|base)$/;
const SEVERITY_INK = /^text-status-(error|danger|warning)$/;
/** A tint lighter than the callout's one fill opacity. */
const OFF_RECIPE_FILL = /^bg-status-(error|danger|warning)\/(5|\[0\.0\d+\])$/;

function allStrings(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function classStrings(file: string): string[] {
  const exempt = new Set(EXEMPT[file] ?? []);
  return allStrings(file).filter((value) => !exempt.has(value));
}

describe("errors and callouts contract", () => {
  it.each(MIGRATED_FILES)("%s states no message in severity-coloured words", (file) => {
    // Words sized as text and inked in a status colour: the pattern whose
    // contrast no theme guarantees. The glyph carries the severity instead.
    const offenders = classStrings(file).filter((value) => {
      const tokens = value.split(/\s+/);
      return tokens.some((t) => TEXT_SIZE.test(t)) && tokens.some((t) => SEVERITY_INK.test(t));
    });
    expect(offenders).toEqual([]);
  });

  it.each(MIGRATED_FILES)("%s draws no callout off the shared fill", (file) => {
    const offenders = classStrings(file).filter((value) =>
      value.split(/\s+/).some((t) => OFF_RECIPE_FILL.test(t))
    );
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(EXEMPT))("%s has no stale exemption", (file, exempt) => {
    const present = new Set(allStrings(file));
    expect(exempt.filter((value) => !present.has(value))).toEqual([]);
  });
});
