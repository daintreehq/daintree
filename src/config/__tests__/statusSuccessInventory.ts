/**
 * Every `status-success` paint site left in the renderer — `src/` and the
 * builtin plugin renderers — with the reason it is allowed to be green (#12002).
 *
 * Green may only say a confirmation is clearing, a required item is checked, a
 * named operation produced this result, or the colour is notation the app
 * inherited rather than a health claim it is making. "Nothing is wrong" earns
 * nothing. Live process state is green too, but on `activity-working` /
 * `state-working`, which keeps it out of this inventory entirely.
 *
 * The unit here is a source **site** — one string literal or template quasi —
 * not a file and not a line. A file allowlist would be too coarse: `FileStageRow`
 * holds both git notation that stays and a row wash that had to go, so allowing
 * the file would leave the door open forever.
 *
 * Adding a `status-success` utility anywhere in `src/` fails
 * `statusSuccessGuard.contract.test.ts` until it is listed here with a category
 * and a rationale that names the specific confirmation, item, result, or
 * notation. Removing one fails it too, until the entry goes.
 *
 * Policy: docs/themes/status-success-policy.md
 */

export const STATUS_SUCCESS_CATEGORIES = [
  /** Clears on a timer, leaves with the operation or dialog, resets on input change. */
  "transient",
  /** One mark per item in a finite list the current task requires to become true. */
  "verification",
  /** The recorded result of a named execution or check, not inferred health. */
  "outcome",
  /** Notation the app inherited rather than invented: git status letters, diff counts, ahead arrows. */
  "domain",
  /**
   * The affirmative half of a control pair — run, apply, stage, resume, save.
   * Green here means "go", not "good": it is not reporting state at all.
   *
   * NOT one of the four categories the #12002 ruling named, and deliberately
   * separate rather than folded into `domain`, which would have quietly
   * restated what the ruling meant by it. These controls were never in the
   * ruling's demote list, so this PR left them alone and named the gap instead
   * of laundering it. If the maintainer wants them neutral, deleting this
   * category is the change — and the guard will then list every site to fix.
   */
  "affordance",
] as const;

export type StatusSuccessCategory = (typeof STATUS_SUCCESS_CATEGORIES)[number];

export interface ApprovedStatusSuccessSite {
  category: StatusSuccessCategory;
  /**
   * The `status-success`-bearing lexemes of the decoded literal, in source
   * order, whitespace collapsed. Layout classes, indentation and quote style
   * are deliberately not part of the key — reformatting a component must not
   * churn this file, but changing which success utility it paints must.
   */
  signature: string;
  /**
   * Only needed when a signature repeats inside one file. Any substring of an
   * enclosing node that tells the twins apart — a predicate, a label, an
   * `aria-label`. Never an ordinal or a line number.
   *
   * Pick the shortest thing that separates them. A whole JSX element makes a
   * precise anchor and a brittle one: #12099 rewrote the conditional around
   * `UpstreamSyncBadge`'s ahead arrow without touching its colour, and an
   * element-shaped anchor failed on a change the guard had no business
   * noticing. `↑{aheadCount}` survives that and still names the site.
   */
  anchor?: string;
  /** How many `status-success` utilities this one site paints. */
  expectedOccurrences: number;
  /** Names the confirmation, item, result, or notation. "It looks fine" is not a rationale. */
  rationale: string;
}

export type StatusSuccessInventory = Readonly<Record<string, readonly ApprovedStatusSuccessSite[]>>;

