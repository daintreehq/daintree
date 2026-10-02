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
  "plugins/builtin/github/renderer/components/GitHubListItem.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'label: "Approved"',
      expectedOccurrences: 1,
      rationale: "Recorded decision of a named review on the pull request",
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
  "src/components/Commands/CommandBuilder.tsx": [
    {
      category: "outcome",
      signature: "bg-status-success/15",
      expectedOccurrences: 1,
      rationale: "Recorded result of the command the user just ran; leaves with the dialog",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the command the user just ran; leaves with the dialog",
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
  "src/components/Layout/DockActivityCue.tsx": [
    {
      category: "transient",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale:
        "Finished cue shared by docked terminals and groups; the cue decays rather than standing",
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
      anchor: "deltaToMain!.ahead",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the base branch",
    },
  ],
  "src/components/Settings/ApiKeyRow.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of the API-key validation the user ran",
    },
  ],
  "src/components/Settings/VoiceInputSettingsTab.tsx": [
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
      category: "outcome",
      signature: "text-status-success",
      anchor: 'tone === "success" && "text-status-success"',
      expectedOccurrences: 1,
      rationale:
        "A row's recorded `git apply` result, beside the files it touched; replaced by the next attempt",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'className="size-3.5 shrink-0 mt-px text-status-success"',
      expectedOccurrences: 1,
      rationale:
        "The result of a named bulk copy, save or apply run; copy and save clear on a timer, apply until dismissed or rerun",
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
  ],
  "src/components/Worktree/ReviewHub/FileSection.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
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
  ],
  "src/components/Worktree/ReviewHub/prChecks.ts": [
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Recorded result of one named CI check on the pull request",
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
      anchor: "↑{displayedBaseAhead}",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the base branch",
    },
  ],
  "src/components/Worktree/WorktreeOverviewRow.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      anchor: "↑{ahead}",
      expectedOccurrences: 1,
      rationale: "Ahead-arrow count against the upstream, as the sidebar card paints it",
    },
  ],
  "src/components/ui/Callout.tsx": [
    {
      category: "outcome",
      signature: "border-status-success/20 bg-status-success/10",
      expectedOccurrences: 2,
      rationale:
        "The success tone of the shared callout primitive, for a result that just happened (a CLI detected on re-check)",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale: "Glyph of the callout primitive's success tone, beside the result it reports",
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
  "src/components/PluginKit/PluginKitTypography.tsx": [
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: 'success: "text-status-success"',
      expectedOccurrences: 1,
      rationale:
        'Text\'s success tone: the public kit role a plugin states a named result in ("1,204 chunks uploaded"), as Badge and Callout already expose',
    },
    {
      category: "outcome",
      signature: "bg-status-success",
      expectedOccurrences: 1,
      rationale:
        "StatusDot's success state: the recorded result of a run or check the plugin names in the dot's label",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: "SEVERITY_GLYPH.success",
      expectedOccurrences: 1,
      rationale:
        "StateGlyph's success state: the severity success glyph for a named passed result, the same pairing SeverityIcon draws",
    },
  ],
  "src/components/PluginKit/PluginKitGit.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      anchor: "↑{entry.ahead}",
      expectedOccurrences: 1,
      rationale:
        "WorktreeBadge's ahead-arrow count against the upstream, as UpstreamSyncBadge draws it",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: '"Checks passing"',
      expectedOccurrences: 1,
      rationale:
        "PullRequestRow's CI slot: the recorded result of the pull request's checks roll-up",
    },
    {
      category: "outcome",
      signature: "text-status-success",
      anchor: '"Approved"',
      expectedOccurrences: 1,
      rationale:
        "PullRequestRow's review verdict: the forge's recorded approval of the pull request",
    },
  ],
  "src/components/ui/DiffStat.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale:
        "The one line-churn stat: the insertion count every diff row, summary and card renders through",
    },
  ],
  "src/components/Tour/scenes/ReviewScene.tsx": [
    {
      category: "domain",
      signature: "text-status-success",
      expectedOccurrences: 1,
      rationale:
        "The tour's Review Hub mock spells DiffStat's insertion count inline (tour scenes can't import host components)",
    },
  ],
} as const satisfies StatusSuccessInventory;

/**
 * Ratchets. These are not decoration: an equal-count swap (one green removed,
 * another added) still trips the per-site checks, and these catch the case
 * where a whole file moves without either check firing.
 */
export const EXPECTED_STATUS_SUCCESS_SITES = 64;
export const EXPECTED_STATUS_SUCCESS_OCCURRENCES = 66;