export const STATUS_SUCCESS_INVENTORY = {
  "plugins/builtin/github/renderer/components/BulkCreateWorktreeDialog.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: "w-5 h-5 text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the bulk create the user just ran; leaves with the dialog",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: "w-4 h-4 text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded per-item result of the bulk create the user just ran",
    },
  ],
  "plugins/builtin/github/renderer/components/CommitListItem.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'copied && "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Copy-hash confirmation on the row; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: "<span>#</span>",
      expectedOccurrences: 1,
      rationale: "Copy-hash confirmation glyph; resets when the copy flash times out",
    },
  ],
  "plugins/builtin/github/renderer/components/GitHubListItem.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'label: "Approved"',
      expectedOccurrences: 1,
      rationale: "Recorded decision of a named review on the pull request",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'copied && "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Copy confirmation on the row; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: "me-0.5",
      expectedOccurrences: 1,
      rationale: "Copy confirmation glyph; resets when the copy flash times out",
    },
  ],
  "plugins/builtin/github/renderer/components/GitHubSettingsTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'validationResult === "success"',
      expectedOccurrences: 1,
      rationale: "Token-saved confirmation; resets on the next edit of the token field",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'validationResult === "test-success"',
      expectedOccurrences: 1,
      rationale: "Token-valid confirmation; resets on the next edit of the token field",
    },
  ],
  "plugins/builtin/github/renderer/utils/prCIStatus.ts": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the last CI run on the pull request",
    },
  ],
  "src/components/AllClearOverlay/AllClearOverlay.tsx": [
    {
      category: "transient",
      signature: "bg-status-success",
      expectedOccurrences: 1,
      rationale: "Full-screen all-clear flash; the portal unmounts itself on animationend",
    },
  ],
  "src/components/Browser/BrowserToolbar.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'aria-label="Copy URL"',
      expectedOccurrences: 1,
      rationale: "Copy-URL confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'aria-label="Copy screenshot to clipboard"',
      expectedOccurrences: 1,
      rationale: "Copy-screenshot confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Commands/CommandBuilder.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Command-executed screen; leaves with the dialog",
    },
  ],
  "src/components/DevPreview/ConsolePanel.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'aria-label="Copy console message"',
      expectedOccurrences: 1,
      rationale: "Copy-message confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'aria-label="Copy visible console messages"',
      expectedOccurrences: 1,
      rationale: "Copy-all-messages confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Diagnostics/ProblemsContent.tsx": [
    {
      category: "affordance",
      signature:
        "text-status-success hover:text-status-success/70 border-status-success/50 hover:bg-status-success/10",
      expectedOccurrences: 4,
      rationale: "Go-colour on the Retry control, not a claim that the problem is resolved",
    },
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-details confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Diagnostics/TelemetryContent.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-payload confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/EventInspector/EventDetail.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-payload confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/FileViewer/DiffFileSidebar.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Diff insertion count for the whole change set",
    },
    {
      category: "verification",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Per-file viewed mark; one mark per item in the review checklist",
    },
    {
      category: "verification",
      signature: "border-status-success/60 bg-status-success/20 text-status-success",
      expectedOccurrences: 3,
      rationale: "Per-file viewed toggle; one mark per item in the review checklist",
    },
  ],
  "src/components/FileViewer/FileViewerToolbar.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-path confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/FileViewer/diffChangeSet.ts": [
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'label: "A"',
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'label: "?"',
      expectedOccurrences: 1,
      rationale: "Git status letter ?, the notation git itself paints green",
    },
  ],
  "src/components/Layout/DockedTabGroup.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Finished cue on a docked group; the cue decays rather than standing",
    },
  ],
  "src/components/Layout/DockedTerminalItem.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Finished cue on a docked terminal; the cue decays rather than standing",
    },
  ],
  "src/components/Layout/LocalCommitsDropdown.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'copied && "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Copy-hash confirmation on the row; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: "<span>#</span>",
      expectedOccurrences: 1,
      rationale: "Copy-hash confirmation glyph; resets when the copy flash times out",
    },
  ],
  "src/components/Notifications/NotificationCenterEntry.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result carried by a success notification already in the inbox",
    },
  ],
  "src/components/Onboarding/CelebrationConfetti.tsx": [
    {
      category: "transient",
      signature: "bg-status-success/15",
      expectedOccurrences: 1,
      rationale: "Reduced-motion checklist-complete flash; the animation ends and unmounts",
    },
  ],
  "src/components/Project/CloneRepoDialog.tsx": [
    {
      category: "outcome",
      signature: "bg-status-success/15",
      expectedOccurrences: 1,
      rationale: "Recorded result of the clone the user just ran",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the clone the user just ran",
    },
  ],
  "src/components/Project/ContextTab.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the named context test the user ran",
    },
  ],
  "src/components/Project/GeneralTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-gitignore confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Project/GitInitDialog.tsx": [
    {
      category: "outcome",
      signature: "bg-status-success/15",
      expectedOccurrences: 1,
      rationale: "Recorded result of the git init the user just ran",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the git init the user just ran",
    },
  ],
  "src/components/Project/MoveOrRenameProjectDialog.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'label: "Resume supported"',
      expectedOccurrences: 1,
      rationale: "Continuity tier shown while deciding the move; leaves with the dialog",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'label: "Conversation stays with the folder"',
      expectedOccurrences: 1,
      rationale: "Continuity tier shown while deciding the move; leaves with the dialog",
    },
  ],
  "src/components/Project/RecipesTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recipe-exported confirmation; resets when the export flash times out",
    },
  ],
  "src/components/Project/RunningTaskList.tsx": [
    {
      category: "transient",
      signature: "bg-status-success",
      expectedOccurrences: 1,
      rationale: "Finished task; the row auto-clears after AUTO_CLEAR_DELAY",
    },
  ],
  "src/components/Pulse/ProjectPulseCard.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the last CI run on the branch",
    },
    {
      category: "outcome",
      signature: "var(--color-status-success)",
      expectedOccurrences: 1,
      rationale: "Counted result chip; the only success caller is the merged-PR count",
    },
  ],
  "src/components/Pulse/PulseSummary.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the base branch",
    },
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Diff insertion count against the base branch",
    },
  ],
  "src/components/Settings/CodeForgeSettingsTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Credentials-saved confirmation; resets on the next input change",
    },
  ],
  "src/components/Settings/DaintreeAssistantSettingsTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      expectedOccurrences: 2,
      rationale: "Copy-config confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Settings/EditorIntegrationTab.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the editor test the user ran",
    },
  ],
  "src/components/Settings/ForgeAuditLogViewer.tsx": [
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "copyFlashActive",
      expectedOccurrences: 2,
      rationale: "Copy confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "exportFlashActive",
      expectedOccurrences: 2,
      rationale: "Export confirmation; resets when the export flash times out",
    },
  ],
  "src/components/Settings/ImageViewerTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Saved confirmation; resets on the next edit",
    },
  ],
  "src/components/Settings/McpAuditLogViewer.tsx": [
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "copyFlashActive",
      expectedOccurrences: 2,
      rationale: "Copy confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "exportFlashActive",
      expectedOccurrences: 2,
      rationale: "Export confirmation; resets when the export flash times out",
    },
  ],
  "src/components/Settings/McpServerSettingsTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: 'copiedTarget === "plain"',
      expectedOccurrences: 2,
      rationale: "Copy-config confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: 'copiedTarget === "scoped"',
      expectedOccurrences: 2,
      rationale: "Copy-scoped-config confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "copiedKey",
      expectedOccurrences: 2,
      rationale: "Copy-API-key confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Settings/PluginActionAuditLogViewer.tsx": [
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "copyFlashActive",
      expectedOccurrences: 2,
      rationale: "Copy confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success border-status-success/30",
      anchor: "exportFlashActive",
      expectedOccurrences: 2,
      rationale: "Export confirmation; resets when the export flash times out",
    },
  ],
  "src/components/Settings/PortalSettingsTab.tsx": [
    {
      category: "affordance",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Go-colour on the confirm half of a confirm/cancel edit pair",
    },
  ],
  "src/components/Settings/RunHistorySettingsTab.tsx": [
    {
      category: "outcome",
      signature: "bg-status-success/15 text-status-success",
      expectedOccurrences: 2,
      rationale: "Counted results of named runs, beside the matching failure count",
    },
  ],
  "src/components/Settings/TroubleshootingTab.tsx": [
    {
      category: "verification",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "One mark per required tool in a finite prerequisite list",
    },
  ],
  "src/components/Settings/VoiceInputSettingsTab.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the API-key validation the user ran",
    },
    {
      category: "verification",
      signature: "bg-status-success",
      expectedOccurrences: 1,
      rationale: "Microphone permission is a gate voice input cannot start without",
    },
  ],
  "src/components/Settings/WorktreeSettingsTab.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Saved confirmation; resets on the next edit",
    },
  ],
  "src/components/Setup/AgentCliStep.tsx": [
    {
      category: "verification",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "One installed mark per agent row in the setup gate",
    },
  ],
  "src/components/Setup/AgentSetupWizard.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Wizard completion step; leaves with the wizard",
    },
  ],
  "src/components/Setup/CopyableCommand.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-command confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/Setup/SystemRequirementsSection.tsx": [
    {
      category: "verification",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "The single completion summary the ruling allows a finite gate",
    },
  ],
  "src/components/Setup/SystemToolsStep.tsx": [
    {
      category: "verification",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "One mark per required tool in the setup gate",
    },
  ],
  "src/components/Terminal/ArtifactOverlay.tsx": [
    {
      category: "domain",
      signature: "text-status-success bg-status-success/10",
      expectedOccurrences: 2,
      rationale: "Added line in a unified patch",
    },
    {
      category: "affordance",
      signature: "bg-status-success",
      anchor: "onClick={handleApplyPatch}",
      expectedOccurrences: 1,
      rationale: "Go-colour on the apply-patch control",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'feedback.tone === "success"',
      expectedOccurrences: 1,
      rationale: "Apply feedback; replaced on the next action",
    },
    {
      category: "affordance",
      signature: "bg-status-success",
      anchor: "onClick={handleApplyAllPatches}",
      expectedOccurrences: 1,
      rationale: "Go-colour on the apply-all-patches control",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'bulkResult.tone === "success"',
      expectedOccurrences: 1,
      rationale: "Bulk apply feedback; replaced on the next action",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'className="text-status-success"',
      expectedOccurrences: 1,
      rationale: "Per-patch insertion count",
    },
  ],
  "src/components/Terminal/GridNotificationBar.tsx": [
    {
      category: "outcome",
      signature:
        "border-[color-mix(in_oklab,var(--color-status-success)_35%,var(--color-surface-grid))]",
      expectedOccurrences: 1,
      rationale: "Recorded result carried by a success notification on the grid bar",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'iconClass: "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Recorded result carried by a success notification on the grid bar",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'titleClass: "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Recorded result carried by a success notification on the grid bar",
    },
  ],
  "src/components/Terminal/MissingCliGate.tsx": [
    {
      category: "transient",
      signature: "border-status-success/20 bg-status-success/5",
      expectedOccurrences: 2,
      rationale: "CLI-now-available banner; the gate stops rendering once it is seen",
    },
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "CLI-now-available banner; the gate stops rendering once it is seen",
    },
  ],
  "src/components/Terminal/RecipeRunner/RecipeRunnerEmpty.tsx": [
    {
      category: "affordance",
      signature: "text-status-success/50",
      expectedOccurrences: 1,
      rationale: "Go-colour on the run-suggestion control",
    },
    {
      category: "affordance",
      signature: "group-hover:text-status-success",
      expectedOccurrences: 1,
      rationale: "Go-colour on the run-suggestion control at hover",
    },
  ],
  "src/components/Terminal/RecipeRunner/RecipeRunnerItem.tsx": [
    {
      category: "affordance",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Go-colour on the run-recipe control",
    },
    {
      category: "affordance",
      signature: "group-hover:text-status-success",
      expectedOccurrences: 1,
      rationale: "Go-colour on the run-recipe control at hover",
    },
    {
      category: "affordance",
      signature: "text-status-success/50 group-hover:text-status-success",
      expectedOccurrences: 2,
      rationale: "Go-colour on the run-recipe control in the collapsed row",
    },
  ],
  "src/components/TerminalRecipe/RecipeManager.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recipe-exported confirmation; resets when the export flash times out",
    },
  ],
  "src/components/Worktree/CrossWorktreeDiff.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success/80",
      anchor: "+{insertions}",
      expectedOccurrences: 1,
      rationale: "Per-file diff insertion count",
    },
    {
      category: "domain",
      signature: "text-status-success/80",
      anchor: "+{totalInsertions}",
      expectedOccurrences: 1,
      rationale: "Total diff insertion count",
    },
  ],
  "src/components/Worktree/DiffViewer.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Diff addition count in the viewer toolbar",
    },
  ],
  "src/components/Worktree/FileChangeList.tsx": [
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Per-file diff insertion count",
    },
  ],
  "src/components/Worktree/ReviewHub/BaseBranchFileRow.tsx": [
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Per-file diff insertion count",
    },
  ],
  "src/components/Worktree/ReviewHub/CommitPanel.tsx": [
    {
      category: "verification",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "One mark per commit blocker that has to clear before committing",
    },
  ],
  "src/components/Worktree/ReviewHub/ConflictPanel.tsx": [
    {
      category: "verification",
      signature: "text-status-success/60",
      expectedOccurrences: 1,
      rationale: "One mark per conflict that has to be resolved before continuing",
    },
  ],
  "src/components/Worktree/ReviewHub/FileSection.tsx": [
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Section diff insertion count",
    },
  ],
  "src/components/Worktree/ReviewHub/FileStageRow.tsx": [
    {
      category: "domain",
      signature: "bg-status-success/15",
      anchor: 'label: "A"',
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'label: "A"',
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "bg-status-success/15",
      anchor: 'label: "?"',
      expectedOccurrences: 1,
      rationale: "Git status letter ?, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'label: "?"',
      expectedOccurrences: 1,
      rationale: "Git status letter ?, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Per-file diff insertion count",
    },
    {
      category: "verification",
      signature: "accent-status-success",
      expectedOccurrences: 1,
      rationale:
        "One viewed mark per file in the review checklist; the row wash went neutral in #12002",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'className="w-3 h-3 text-status-success"',
      expectedOccurrences: 1,
      rationale: "Plus half of the stage/unstage pair, against the red Minus",
    },
  ],
  "src/components/Worktree/ReviewHub/ReviewHubContent.tsx": [
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Base-branch diff insertion count",
    },
  ],
  "src/components/Worktree/ReviewHub/reviewHubUtils.ts": [
    {
      category: "domain",
      signature: "bg-status-success/15",
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
  ],
  "src/components/Worktree/WorktreeCard/MainWorktreeSummaryRows.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the last CI run on the branch",
    },
  ],
  "src/components/Worktree/WorktreeCard/UpstreamSyncBadge.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      anchor: "↑{aheadCount}",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the upstream",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: "↑{baseAheadCount}",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the base branch",
    },
  ],
  "src/components/Worktree/WorktreeCard/WorktreeDetailsSection.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Worktree diff insertion count",
    },
    {
      category: "affordance",
      signature: "text-status-success/70 hover:text-status-success",
      expectedOccurrences: 2,
      rationale: "Go-colour on the resume-resource control",
    },
  ],
  "src/components/Worktree/WorktreeDetails.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Copy-path confirmation; resets when the copy flash times out",
    },
  ],
  "src/components/ui/ReEntrySummary.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result carried by a success entry in the re-entry summary",
    },
  ],
  "src/components/ui/badge.tsx": [
    {
      category: "outcome",
      signature: "bg-status-success/10 text-status-success",
      expectedOccurrences: 2,
      rationale: "The success tone of the shared badge primitive, for reporting a result",
    },
  ],
  "src/components/ui/button.tsx": [
    {
      category: "affordance",
      signature: "text-status-success hover:bg-status-success/10",
      expectedOccurrences: 2,
      rationale: "Go-colour variant of the shared button primitive",
    },
  ],
  "src/components/ui/toaster.tsx": [
    {
      category: "outcome",
      signature: "border-l-status-success",
      expectedOccurrences: 1,
      rationale: "Left rule of a success toast, which reports the result of a named operation",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Icon of a success toast, which reports the result of a named operation",
    },
  ],
  "src/lib/gitStatusPresentation.ts": [
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'name: "Added"',
      expectedOccurrences: 1,
      rationale: "Git status letter A, the notation git itself paints green",
    },
    {
      category: "domain",
      signature: "text-status-success",
      anchor: 'name: "Untracked"',
      expectedOccurrences: 1,
      rationale: "Git status letter ?, the notation git itself paints green",
    },
  ],
  "src/lib/statusSeverity.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "The success shape of the shared severity vocabulary, for reporting a result",
    },
  ],
  "src/lib/worktreeCIStatus.ts": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the last CI run",
    },
  ],
  "src/panels/file-browser/FileBrowserChangeSummary.tsx": [
    {
      category: "domain",
      signature: "text-status-success/80",
      expectedOccurrences: 1,
      rationale: "Per-file diff insertion count",
    },
  ],
  "src/panels/file-browser/FileBrowserPane.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      anchor: 'showRootPathCopied ? "text-status-success"',
      expectedOccurrences: 1,
      rationale: "Copy-root-path confirmation; resets when the copy flash times out",
    },
    {
      category: "transient",
      signature: "text-status-success",
      anchor: "Copied!",
      expectedOccurrences: 1,
      rationale: "Copy-root-path confirmation in the tooltip; resets with the flash",
    },
  ],
} as const satisfies StatusSuccessInventory;

/**
 * Ratchets. These are not decoration: an equal-count swap (one green removed,
 * another added) still trips the per-site checks, and these catch the case
 * where a whole file moves without either check firing.
 */
export const EXPECTED_STATUS_SUCCESS_SITES = 124;
export const EXPECTED_STATUS_SUCCESS_OCCURRENCES = 146;
