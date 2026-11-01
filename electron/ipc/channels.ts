export const CHANNELS = {
  WORKTREE_GET_ALL: "worktree:get-all",
  WORKTREE_GET_ALL_WITH_STATUS: "worktree:get-all-with-status",
  WORKTREE_REFRESH: "worktree:refresh",
  WORKTREE_SET_ACTIVE: "worktree:set-active",
  WORKTREE_REMOVE: "worktree:remove",
  WORKTREE_ACTIVATED: "worktree:activated",
  WORKTREE_CREATE: "worktree:create",
  WORKTREE_LIST_BRANCHES: "worktree:list-branches",
  WORKTREE_FETCH_PR_BRANCH: "worktree:fetch-pr-branch",
  WORKTREE_GET_RECENT_BRANCHES: "worktree:get-recent-branches",
  WORKTREE_PR_REFRESH: "worktree:pr-refresh",
  WORKTREE_PR_STATUS: "worktree:pr-status",
  WORKTREE_GET_DEFAULT_PATH: "worktree:get-default-path",
  WORKTREE_GET_AVAILABLE_BRANCH: "worktree:get-available-branch",
  WORKTREE_DELETE: "worktree:delete",
  WORKTREE_ATTACH_ISSUE: "worktree:attach-issue",
  WORKTREE_DETACH_ISSUE: "worktree:detach-issue",
  WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS: "worktree:get-all-issue-associations",
  WORKTREE_HOST_DISCONNECTED: "worktree:host-disconnected",
  WORKTREE_PORT_ACK: "worktree:port-ack",
  WORKTREE_RESTART_SERVICE: "worktree:restart-service",
  WORKTREE_RETRY_PROJECT_LOAD: "worktree:retry-project-load",
  WORKTREE_RETRY_AUTH_FETCH: "worktree:retry-auth-fetch",
  PROJECT_WORKTREE_LOAD_STATUS: "project:worktree-load-status",

  TERMINAL_SPAWN: "terminal:spawn",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_INPUT: "terminal:input",
  TERMINAL_SUBMIT: "terminal:submit",
  TERMINAL_GET_SUBMISSIONS: "terminal:get-submissions",
  TERMINAL_GET_OUTPUT_ACTIVITY: "terminal:get-output-activity",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_ERROR: "terminal:error",
  TERMINAL_TRASH: "terminal:trash",
  TERMINAL_RESTORE: "terminal:restore",
  TERMINAL_TRASHED: "terminal:trashed",
  TERMINAL_RESTORED: "terminal:restored",
  TERMINAL_SET_ACTIVITY_TIER: "terminal:set-activity-tier",
  TERMINAL_SET_FOCUSED: "terminal:set-focused",
  TERMINAL_GET_FOR_PROJECT: "terminal:get-for-project",
  TERMINAL_GET_AVAILABLE: "terminal:get-available",
  TERMINAL_GET_BY_STATE: "terminal:get-by-state",
  TERMINAL_GET_ALL: "terminal:get-all",
  TERMINAL_SEARCH_SEMANTIC_BUFFERS: "terminal:search-semantic-buffers",
  TERMINAL_RECONNECT: "terminal:reconnect",
  TERMINAL_RECONNECT_BULK: "terminal:reconnect-bulk",
  TERMINAL_REPLAY_HISTORY: "terminal:replay-history",
  TERMINAL_GET_SERIALIZED_STATE: "terminal:get-serialized-state",
  TERMINAL_GET_SERIALIZED_STATES: "terminal:get-serialized-states",
  TERMINAL_GET_SHARED_BUFFERS: "terminal:get-shared-buffers",
  TERMINAL_GET_INFO: "terminal:get-info",
  TERMINAL_LOCATE: "terminal:locate",
  TERMINAL_ACKNOWLEDGE_DATA: "terminal:acknowledge-data",
  TERMINAL_FORCE_RESUME: "terminal:force-resume",
  TERMINAL_GET_HOST_MEMORY_PAUSE: "terminal:get-host-memory-pause",
  TERMINAL_REQUEST_WORKER_INGEST_PORT: "terminal:request-worker-ingest-port",
  TERMINAL_RELEASE_WORKER_INGEST_PORT: "terminal:release-worker-ingest-port",
  TERMINAL_GRACEFUL_KILL: "terminal:graceful-kill",
  TERMINAL_STATUS: "terminal:status",
  TERMINAL_SEND_KEY: "terminal:send-key",
  TERMINAL_BATCH_DOUBLE_ESCAPE: "terminal:batch-double-escape",
  TERMINAL_BROADCAST_WRITE: "terminal:broadcast-write",
  TERMINAL_BROADCAST_WRITE_RESULT: "terminal:broadcast-write-result",
  TERMINAL_AGENT_TITLE_STATE: "terminal:agent-title-state",
  TERMINAL_UPDATE_OBSERVED_TITLE: "terminal:update-observed-title",
  TERMINAL_UPDATE_TITLE: "terminal:update-title",
  TERMINAL_UPDATE_WORKTREE_ID: "terminal:update-worktree-id",
  TERMINAL_REDUCE_SCROLLBACK: "terminal:reduce-scrollback",
  TERMINAL_RESTORE_SCROLLBACK: "terminal:restore-scrollback",
  TERMINAL_RESTART_SERVICE: "terminal:restart-service",
  WATCHDOG_RESTART: "watchdog:restart",
  TERMINAL_RESOURCE_METRICS: "terminal:resource-metrics",

  AGENT_SESSION_LIST: "agent-session:list",
  AGENT_SESSION_CLEAR: "agent-session:clear",
  AGENT_SESSION_GET_RETENTION: "agent-session:get-retention",
  AGENT_SESSION_SET_RETENTION: "agent-session:set-retention",
  AGENT_SESSION_PREPARE_BOOKMARK: "agent-session:prepare-bookmark",
  AGENT_SESSION_PROMOTE_BOOKMARK: "agent-session:promote-bookmark",
  AGENT_SESSION_RENAME_BOOKMARK: "agent-session:rename-bookmark",
  AGENT_SESSION_DELETE_BOOKMARK: "agent-session:delete-bookmark",
  AGENT_SESSION_LIST_BOOKMARKS: "agent-session:list-bookmarks",

  FILES_SEARCH: "files:search",
  FILES_READ: "files:read",
  FILES_TRASH: "files:trash",

  FILE_DOCUMENT_READ: "file-document:read",
  FILE_DOCUMENT_SAVE: "file-document:save",

  DIFF_MEDIA_READ_FILE_VERSIONS: "diff-media:read-file-versions",

  FILE_BROWSER_LIST_DIRECTORY: "file-browser:list-directory",
  FILE_BROWSER_STAT_PATHS: "file-browser:stat-paths",

  FILE_WATCH_FINGERPRINT: "file-watch:fingerprint",

  TERMINAL_ACTIVITY: "terminal:activity",

  ARTIFACT_DETECTED: "artifact:detected",
  ARTIFACT_SAVE_TO_FILE: "artifact:save-to-file",
  ARTIFACT_APPLY_PATCH: "artifact:apply-patch",

  COPYTREE_GENERATE: "copytree:generate",
  COPYTREE_GENERATE_AND_COPY_FILE: "copytree:generate-and-copy-file",
  COPYTREE_INJECT: "copytree:inject",
  COPYTREE_AVAILABLE: "copytree:available",
  COPYTREE_PROGRESS: "copytree:progress",
  COPYTREE_CANCEL: "copytree:cancel",
  COPYTREE_GET_FILE_TREE: "copytree:get-file-tree",
  COPYTREE_TEST_CONFIG: "copytree:test-config",

  EDITOR_GET_CONFIG: "editor:get-config",
  EDITOR_SET_CONFIG: "editor:set-config",
  EDITOR_DISCOVER: "editor:discover",

  PAINT_SURFACE_CREATE: "paint-surface:create",
  PAINT_SURFACE_DESTROY: "paint-surface:destroy",
  PAINT_SURFACE_SET_BOUNDS: "paint-surface:set-bounds",
  PAINT_SURFACE_APPLY_WEBGL_THRESHOLDS: "paint-surface:apply-webgl-thresholds",
  // Main → surface-view push carrying the webglBudget waterfill grant.
  PAINT_SURFACE_WEBGL_THRESHOLDS: "paint-surface:webgl-thresholds",

  SYSTEM_OPEN_EXTERNAL: "system:open-external",
  SYSTEM_OPEN_PATH: "system:open-path",
  SYSTEM_SHOW_ITEM_IN_FOLDER: "system:show-item-in-folder",
  SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED: "system:show-item-in-folder-unconfined",
  SYSTEM_OPEN_IN_EDITOR: "system:open-in-editor",
  SYSTEM_CHECK_COMMAND: "system:check-command",
  SYSTEM_CHECK_DIRECTORY: "system:check-directory",
  SYSTEM_GET_HOME_DIR: "system:get-home-dir",
  SYSTEM_GET_TMP_DIR: "system:get-tmp-dir",
  SYSTEM_GET_CLI_AVAILABILITY: "system:get-cli-availability",
  SYSTEM_REFRESH_CLI_AVAILABILITY: "system:refresh-cli-availability",
  SYSTEM_GET_AGENT_CLI_DETAILS: "system:get-agent-cli-details",
  SYSTEM_GET_AGENT_VERSIONS: "system:get-agent-versions",
  SYSTEM_GET_AGENT_VERSION: "system:get-agent-version",
  SYSTEM_REFRESH_AGENT_VERSIONS: "system:refresh-agent-versions",
  SYSTEM_GET_AGENT_UPDATE_SETTINGS: "system:get-agent-update-settings",
  SYSTEM_SET_AGENT_UPDATE_SETTINGS: "system:set-agent-update-settings",
  SYSTEM_START_AGENT_UPDATE: "system:start-agent-update",
  SETUP_AGENT_INSTALL: "setup:agent-install",
  SETUP_AGENT_INSTALL_PROGRESS: "setup:agent-install-progress",

  SYSTEM_HEALTH_CHECK: "system:health-check",
  SYSTEM_HEALTH_CHECK_SPECS: "system:health-check-specs",
  SYSTEM_CHECK_TOOL: "system:check-tool",
  SYSTEM_DOWNLOAD_DIAGNOSTICS: "system:download-diagnostics",
  SYSTEM_COLLECT_DIAGNOSTICS_FOR_REVIEW: "system:collect-diagnostics-for-review",
  SYSTEM_SAVE_DIAGNOSTICS_BUNDLE: "system:save-diagnostics-bundle",
  SYSTEM_GET_APP_METRICS: "system:get-app-metrics",
  SYSTEM_GET_HARDWARE_INFO: "system:get-hardware-info",
  SYSTEM_GET_RESOURCE_PROFILE: "system:get-resource-profile",
  SYSTEM_GET_RESOURCE_PROFILE_SNAPSHOT: "system:get-resource-profile-snapshot",
  SYSTEM_GET_WHY_SLOW_SNAPSHOT: "system:get-why-slow-snapshot",
  SYSTEM_GET_MEMORY_SNAPSHOT: "system:get-memory-snapshot",
  SYSTEM_IS_MEMORY_PRESSURE_CRITICAL: "system:is-memory-pressure-critical",
  SYSTEM_REPORT_TERMINAL_RENDERER_DIAGNOSTICS: "system:report-terminal-renderer-diagnostics",
  DIAGNOSTICS_GET_PROCESS_METRICS: "diagnostics:get-process-metrics",
  DIAGNOSTICS_GET_HEAP_STATS: "diagnostics:get-heap-stats",
  DIAGNOSTICS_GET_INFO: "diagnostics:get-info",
  SYSTEM_GET_REPORT_ENRICHMENT: "system:get-report-enrichment",
  SYSTEM_REPORT_BLINK_MEMORY: "system:report-blink-memory",
  SYSTEM_REPORT_RENDERER_ELU: "system:report-renderer-elu",
  SYSTEM_RENDERER_CPU_PROFILE_START: "system:renderer-cpu-profile-start",
  SYSTEM_RENDERER_CPU_PROFILE_STOP: "system:renderer-cpu-profile-stop",

  PR_DETECTED: "pr:detected",
  PR_CLEARED: "pr:cleared",
  ISSUE_DETECTED: "issue:detected",
  ISSUE_NOT_FOUND: "issue:not-found",

  APP_GET_STATE: "app:get-state",
  APP_SET_STATE: "app:set-state",
  APP_PANEL_GRID_CONFIG_CHANGED: "app:panel-grid-config-changed",
  APP_GET_VERSION: "app:get-version",
  APP_GET_VERSION_INFO: "app:get-version-info",
  APP_HYDRATE: "app:hydrate",
  APP_BOOT: "app:boot",
  APP_QUIT: "app:quit",
  APP_FORCE_QUIT: "app:force-quit",
  APP_RESET_AND_RELAUNCH: "app:reset-and-relaunch",
  APP_CLEAR_QUARANTINED_PANEL: "app:clear-quarantined-panel",
  APP_SKELETON_PARSED: "app:skeleton-parsed",
  APP_FIRST_INTERACTIVE: "app:first-interactive",
  APP_VIEW_PAINTED: "app:view-painted",
  APP_VIEW_WARM_PAINTED: "app:view-warm-painted",
  APP_VIEW_REVEALED: "app:view-revealed",
  APP_VIEW_WARM_ACTIVATED: "app:view-warm-activated",
  APP_VIEW_CACHED: "app:view-cached",
  APP_VIEW_CACHED_FLUSH_ARMED: "app:view-cached-flush-armed",
  APP_VIEW_CACHED_FLUSHED: "app:view-cached-flushed",
  APP_DISMISS_ROSETTA_WARNING: "app:dismiss-rosetta-warning",
  MENU_ACTION: "menu:action",
  MENU_SHOW_CONTEXT: "menu:show-context",
  MENU_SHOW_APPLICATION: "menu:show-application",

  LOGS_GET_ALL: "logs:get-all",
  LOGS_GET_SOURCES: "logs:get-sources",
  LOGS_CLEAR: "logs:clear",
  LOGS_ENTRY: "logs:entry",
  LOGS_BATCH: "logs:batch",
  LOGS_OPEN_FILE: "logs:open-file",
  LOGS_SET_VERBOSE: "logs:set-verbose",
  LOGS_GET_VERBOSE: "logs:get-verbose",
  LOGS_WRITE: "logs:write",
  LOGS_WRITE_BATCH: "logs:write-batch",
  LOGS_GET_DEFAULT_LEVEL: "logs:get-default-level",
  LOGS_GET_LEVEL_OVERRIDES: "logs:get-level-overrides",
  LOGS_SET_LEVEL_OVERRIDES: "logs:set-level-overrides",
  LOGS_CLEAR_LEVEL_OVERRIDES: "logs:clear-level-overrides",
  LOGS_LEVEL_OVERRIDES_CHANGED: "logs:level-overrides-changed",
  LOGS_GET_REGISTRY: "logs:get-registry",

  ERROR_NOTIFY: "error:notify",
  ERROR_RETRY: "error:retry",
  ERROR_RETRY_CANCEL: "error:retry-cancel",
  ERROR_RETRY_PROGRESS: "error:retry-progress",
  ERROR_OPEN_LOGS: "error:open-logs",
  ERROR_GET_PENDING: "error:get-pending",

  EVENT_INSPECTOR_GET_EVENTS: "event-inspector:get-events",
  EVENT_INSPECTOR_GET_FILTERED: "event-inspector:get-filtered",
  EVENT_INSPECTOR_CLEAR: "event-inspector:clear",
  EVENT_INSPECTOR_EVENT_BATCH: "event-inspector:event-batch",
  EVENT_INSPECTOR_SUBSCRIBE: "event-inspector:subscribe",
  EVENT_INSPECTOR_UNSUBSCRIBE: "event-inspector:unsubscribe",

  EVENTS_EMIT: "events:emit",
  EVENTS_PUSH: "events:push",

  PROJECT_GET_ALL: "project:get-all",
  PROJECT_GET_CURRENT: "project:get-current",
  PROJECT_ADD: "project:add",
  PROJECT_REMOVE: "project:remove",
  PROJECT_UPDATE: "project:update",
  PROJECT_UPDATED: "project:updated",
  PROJECT_SLEPT: "project:slept",
  PROJECT_REMOVED: "project:removed",
  PROJECT_SWITCH: "project:switch",
  PROJECT_PREFETCH_HYDRATE: "project:prefetch-hydrate",
  PROJECT_OPEN_DIALOG: "project:open-dialog",
  PROJECT_ON_SWITCH: "project:on-switch",
  PROJECT_FOCUS_ON_ACTIVATE: "project:focus-on-activate",
  PROJECT_PANEL_RECOVERY_QUERY: "project:panel-recovery-query",
  PROJECT_PANEL_RECOVERY_REPLY: "project:panel-recovery-reply",
  PROJECT_PANEL_RECOVERY_STATE: "project:panel-recovery-state",
  PROJECT_BACKGROUND_RESIZE: "project:background-resize",
  PROJECT_GET_SETTINGS: "project:get-settings",
  PROJECT_SAVE_SETTINGS: "project:save-settings",
  PROJECT_ADD_BROWSER_ALLOWED_HOST: "project:add-browser-allowed-host",
  PROJECT_DETECT_RUNNERS: "project:detect-runners",
  PROJECT_LIST_REMOTES: "project:list-remotes",
  PROJECT_CLOSE: "project:close",
  PROJECT_SLEEP: "project:sleep",
  PROJECT_REOPEN: "project:reopen",
  PROJECT_GET_STATS: "project:get-stats",
  PROJECT_GET_BULK_STATS: "project:get-bulk-stats",
  PROJECT_GET_NOTIFICATION_OVERRIDES: "project:get-notification-overrides",
  PROJECT_STATS_UPDATED: "project:stats-updated",
  FLEET_SNAPSHOT_UPDATED: "fleet:snapshot-updated",
  CANOPY_SNAPSHOT_UPDATED: "canopy:snapshot-updated",
  CANOPY_TERMINAL_DATA: "canopy:terminal-data",
  CANOPY_TRASH_REQUESTED: "canopy:trash-requested",
  CANOPY_RESTORE_REQUESTED: "canopy:restore-requested",
  CANOPY_REMOVE_REQUESTED: "canopy:remove-requested",
  CANOPY_RESUME_REQUESTED: "canopy:resume-requested",
  CANOPY_RENAME_REQUESTED: "canopy:rename-requested",
  FLEET_GET_SNAPSHOT: "fleet:get-snapshot",
  FLEET_PARK_RUN: "fleet:park-run",
  FLEET_UNPARK_RUN: "fleet:unpark-run",
  FLEET_SNOOZE_RUN: "fleet:snooze-run",
  FLEET_UNSNOOZE_RUN: "fleet:unsnooze-run",
  FLEET_NOTE_RUN_LOOK: "fleet:note-run-look",
  FLEET_MARK_RUN_READ: "fleet:mark-run-read",
  FLEET_MARK_RUN_UNREAD: "fleet:mark-run-unread",
  CANOPY_GET_SNAPSHOT: "canopy:get-snapshot",
  CANOPY_SET_ACTIVE: "canopy:set-active",
  CANOPY_REFRESH: "canopy:refresh",
  CANOPY_TRASH: "canopy:trash",
  CANOPY_UNTRASH: "canopy:untrash",
  CANOPY_RESTORE_TRASHED: "canopy:restore-trashed",
  CANOPY_REMOVE_TRASHED: "canopy:remove-trashed",
  CANOPY_EMPTY_TRASH: "canopy:empty-trash",
  CANOPY_RESUME_STARTED: "canopy:resume-started",
  CANOPY_RESUME_SETTLED: "canopy:resume-settled",
  CANOPY_REREAD: "canopy:reread",
  CANOPY_SET_SHOWN: "canopy:set-shown",
  CANOPY_ARCHIVE: "canopy:archive",
  CANOPY_UNARCHIVE: "canopy:unarchive",
  CANOPY_ANSWER: "canopy:answer",
  CANOPY_MARK_SEEN: "canopy:mark-seen",
  CANOPY_SET_READ: "canopy:set-read",
  CANOPY_MARK_ALL_READ: "canopy:mark-all-read",
  CANOPY_RESTORE_READS: "canopy:restore-reads",
  CANOPY_NOTE_SENT: "canopy:note-sent",
  CANOPY_SET_SCOPE: "canopy:set-scope",
  CANOPY_RUN_BRANCH: "canopy:run-branch",
  CANOPY_SEARCH_SCREENS: "canopy:search-screens",
  CANOPY_WATCH_TERMINAL: "canopy:watch-terminal",
  CANOPY_WATCH_ASSISTANT_TERMINAL: "canopy:watch-assistant-terminal",
  CANOPY_RESOLVE_ASSISTANT: "canopy:resolve-assistant",
  CANOPY_READ_AGENT_DIRECTORY: "canopy:read-agent-directory",
  CANOPY_READ_ASSISTANT_WORK: "canopy:read-assistant-work",
  CANOPY_UNWATCH_TERMINAL: "canopy:unwatch-terminal",
  CANOPY_SET_MODE: "canopy:set-mode",
  CANOPY_GET_MODEL: "canopy:get-model",
  CANOPY_GET_SIZE_HOLDS: "canopy:get-size-holds",
  CANOPY_RETRY_MODEL: "canopy:retry-model",
  CANOPY_REMOVE_MODELS: "canopy:remove-models",
  CANOPY_RENAME: "canopy:rename",
  CANOPY_TERMINAL_INPUT: "canopy:terminal-input",
  CANOPY_TERMINAL_RESIZE: "canopy:terminal-resize",
  CANOPY_TERMINAL_SEND_KEY: "canopy:terminal-send-key",
  CANOPY_TERMINAL_SUBMIT: "canopy:terminal-submit",
  CANOPY_SUBMIT_REPLY: "canopy:submit-reply",
  PROJECT_HISTORY_PEEK: "project-history:peek",
  PROJECT_CREATE_FOLDER: "project:create-folder",
  PROJECT_INIT_GIT: "project:init-git",
  PROJECT_INIT_GIT_GUIDED: "project:init-git-guided",
  PROJECT_INIT_GIT_PROGRESS: "project:init-git-progress",
  PROJECT_OPEN_GIT_INIT_DIALOG: "project:open-git-init-dialog",
  PROJECT_CLONE_REPO: "project:clone-repo",
  PROJECT_CLONE_PROGRESS: "project:clone-progress",
  PROJECT_CLONE_CANCEL: "project:clone-cancel",
  PROJECT_GET_RECIPES: "project:get-recipes",
  PROJECT_SAVE_RECIPES: "project:save-recipes",
  PROJECT_ADD_RECIPE: "project:add-recipe",
  PROJECT_UPDATE_RECIPE: "project:update-recipe",
  PROJECT_DELETE_RECIPE: "project:delete-recipe",
  RECIPE_EXPORT_FILE: "recipe:export-file",
  RECIPE_IMPORT_FILE: "recipe:import-file",
  PROJECT_GET_INREPO_RECIPES: "project:get-inrepo-recipes",
  PROJECT_SYNC_INREPO_RECIPES: "project:sync-inrepo-recipes",
  PROJECT_UPDATE_INREPO_RECIPE: "project:update-inrepo-recipe",
  PROJECT_DELETE_INREPO_RECIPE: "project:delete-inrepo-recipe",
  PROJECT_GET_INREPO_PRESETS: "project:get-inrepo-presets",

  GLOBAL_GET_RECIPES: "global:get-recipes",
  GLOBAL_ADD_RECIPE: "global:add-recipe",
  GLOBAL_UPDATE_RECIPE: "global:update-recipe",
  GLOBAL_DELETE_RECIPE: "global:delete-recipe",
  GLOBAL_ENV_GET: "global-env:get",
  GLOBAL_ENV_SET: "global-env:set",

  PROJECT_GET_TERMINALS: "project:get-terminals",
  PROJECT_SET_TERMINALS: "project:set-terminals",
  PROJECT_GET_TERMINAL_SIZES: "project:get-terminal-sizes",
  PROJECT_SET_TERMINAL_SIZES: "project:set-terminal-sizes",
  PROJECT_GET_DRAFT_INPUTS: "project:get-draft-inputs",
  PROJECT_SET_DRAFT_INPUTS: "project:set-draft-inputs",
  PROJECT_GET_TAB_GROUPS: "project:get-tab-groups",
  PROJECT_SET_TAB_GROUPS: "project:set-tab-groups",
  PROJECT_GET_FOCUS_MODE: "project:get-focus-mode",
  PROJECT_SET_FOCUS_MODE: "project:set-focus-mode",
  PROJECT_READ_CLAUDE_MD: "project:read-claude-md",
  PROJECT_WRITE_CLAUDE_MD: "project:write-claude-md",
  PROJECT_ENABLE_IN_REPO_SETTINGS: "project:enable-in-repo-settings",
  PROJECT_DISABLE_IN_REPO_SETTINGS: "project:disable-in-repo-settings",
  PROJECT_CHECK_MISSING: "project:check-missing",
  PROJECT_LOCATE: "project:locate",
  PROJECT_RELOCATION_PREVIEW: "project-relocation:preview",
  PROJECT_RELOCATION_APPLY: "project-relocation:apply",
  AGENT_SETTINGS_GET: "agent-settings:get",
  AGENT_SETTINGS_SET: "agent-settings:set",
  AGENT_SETTINGS_SET_GLOBAL: "agent-settings:set-global",
  AGENT_SETTINGS_SET_GLOBAL_INLINE: "agent-settings:set-global-inline",
  AGENT_SETTINGS_SET_RESUME_ON_RESTART: "agent-settings:set-resume-on-restart",
  AGENT_SETTINGS_RESET: "agent-settings:reset",
  AGENT_SETTINGS_STAMP_VERSION: "agent-settings:stamp-version",
  AGENT_SETTINGS_CHANGED: "agent-settings:changed",

  AGENT_HELP_GET: "agent-help:get",

  USER_AGENT_REGISTRY_GET: "user-agent-registry:get",
  USER_AGENT_REGISTRY_ADD: "user-agent-registry:add",
  USER_AGENT_REGISTRY_UPDATE: "user-agent-registry:update",
  USER_AGENT_REGISTRY_REMOVE: "user-agent-registry:remove",

  TERMINAL_CONFIG_GET: "terminal-config:get",
  TERMINAL_CONFIG_SET_SCROLLBACK: "terminal-config:set-scrollback",
  TERMINAL_CONFIG_SET_PERFORMANCE_MODE: "terminal-config:set-performance-mode",
  TERMINAL_CONFIG_SET_FONT_SIZE: "terminal-config:set-font-size",
  TERMINAL_CONFIG_SET_FONT_FAMILY: "terminal-config:set-font-family",
  TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED: "terminal-config:set-hybrid-input-enabled",
  TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS: "terminal-config:set-hybrid-input-auto-focus",
  TERMINAL_CONFIG_SET_COLOR_SCHEME: "terminal-config:set-color-scheme",
  TERMINAL_CONFIG_SET_CUSTOM_SCHEMES: "terminal-config:set-custom-schemes",
  TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS: "terminal-config:set-recent-scheme-ids",
  TERMINAL_CONFIG_IMPORT_COLOR_SCHEME: "terminal-config:import-color-scheme",
  TERMINAL_CONFIG_SET_SCREEN_READER_MODE: "terminal-config:set-screen-reader-mode",
  TERMINAL_CONFIG_SET_RESOURCE_MONITORING: "terminal-config:set-resource-monitoring",
  TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION: "terminal-config:set-memory-leak-detection",
  TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART: "terminal-config:set-memory-leak-auto-restart",
  TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS: "terminal-config:set-cached-project-views",
  TERMINAL_CONFIG_DEVICE_CHANGED: "terminal-config:device-changed",
  TERMINAL_CONFIG_HOST_CHANGED: "terminal-config:host-changed",

  ACCESSIBILITY_GET_ENABLED: "accessibility:get-enabled",
  ACCESSIBILITY_SUPPORT_CHANGED: "accessibility:support-changed",
  /** Broadcast after a configuration bundle applied, so every view refreshes its mirrors (#11889). */
  CONFIG_BUNDLE_IMPORTED: "config-bundle:imported",

  GIT_GET_FILE_DIFF: "git:get-file-diff",
  GIT_GET_PROJECT_PULSE: "git:get-project-pulse",
  GIT_LIST_COMMITS: "git:list-commits",
  GIT_STAGE_FILE: "git:stage-file",
  GIT_UNSTAGE_FILE: "git:unstage-file",
  GIT_STAGE_FILES: "git:stage-files",
  GIT_UNSTAGE_FILES: "git:unstage-files",
  GIT_STAGE_ALL: "git:stage-all",
  GIT_UNSTAGE_ALL: "git:unstage-all",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL_REBASE: "git:pull-rebase",
  GIT_FETCH: "git:fetch",
  GIT_DISCARD_FILE_CHANGES: "git:discard-file-changes",
  GIT_PREVIEW_FILE_MUTATION: "git:preview-file-mutation",
  GIT_FORCE_PUSH_WITH_LEASE: "git:force-push-with-lease",
  GIT_LIST_REMOTE_COMMITS: "git:list-remote-commits",
  GIT_LIST_PUSH_COMMITS: "git:list-push-commits",
  GIT_LIST_REBASE_COMMITS: "git:list-rebase-commits",
  GIT_LIST_BASE_INTEGRATION_COMMITS: "git:list-base-integration-commits",
  GIT_REBASE_ONTO_BASE: "git:rebase-onto-base",
  GIT_MERGE_BASE_INTO_BRANCH: "git:merge-base-into-branch",
  GIT_PUSH_PROGRESS: "git:push-progress",
  GIT_GET_STAGING_STATUS: "git:get-staging-status",
  GIT_COMPARE_WORKTREES: "git:compare-worktrees",
  GIT_GET_USERNAME: "git:get-username",
  GIT_GET_WORKING_DIFF: "git:get-working-diff",
  GIT_ABORT_REPOSITORY_OPERATION: "git:abort-repository-operation",
  GIT_CONTINUE_REPOSITORY_OPERATION: "git:continue-repository-operation",
  GIT_SCAN_CONFLICT_MARKERS: "git:scan-conflict-markers",
  GIT_CHECKOUT_OURS_THEIRS: "git:checkout-ours-theirs",
  GIT_MARK_SAFE_DIRECTORY: "git:mark-safe-directory",

  PORTAL_CREATE: "portal:create",
  PORTAL_SHOW: "portal:show",
  PORTAL_HIDE: "portal:hide",
  PORTAL_RESIZE: "portal:resize",
  PORTAL_CLOSE_TAB: "portal:close-tab",
  PORTAL_NAVIGATE: "portal:navigate",
  PORTAL_GO_BACK: "portal:go-back",
  PORTAL_GO_FORWARD: "portal:go-forward",
  PORTAL_RELOAD: "portal:reload",
  PORTAL_NAV_EVENT: "portal:nav-event",
  PORTAL_FOCUS: "portal:focus",
  PORTAL_BLUR: "portal:blur",
  PORTAL_TAB_EVICTED: "portal:tab-evicted",
  PORTAL_TABS_EVICTED: "portal:tabs-evicted",

  SESSION_RESTORE_GET_CONFIG: "session-restore:get-config",
  SESSION_RESTORE_UPDATE_CONFIG: "session-restore:update-config",
  SESSION_RESTORE_VIEW_HYDRATED: "session-restore:view-hydrated",
  WINDOW_OPENING_GET_CONFIG: "window-opening:get-config",
  WINDOW_OPENING_UPDATE_CONFIG: "window-opening:update-config",
  KEEP_AWAKE_GET_STATE: "keep-awake:get-state",
  KEEP_AWAKE_UPDATE_CONFIG: "keep-awake:update-config",
  KEEP_AWAKE_STATE_CHANGED: "keep-awake:state-changed",

  IDLE_TERMINAL_GET_CONFIG: "idle-terminal:get-config",
  IDLE_TERMINAL_UPDATE_CONFIG: "idle-terminal:update-config",
  IDLE_TERMINAL_CLOSE_PROJECT: "idle-terminal:close-project",
  IDLE_TERMINAL_DISMISS_PROJECT: "idle-terminal:dismiss-project",
  IDLE_TERMINAL_NOTIFY: "idle-terminal:notify",

  IDLE_BACKGROUND_GET_CONFIG: "idle-background:get-config",
  IDLE_BACKGROUND_UPDATE_CONFIG: "idle-background:update-config",
  IDLE_BACKGROUND_CLOSED: "idle-background:closed",

  WEBVIEW_SET_LIFECYCLE_STATE: "webview:set-lifecycle-state",
  WEBVIEW_REGISTER_PANEL: "webview:register-panel",
  WEBVIEW_DIALOG_REQUEST: "webview:dialog-request",
  WEBVIEW_DIALOG_RESPONSE: "webview:dialog-response",
  WEBVIEW_DIALOG_DISMISS: "webview:dialog-dismiss",
  WEBVIEW_FIND_SHORTCUT: "webview:find-shortcut",
  WEBVIEW_RELOAD_SHORTCUT: "webview:reload-shortcut",
  WEBVIEW_CLOSE_SHORTCUT: "webview:close-shortcut",
  WEBVIEW_NAVIGATION_BLOCKED: "webview:navigation-blocked",
  WEBVIEW_UNRESPONSIVE: "webview:unresponsive",
  WEBVIEW_RESPONSIVE: "webview:responsive",
  WEBVIEW_OAUTH_LOOPBACK: "webview:oauth-loopback",
  WEBVIEW_CANCEL_OAUTH_LOOPBACK: "webview:cancel-oauth-loopback",
  WEBVIEW_OAUTH_LOOPBACK_STATUS: "webview:oauth-loopback-status",
  WEBVIEW_START_CONSOLE_CAPTURE: "webview:start-console-capture",
  WEBVIEW_STOP_CONSOLE_CAPTURE: "webview:stop-console-capture",
  WEBVIEW_CLEAR_CONSOLE_CAPTURE: "webview:clear-console-capture",
  WEBVIEW_GET_CONSOLE_PROPERTIES: "webview:get-console-properties",
  WEBVIEW_RELOAD_IGNORING_CACHE: "webview:reload-ignoring-cache",
  WEBVIEW_GET_SCROLL_POSITION: "webview:get-scroll-position",
  WEBVIEW_CAPTURE_SCREENSHOT: "webview:capture-screenshot",
  WEBVIEW_CAPTURE_ELEMENT: "webview:capture-element",
  WEBVIEW_SET_DEVICE_EMULATION: "webview:set-device-emulation",
  WEBVIEW_CONSOLE_MESSAGE: "webview:console-message",
  WEBVIEW_CONSOLE_CONTEXT_CLEARED: "webview:console-context-cleared",
  WEBVIEW_GET_NAVIGATION_HISTORY: "webview:get-navigation-history",
  WEBVIEW_GO_TO_HISTORY_INDEX: "webview:go-to-history-index",

  SYSTEM_SLEEP_GET_METRICS: "system-sleep:get-metrics",
  SYSTEM_SLEEP_GET_AWAKE_TIME: "system-sleep:get-awake-time",
  SYSTEM_SLEEP_RESET: "system-sleep:reset",
  SYSTEM_SLEEP_ON_SUSPEND: "system-sleep:on-suspend",
  SYSTEM_SLEEP_ON_WAKE: "system-sleep:on-wake",

  // OS Do-Not-Disturb / Focus state. Read-only push channel for the renderer;
  // never used to suppress in-app toasts (the OS already silences its native
  // banners — double-gating would hide signals the user cannot observe).
  OS_DND_GET_STATE: "os-dnd:get-state",
  OS_DND_STATE_CHANGED: "os-dnd:state-changed",

  KEYBINDING_GET_OVERRIDES: "keybinding:get-overrides",
  KEYBINDING_SET_OVERRIDE: "keybinding:set-override",
  KEYBINDING_REMOVE_OVERRIDE: "keybinding:remove-override",
  KEYBINDING_RESET_ALL: "keybinding:reset-all",
  KEYBINDING_EXPORT_PROFILE: "keybinding:export-profile",
  KEYBINDING_IMPORT_PROFILE: "keybinding:import-profile",
  KEYBINDING_OVERRIDES_CHANGED: "keybinding:overrides-changed",

  CONFIG_BUNDLE_EXPORT: "config-bundle:export",
  CONFIG_BUNDLE_PREVIEW_IMPORT: "config-bundle:preview-import",
  CONFIG_BUNDLE_APPLY_IMPORT: "config-bundle:apply-import",
  WORKTREE_CONFIG_GET: "worktree-config:get",
  WORKTREE_CONFIG_SET_PATTERN: "worktree-config:set-pattern",
  WORKTREE_CONFIG_SET_WSL_GIT: "worktree-config:set-wsl-git",
  WORKTREE_CONFIG_DISMISS_WSL_BANNER: "worktree-config:dismiss-wsl-banner",
  WORKTREE_CONFIG_REPROBE_WSL: "worktree-config:reprobe-wsl",

  WINDOW_TOGGLE_FULLSCREEN: "window:toggle-fullscreen",
  WINDOW_RELOAD: "window:reload",
  WINDOW_FORCE_RELOAD: "window:force-reload",
  WINDOW_TOGGLE_DEVTOOLS: "window:toggle-devtools",
  WINDOW_ZOOM_IN: "window:zoom-in",
  WINDOW_ZOOM_OUT: "window:zoom-out",
  WINDOW_ZOOM_RESET: "window:zoom-reset",
  WINDOW_CLOSE: "window:close",
  WINDOW_NEW: "window:new",

  SOUND_TRIGGER: "sound:trigger",
  SOUND_GET_DIR: "sound:get-dir",

  NOTIFICATION_UPDATE: "notification:update",
  NOTIFICATION_SETTINGS_GET: "notification:settings-get",
  NOTIFICATION_SETTINGS_SET: "notification:settings-set",
  NOTIFICATION_PLAY_SOUND: "notification:play-sound",
  NOTIFICATION_SHOW_WATCH: "notification:show-watch",
  NOTIFICATION_SHOW_NATIVE: "notification:show-native",
  NOTIFICATION_WATCH_NAVIGATE: "notification:watch-navigate",
  NOTIFICATION_SYNC_WATCHED: "notification:sync-watched",
  NOTIFICATION_WAITING_ACKNOWLEDGE: "notification:waiting-acknowledge",
  NOTIFICATION_WORKING_PULSE_ACKNOWLEDGE: "notification:working-pulse-acknowledge",
  NOTIFICATION_SHOW_TOAST: "notification:show-toast",
  NOTIFICATION_SESSION_MUTE_SET: "notification:session-mute-set",

  SOUND_PLAY_UI_EVENT: "sound:play-ui-event",

  // Auto-update channels
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  UPDATE_DOWNLOADED: "update:downloaded",
  UPDATE_QUIT_AND_INSTALL: "update:quit-and-install",
  UPDATE_CHECK_FOR_UPDATES: "update:check-for-updates",
  UPDATE_GET_CHANNEL: "update:get-channel",
  UPDATE_SET_CHANNEL: "update:set-channel",
  UPDATE_DISMISS_TOAST: "update:dismiss-toast",
  UPDATE_GET_LAST_CHECK: "update:get-last-check",
  UPDATE_GET_LATEST: "update:get-latest",

  // Windows Store update notification channels (separate from electron-updater
  // because Store builds can't auto-install — these power a notify-only path
  // that polls the existing CDN feeds and deep-links to the Microsoft Store).
  STORE_UPDATE_AVAILABLE: "store-update:available",
  STORE_UPDATE_GET_LATEST: "store-update:get-latest",
  STORE_UPDATE_DISMISS: "store-update:dismiss",
  STORE_UPDATE_GET_SETTINGS: "store-update:get-settings",
  STORE_UPDATE_SET_SETTINGS: "store-update:set-settings",

  SLASH_COMMANDS_LIST: "slash-commands:list",

  GEMINI_GET_STATUS: "gemini:get-status",
  GEMINI_ENABLE_ALTERNATE_BUFFER: "gemini:enable-alternate-buffer",

  CODEX_LIST_SUBAGENTS: "codex:list-subagents",
  CODEX_READ_SUBAGENT_TRANSCRIPT: "codex:read-subagent-transcript",
  CODEX_RESOLVE_RESUME_LATEST_SESSION: "codex:resolve-resume-latest-session",
  CODEX_FIND_SESSIONS: "codex:find-sessions",
  CODEX_MATCH_RESTORE_SESSIONS: "codex:match-restore-sessions",
  CODEX_READ_QUOTA: "codex:read-quota",
  CODEX_REFRESH_QUOTA: "codex:refresh-quota",

  CLAUDE_LIST_SUBAGENTS: "claude:list-subagents",
  CLAUDE_READ_SUBAGENT_TRANSCRIPT: "claude:read-subagent-transcript",
  CLAUDE_FIND_REPLY_SPAN: "claude:find-reply-span",

  DEV_PREVIEW_ENSURE: "dev-preview:ensure",
  DEV_PREVIEW_RESTART: "dev-preview:restart",
  DEV_PREVIEW_RESTART_AND_CLEAR_CACHE: "dev-preview:restart-and-clear-cache",
  DEV_PREVIEW_REINSTALL_AND_RESTART: "dev-preview:reinstall-and-restart",
  DEV_PREVIEW_STOP: "dev-preview:stop",
  DEV_PREVIEW_STOP_BY_PANEL: "dev-preview:stop-by-panel",
  DEV_PREVIEW_GET_STATE: "dev-preview:get-state",
  DEV_PREVIEW_GET_BY_WORKTREE: "dev-preview:get-by-worktree",
  DEV_PREVIEW_GET_ALL_SESSIONS: "dev-preview:get-all-sessions",
  DEV_PREVIEW_GET_DIAGNOSTICS: "dev-preview:get-diagnostics",
  DEV_PREVIEW_GET_DESTRUCTIVE_PREVIEW_META: "dev-preview:get-destructive-preview-meta",
  DEV_PREVIEW_GET_DESTRUCTIVE_PREVIEW_SIZES: "dev-preview:get-destructive-preview-sizes",
  DEV_PREVIEW_STOP_BY_WORKTREE: "dev-preview:stop-by-worktree",
  DEV_PREVIEW_RESTART_BY_WORKTREE: "dev-preview:restart-by-worktree",
  DEV_PREVIEW_STOP_DEV_SERVER_BY_WORKTREE: "dev-preview:stop-dev-server-by-worktree",
  DEV_PREVIEW_GET_PROXY_PORT: "dev-preview:get-proxy-port",
  DEV_PREVIEW_MINT_BROWSER_TOKEN: "dev-preview:mint-browser-token",
  DEV_PREVIEW_STATE_CHANGED: "dev-preview:state-changed",
  DEV_PREVIEW_ALL_SESSIONS_CHANGED: "dev-preview:all-sessions-changed",

  // Site-preview bridge — the lifecycle commands for an Element Picker binding
  // on a dev-preview guest. There is deliberately no "evaluate in guest"
  // channel; see handlers/sitePreview.ts.
  SITE_PREVIEW_DETACH: "site-preview:detach",
  SITE_PREVIEW_SET_MODE: "site-preview:set-mode",
  SITE_PREVIEW_CLEAR_SELECTION: "site-preview:clear-selection",
  SITE_PREVIEW_CLEAR_HOVER: "site-preview:clear-hover",

  // Core Element Picker — the dev preview's own picker. Binding and the page's
  // traffic stay on the machine showing the preview; the source workspace and
  // what is read through it run where the worktree is. See handlers/elementPicker.ts.
  ELEMENT_PICKER_BIND: "element-picker:bind",
  ELEMENT_PICKER_RESELECT: "element-picker:reselect",
  ELEMENT_PICKER_WORKSPACE_OPEN: "element-picker:workspace-open",
  ELEMENT_PICKER_WORKSPACE_CLOSE: "element-picker:workspace-close",
  ELEMENT_PICKER_RESOLVE: "element-picker:resolve",
  ELEMENT_PICKER_DESCRIBE_PROJECT: "element-picker:describe-project",
  ELEMENT_PICKER_SOURCE_REVISIONS: "element-picker:source-revisions",
  ELEMENT_PICKER_HOLD_SOURCES: "element-picker:hold-sources",
  ELEMENT_PICKER_EVENT: "element-picker:event",
  ELEMENT_PICKER_SOURCE_CHANGED: "element-picker:source-changed",

  APP_AGENT_GET_CONFIG: "app-agent:get-config",
  APP_AGENT_SET_CONFIG: "app-agent:set-config",
  APP_AGENT_HAS_API_KEY: "app-agent:has-api-key",
  APP_AGENT_TEST_API_KEY: "app-agent:test-api-key",
  APP_AGENT_TEST_MODEL: "app-agent:test-model",
  APP_AGENT_DISPATCH_ACTION_RESPONSE: "app-agent:dispatch-action-response",
  APP_AGENT_CONFIRMATION_RESPONSE: "app-agent:confirmation-response",

  // Agent Capabilities channels
  AGENT_CAPABILITIES_GET_REGISTRY: "agent-capabilities:get-registry",
  AGENT_CAPABILITIES_GET_AGENT_IDS: "agent-capabilities:get-agent-ids",
  AGENT_CAPABILITIES_GET_AGENT_METADATA: "agent-capabilities:get-agent-metadata",
  AGENT_CAPABILITIES_IS_AGENT_ENABLED: "agent-capabilities:is-agent-enabled",

  // Daintree CLI install channels
  CLI_INSTALL: "cli:install",
  CLI_GET_STATUS: "cli:get-status",

  // Help workspace channels
  HELP_GET_FOLDER_PATH: "help:get-folder-path",
  HELP_OPEN_ASSISTANT_CONTENT_FOLDER: "help:open-assistant-content-folder",
  HELP_MARK_TERMINAL: "help:mark-terminal",
  HELP_UNMARK_TERMINAL: "help:unmark-terminal",
  HELP_PROVISION_SESSION: "help:provision-session",
  HELP_REVOKE_SESSION: "help:revoke-session",
  HELP_PEEK_PENDING_HIBERNATION: "help:peek-pending-hibernation",
  HELP_TAKE_PENDING_HIBERNATION: "help:take-pending-hibernation",
  HELP_RESTORE_PENDING_HIBERNATION: "help:restore-pending-hibernation",
  HELP_LIST_PENDING_HIBERNATION_SLOTS: "help:list-pending-hibernation-slots",
  HELP_ADOPT_DETACHED_SESSION: "help:adopt-detached-session",
  HELP_DISCARD_CONVERSATION: "help:discard-conversation",
  HELP_LIST_PAST_SESSIONS: "help:list-past-sessions",
  HELP_GET_STARTER_PROMPTS: "help:get-starter-prompts",
  HELP_REPORT_PANEL_OPEN: "help:report-panel-open",
  HELP_GET_PINNED_ACTION_CONTEXT: "help:get-pinned-action-context",
  HELP_GLOBAL_ASSISTANT_ENSURE: "help:global-assistant-ensure",
  HELP_GLOBAL_ASSISTANT_STATE: "help:global-assistant-state",
  HELP_GLOBAL_ASSISTANT_ATTACH: "help:global-assistant-attach",
  HELP_GLOBAL_ASSISTANT_DETACH: "help:global-assistant-detach",
  HELP_GLOBAL_ASSISTANT_CLAIM_INPUT: "help:global-assistant-claim-input",
  HELP_GLOBAL_ASSISTANT_RELEASE_INPUT: "help:global-assistant-release-input",
  HELP_GLOBAL_ASSISTANT_RESTART: "help:global-assistant-restart",
  HELP_GLOBAL_ASSISTANT_DISCARD: "help:global-assistant-discard",
  HELP_GLOBAL_ASSISTANT_CHANGED: "help:global-assistant-changed",

  CLIPBOARD_SAVE_IMAGE: "clipboard:save-image",
  CLIPBOARD_THUMBNAIL_FROM_PATH: "clipboard:thumbnail-from-path",
  CLIPBOARD_WRITE_IMAGE: "clipboard:write-image",
  CLIPBOARD_WRITE_TEXT: "clipboard:write-text",
  CLIPBOARD_WRITE_SELECTION: "clipboard:write-selection",
  CLIPBOARD_READ_SELECTION: "clipboard:read-selection",
  CLIPBOARD_PICK_ATTACHMENTS: "clipboard:pick-attachments",

  APP_THEME_GET: "app-theme:get",
  APP_THEME_SET_COLOR_SCHEME: "app-theme:set-color-scheme",
  APP_THEME_SET_CUSTOM_SCHEMES: "app-theme:set-custom-schemes",
  APP_THEME_IMPORT: "app-theme:import",
  APP_THEME_EXPORT: "app-theme:export",
  APP_THEME_SET_COLOR_VISION_MODE: "app-theme:set-color-vision-mode",
  APP_THEME_SET_FOLLOW_SYSTEM: "app-theme:set-follow-system",
  APP_THEME_SET_PREFERRED_DARK_SCHEME: "app-theme:set-preferred-dark-scheme",
  APP_THEME_SET_PREFERRED_LIGHT_SCHEME: "app-theme:set-preferred-light-scheme",
  APP_THEME_SET_RECENT_SCHEME_IDS: "app-theme:set-recent-scheme-ids",
  APP_THEME_SET_ACCENT_COLOR_OVERRIDE: "app-theme:set-accent-color-override",
  APP_THEME_SYSTEM_APPEARANCE_CHANGED: "app-theme:system-appearance-changed",

  WINDOW_CHROME_SET_BANNER_SEVERITY: "window-chrome:set-banner-severity",

  TELEMETRY_GET: "telemetry:get",
  TELEMETRY_SET_ENABLED: "telemetry:set-enabled",
  TELEMETRY_MARK_PROMPT_SHOWN: "telemetry:mark-prompt-shown",
  TELEMETRY_TRACK: "telemetry:track",
  TELEMETRY_PREVIEW_GET_STATE: "telemetry:preview-get-state",
  TELEMETRY_PREVIEW_TOGGLE: "telemetry:preview-toggle",
  TELEMETRY_PREVIEW_SUBSCRIBE: "telemetry:preview-subscribe",
  TELEMETRY_PREVIEW_UNSUBSCRIBE: "telemetry:preview-unsubscribe",
  TELEMETRY_PREVIEW_EVENT_BATCH: "telemetry:preview-event-batch",
  TELEMETRY_PREVIEW_STATE_CHANGED: "telemetry:preview-state-changed",

  // Privacy & Data channels
  PRIVACY_GET_SETTINGS: "privacy:get-settings",
  PRIVACY_SET_TELEMETRY_LEVEL: "privacy:set-telemetry-level",
  PRIVACY_SET_LOG_RETENTION: "privacy:set-log-retention",
  PRIVACY_OPEN_DATA_FOLDER: "privacy:open-data-folder",
  PRIVACY_CLEAR_CACHE: "privacy:clear-cache",
  PRIVACY_RESET_ALL_DATA: "privacy:reset-all-data",
  PRIVACY_GET_DATA_FOLDER_PATH: "privacy:get-data-folder-path",
  PRIVACY_TELEMETRY_CONSENT_CHANGED: "privacy:telemetry-consent-changed",

  // Sentry channels
  SENTRY_GET_CONSENT_STATE: "sentry:get-consent-state",

  // MCP Server channels
  MCP_SERVER_GET_STATUS: "mcp-server:get-status",
  MCP_SERVER_SET_ENABLED: "mcp-server:set-enabled",
  MCP_SERVER_SET_PORT: "mcp-server:set-port",
  MCP_SERVER_ROTATE_API_KEY: "mcp-server:rotate-api-key",
  MCP_SERVER_GET_CONFIG_SNIPPET: "mcp-server:get-config-snippet",
  /**
   * Snapshot the externally-connected MCP clients (api-key / unauthenticated
   * loopback sessions, excluding renderer-pinned help-assistant bearers) so
   * the disable-confirmation can name who's about to be severed (#8779).
   */
  MCP_SERVER_LIST_ACTIVE_CLIENTS: "mcp-server:list-active-clients",
  MCP_SERVER_GET_AUDIT_RECORDS: "mcp-server:get-audit-records",
  /**
   * Sibling of `MCP_SERVER_GET_AUDIT_RECORDS` that returns the full
   * `McpLogRecord` union (dispatch + grant lifecycle). Used by the
   * audit-log viewer and the NDJSON export. Dispatch-only consumers
   * (latency table, recent-calls popover, activity strip) keep using
   * the dispatch channel so their `result`/`durationMs` reads stay
   * type-safe — see #10027.
   */
  MCP_SERVER_GET_LOG_RECORDS: "mcp-server:get-log-records",
  MCP_SERVER_CLEAR_AUDIT_LOG: "mcp-server:clear-audit-log",
  MCP_SERVER_SET_AUDIT_ENABLED: "mcp-server:set-audit-enabled",
  MCP_SERVER_SET_AUDIT_MAX_RECORDS: "mcp-server:set-audit-max-records",
  MCP_SERVER_GET_AUDIT_CONFIG: "mcp-server:get-audit-config",
  /**
   * Read the session-scoped audit health counters (currently the
   * since-launch 401 counter). Distinct from `MCP_SERVER_GET_AUDIT_RECORDS`
   * because pre-dispatch auth failures never reach the record ring buffer.
   */
  MCP_SERVER_GET_AUDIT_STATS: "mcp-server:get-audit-stats",
  /** Export filtered audit records as scrubbed NDJSON via OS save dialog. */
  MCP_SERVER_EXPORT_AUDIT_LOG: "mcp-server:export-audit-log",
  /** Read the turn-outcome record ring buffer (newest first). */
  MCP_SERVER_GET_TURN_OUTCOME_RECORDS: "mcp-server:get-turn-outcome-records",
  /** Clear all turn-outcome records from the ring buffer and persistence. */
  MCP_SERVER_CLEAR_TURN_OUTCOME_LOG: "mcp-server:clear-turn-outcome-log",
  /**
   * Mount-time hydration of the runtime-state snapshot. Distinct from
   * `MCP_SERVER_GET_STATUS` (which exposes config — enabled/port/apiKey)
   * because the renderer needs the derived `disabled|starting|ready|failed`
   * state plus `lastError` to drive the dock-button readiness pip.
   */
  MCP_SERVER_GET_RUNTIME_STATE: "mcp-server:get-runtime-state",
  /** Push channel for runtime-state transitions. */
  MCP_SERVER_RUNTIME_STATE_CHANGED: "mcp-server:runtime-state-changed",
  /** Bridge: main process requests the action manifest from the renderer. */
  MCP_SERVER_GET_MANIFEST_REQUEST: "mcp:get-manifest-request",
  /** Bridge: renderer returns the action manifest to the main process. */
  MCP_SERVER_GET_MANIFEST_RESPONSE: "mcp:get-manifest-response",
  /** Bridge: main process dispatches an action request to the renderer. */
  MCP_SERVER_DISPATCH_ACTION_REQUEST: "mcp:dispatch-action-request",
  /** Bridge: renderer returns the action dispatch result to the main process. */
  MCP_SERVER_DISPATCH_ACTION_RESPONSE: "mcp:dispatch-action-response",
  /**
   * Push channel: a tool call from a help-session was denied because the
   * session tier doesn't permit it. Targeted at the pinned WebContents — the
   * renderer surfaces this in the assistant panel as an inline approval banner.
   */
  MCP_TIER_NOT_PERMITTED: "mcp-server:tier-not-permitted",
  /**
   * Push channel: a session was revoked by the abuse policy after exceeding
   * the denial threshold. Targeted at the pinned WebContents — the renderer
   * surfaces this as a notification so the user understands why the session
   * ended and can re-authorise.
   */
  MCP_SESSION_REVOKED: "mcp-server:session-revoked",
  /**
   * Elevate the tier of an active help-session (Always allow). Mutates
   * `sessionTierMap` in-place — never downgrades, so a malicious renderer
   * cannot drop its own privileges. The per-tool "Approve once" flow now
   * uses {@link MCP_SERVER_ISSUE_GRANT} instead — this channel is reserved
   * for the standing-permission path that pairs with a project-level
   * `daintreeMcpTier` write (#8442).
   */
  MCP_SERVER_SET_SESSION_TIER: "mcp-server:set-session-tier",
  /**
   * Mint a per-`(sessionId, toolId)` time-bounded grant for the named tool
   * (Approve once). The main process owns the TTL constant. Caller-pin
   * checked: only the renderer that minted the help-session can issue
   * grants on its behalf.
   */
  MCP_SERVER_ISSUE_GRANT: "mcp-server:issue-grant",
  /**
   * Revoke one per-`(sessionId, toolId)` grant, leaving the session's other
   * grants alone. Idempotent. Caller-pin checked.
   */
  MCP_SERVER_REVOKE_GRANT: "mcp-server:revoke-grant",
  /**
   * Approve a native session-scoped automation grant (#10648), addressed by
   * the public help-session id. Authorizes a bounded set of tools for a
   * bounded number of uses without a per-call modal. Caller-pin checked.
   */
  MCP_SERVER_ISSUE_NATIVE_GRANT: "mcp-server:issue-native-grant",
  /**
   * Revoke a single native automation grant by id. Idempotent. Caller-pin
   * checked against the session the grant belongs to.
   */
  MCP_SERVER_REVOKE_NATIVE_GRANT: "mcp-server:revoke-native-grant",
  /**
   * Reset the per-`(sessionId, toolId)` denial counters for a session without
   * touching its grants. Fired when the user dismisses the tier-mismatch
   * banner so the next out-of-tier call re-arms the banner instead of being
   * silently suppressed by the abuse policy. Caller-pin checked.
   */
  MCP_SERVER_RESET_DENIAL_COUNTS: "mcp-server:reset-denial-counts",
  /**
   * List the external bearers currently connected to the local MCP server.
   * Returns only the display suffix and token hash — never the raw token.
   * Backs the "External clients" row on the MCP Server settings tab (#8778).
   */
  MCP_SERVER_LIST_ACTIVE_BEARERS: "mcp-server:list-active-bearers",
  /**
   * Read-only inventory of the renderer-pinned help-session bearers (the
   * Daintree Assistant's own internal MCP connections). Backs the separate
   * "Daintree Assistant connections" row on the MCP Server settings tab,
   * which has no disconnect control (#10036).
   */
  MCP_SERVER_LIST_HELP_SESSION_BEARERS: "mcp-server:list-help-session-bearers",
  /**
   * Disconnect a single external bearer by its token hash: revoke every
   * session it owns and evict it from the live register. One bearer only —
   * key rotation (revoke-all) stays a separate action (#8778).
   */
  MCP_SERVER_DISCONNECT_BEARER: "mcp-server:disconnect-bearer",
  /** One pane's pending terminal notices, for its chrome to hydrate on mount. */
  MCP_SERVER_GET_PANE_NOTIFY_STATE: "mcp-server:get-pane-notify-state",
  /** The pane chrome's "stop": every notice the pane has pending goes. */
  MCP_SERVER_STOP_PANE_NOTICES: "mcp-server:stop-pane-notices",
  MCP_SERVER_HOLD_DISPATCH: "mcp-server:hold-dispatch",
  /**
   * Hand a running terminal to an orchestrating agent pane, or take it back
   * (#12490). Renderer-only by construction: no action or MCP tool reaches
   * these, so a hand-over always starts with the user.
   */
  MCP_SERVER_ADOPT_TERMINAL: "mcp-server:adopt-terminal",
  MCP_SERVER_RELEASE_TERMINAL_ADOPTION: "mcp-server:release-terminal-adoption",
  MCP_SERVER_LIST_TERMINAL_ADOPTIONS: "mcp-server:list-terminal-adoptions",
  /** Panes holding a live Daintree bearer, which a terminal can be handed to (#12490). */
  MCP_SERVER_LIST_ORCHESTRATOR_PANES: "mcp-server:list-orchestrator-panes",
  /**
   * Push channel: a grant lifecycle event (`issued`, `expired`, `revoked`)
   * fired for the help-session pinned to this renderer. Targeted send —
   * grant state is session-scoped and never broadcast.
   */
  MCP_GRANT_LIFECYCLE: "mcp-server:grant-lifecycle",
  /**
   * Push channel: an MCP tool dispatch entered the call path for the
   * help-session pinned to this renderer. Drives the Assistant panel's live
   * activity strip (#9759). Targeted send — never broadcast.
   */
  MCP_TOOL_CALL_STARTED: "mcp-server:tool-call-started",
  /**
   * Push channel: an MCP tool dispatch announced via `MCP_TOOL_CALL_STARTED`
   * settled. Carries the audit-aligned outcome (duration, result, severity)
   * so the activity strip can dim to a glyph. Targeted send — never broadcast.
   */
  MCP_TOOL_CALL_SETTLED: "mcp-server:tool-call-settled",
  /**
   * Push channel: the assistant invoked the `help.displayImage` MCP tool
   * (#9828). Carries the validated daintree.org image URL plus the
   * session-assigned figure number so the Assistant panel can render the
   * figure inline. Targeted at the pinned WebContents — never broadcast.
   */
  MCP_HELP_DISPLAY_IMAGE: "mcp-server:help-display-image",
  /**
   * Push channel: a turn for the help-session pinned to this renderer
   * classified as `agent-stuck` or `reasoning-loop` (#10018). Drives the
   * Assistant footer's ambient outcome pip — a Tier 1 indicator, never a
   * toast. Targeted at the pinned WebContents — never broadcast.
   */
  MCP_TURN_OUTCOME_ALERT: "mcp-server:turn-outcome-alert",

  // Voice Input channels
  VOICE_INPUT_GET_SETTINGS: "voice-input:get-settings",
  VOICE_INPUT_GET_LAST_TERMS: "voice-input:get-last-terms",
  VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
  VOICE_INPUT_START: "voice-input:start",
  VOICE_INPUT_STOP: "voice-input:stop",
  VOICE_INPUT_CANCEL: "voice-input:cancel",
  VOICE_INPUT_AUDIO_CHUNK: "voice-input:audio-chunk",
  VOICE_INPUT_TRANSCRIPTION_DELTA: "voice-input:transcription-delta",
  VOICE_INPUT_TRANSCRIPTION_COMPLETE: "voice-input:transcription-complete",
  VOICE_INPUT_ERROR: "voice-input:error",
  VOICE_INPUT_STATUS: "voice-input:status",
  VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
  VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
  VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
  VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
  VOICE_INPUT_CORRECT: "voice-input:correct",
  VOICE_INPUT_CORRECTION_PROGRESS: "voice-input:correction-progress",
  VOICE_INPUT_PREFETCH_CORRECTIONS: "voice-input:prefetch-corrections",
  VOICE_INPUT_REWRITE: "voice-input:rewrite",
  VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
  VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
  VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",
  VOICE_INPUT_SESSION_ENDED: "voice-input:session-ended",
  VOICE_INPUT_IS_APP_REPLACED: "voice-input:is-app-replaced",
  VOICE_INPUT_RESTART_REPLACED_APP: "voice-input:restart-replaced-app",
  VOICE_DICTIONARY_ADD: "voice-dictionary:add",
  VOICE_DICTIONARY_REMOVE: "voice-dictionary:remove",
  VOICE_DICTIONARY_UPDATE: "voice-dictionary:update",
  VOICE_DICTIONARY_ACCEPT_SUGGESTION: "voice-dictionary:accept-suggestion",
  VOICE_DICTIONARY_DISMISS_SUGGESTION: "voice-dictionary:dismiss-suggestion",
  VOICE_DICTIONARY_RECORD_SUGGESTIONS: "voice-dictionary:record-suggestions",
  VOICE_DICTIONARY_GET_PROJECT: "voice-dictionary:get-project",
  VOICE_DICTIONARY_ADD_TO_PROJECT: "voice-dictionary:add-to-project",
  VOICE_DICTIONARY_REMOVE_FROM_PROJECT: "voice-dictionary:remove-from-project",
  VOICE_DICTIONARY_UPDATE_IN_PROJECT: "voice-dictionary:update-in-project",
  VOICE_INPUT_GET_LIVE_SESSION: "voice-input:get-live-session",
  VOICE_INPUT_LIVE_SESSION: "voice-input:live-session",
  VOICE_INPUT_STOP_LIVE: "voice-input:stop-live",
  VOICE_INPUT_STOP_REQUESTED: "voice-input:stop-requested",
  VOICE_INPUT_REVEAL_LIVE: "voice-input:reveal-live",
  VOICE_INPUT_REVEAL_REQUESTED: "voice-input:reveal-requested",
  VOICE_INPUT_PUBLISH_DETAILS: "voice-input:publish-details",
  VOICE_INPUT_LIVE_LEVEL: "voice-input:live-level",
  VOICE_INPUT_SET_PAUSED_LIVE: "voice-input:set-paused-live",
  VOICE_INPUT_PAUSE_REQUESTED: "voice-input:pause-requested",
  RECENT_DICTATIONS_RECORD: "recent-dictations:record",
  RECENT_DICTATIONS_SET_CORRECTED_TEXT: "recent-dictations:set-corrected-text",
  RECENT_DICTATIONS_LIST: "recent-dictations:list",
  RECENT_DICTATIONS_CHANGED: "recent-dictations:changed",

  // Help assistant settings channels
  HELP_ASSISTANT_GET_SETTINGS: "help-assistant:get-settings",
  HELP_ASSISTANT_SET_SETTINGS: "help-assistant:set-settings",
  HELP_ASSISTANT_GET_LIVE_SESSION_STATUS: "help-assistant:get-live-session-status",

  // Onboarding channels
  ONBOARDING_GET: "onboarding:get",
  ONBOARDING_SET_STEP: "onboarding:set-step",
  ONBOARDING_COMPLETE: "onboarding:complete",
  ONBOARDING_MARK_TOAST_SEEN: "onboarding:mark-toast-seen",
  ONBOARDING_MARK_NEWSLETTER_SEEN: "onboarding:mark-newsletter-seen",
  ONBOARDING_MARK_WAITING_NUDGE_SEEN: "onboarding:mark-waiting-nudge-seen",
  ONBOARDING_MARK_AGENTS_SEEN: "onboarding:mark-agents-seen",
  ONBOARDING_RECORD_AGENT_FIRST_SEEN: "onboarding:record-agent-first-seen",
  ONBOARDING_DISMISS_WELCOME_CARD: "onboarding:dismiss-welcome-card",
  ONBOARDING_DISMISS_SETUP_BANNER: "onboarding:dismiss-setup-banner",
  ONBOARDING_CHECKLIST_GET: "onboarding:checklist-get",
  ONBOARDING_CHECKLIST_DISMISS: "onboarding:checklist-dismiss",
  ONBOARDING_CHECKLIST_MARK_ITEM: "onboarding:checklist-mark-item",
  ONBOARDING_CHECKLIST_PUSH: "onboarding:checklist-push",
  ONBOARDING_TOUR_DISMISS_INVITE: "onboarding:tour-dismiss-invite",
  ONBOARDING_TOUR_SET_PROGRESS: "onboarding:tour-set-progress",
  ONBOARDING_TOUR_SET_MUTED: "onboarding:tour-set-muted",

  // Shortcut Hints channels
  SHORTCUT_HINTS_GET_COUNTS: "shortcut-hints:get-counts",
  SHORTCUT_HINTS_INCREMENT_COUNT: "shortcut-hints:increment-count",
  SHORTCUT_HINTS_GET_HINTED_HOVER: "shortcut-hints:get-hinted-hover",
  SHORTCUT_HINTS_SET_HINTED_HOVER: "shortcut-hints:set-hinted-hover",

  // Forge recommendation channels
  FORGE_RECOMMENDATION_GET_DISMISSED: "forge-recommendation:get-dismissed",
  FORGE_RECOMMENDATION_MARK_DISMISSED: "forge-recommendation:mark-dismissed",

  // GPU channels
  GPU_GET_STATUS: "gpu:get-status",
  GPU_SET_HARDWARE_ACCELERATION: "gpu:set-hardware-acceleration",

  // Crash Recovery channels
  CRASH_RECOVERY_GET_PENDING: "crash-recovery:get-pending",
  CRASH_RECOVERY_RESOLVE: "crash-recovery:resolve",
  CRASH_RECOVERY_GET_CONFIG: "crash-recovery:get-config",
  CRASH_RECOVERY_SET_CONFIG: "crash-recovery:set-config",

  // Renderer Recovery channels (in-session crash recovery)
  RECOVERY_RELOAD_APP: "recovery:reload-app",
  RECOVERY_RESET_AND_RELOAD: "recovery:reset-and-reload",
  RECOVERY_EXPORT_DIAGNOSTICS: "recovery:export-diagnostics",
  RECOVERY_OPEN_LOGS: "recovery:open-logs",

  // Demo mode channels (dev-only)
  DEMO_MOVE_TO: "demo:move-to",
  DEMO_MOVE_TO_SELECTOR: "demo:move-to-selector",
  DEMO_CLICK: "demo:click",
  DEMO_TYPE: "demo:type",
  DEMO_SCREENSHOT: "demo:screenshot",
  DEMO_WAIT_FOR_SELECTOR: "demo:wait-for-selector",
  DEMO_PAUSE: "demo:pause",
  DEMO_RESUME: "demo:resume",
  DEMO_EXEC_MOVE_TO: "demo:exec-move-to",
  DEMO_EXEC_MOVE_TO_SELECTOR: "demo:exec-move-to-selector",
  DEMO_EXEC_CLICK: "demo:exec-click",
  DEMO_EXEC_TYPE: "demo:exec-type",
  DEMO_EXEC_PAUSE: "demo:exec-pause",
  DEMO_EXEC_RESUME: "demo:exec-resume",
  DEMO_EXEC_WAIT_FOR_SELECTOR: "demo:exec-wait-for-selector",
  DEMO_SLEEP: "demo:sleep",
  DEMO_EXEC_SLEEP: "demo:exec-sleep",
  DEMO_COMMAND_DONE: "demo:command-done",
  DEMO_START_CAPTURE: "demo:start-capture",
  DEMO_STOP_CAPTURE: "demo:stop-capture",
  DEMO_GET_CAPTURE_STATUS: "demo:get-capture-status",
  DEMO_SCROLL: "demo:scroll",
  DEMO_EXEC_SCROLL: "demo:exec-scroll",
  DEMO_DRAG: "demo:drag",
  DEMO_EXEC_DRAG: "demo:exec-drag",
  DEMO_PRESS_KEY: "demo:press-key",
  DEMO_EXEC_PRESS_KEY: "demo:exec-press-key",
  DEMO_TYPE_IN_TERMINAL: "demo:type-in-terminal",
  DEMO_EXEC_TYPE_IN_TERMINAL: "demo:exec-type-in-terminal",
  DEMO_SEND_KEY_TO_TERMINAL: "demo:send-key-to-terminal",
  DEMO_EXEC_SEND_KEY_TO_TERMINAL: "demo:exec-send-key-to-terminal",
  DEMO_SPOTLIGHT: "demo:spotlight",
  DEMO_EXEC_SPOTLIGHT: "demo:exec-spotlight",
  DEMO_DISMISS_SPOTLIGHT: "demo:dismiss-spotlight",
  DEMO_EXEC_DISMISS_SPOTLIGHT: "demo:exec-dismiss-spotlight",
  DEMO_ANNOTATE: "demo:annotate",
  DEMO_EXEC_ANNOTATE: "demo:exec-annotate",
  DEMO_DISMISS_ANNOTATION: "demo:dismiss-annotation",
  DEMO_EXEC_DISMISS_ANNOTATION: "demo:exec-dismiss-annotation",
  DEMO_WAIT_FOR_IDLE: "demo:wait-for-idle",
  DEMO_EXEC_WAIT_FOR_IDLE: "demo:exec-wait-for-idle",
  DEMO_EXEC_START_CAPTURE: "demo:exec-start-capture",
  DEMO_EXEC_STOP_CAPTURE: "demo:exec-stop-capture",
  DEMO_CAPTURE_CHUNK: "demo:capture-chunk",
  DEMO_CAPTURE_STOP: "demo:capture-stop",

  // Forge integration channels
  FORGE_RATE_LIMIT_CHANGED: "forge:rate-limit-changed",
  FORGE_TOKEN_HEALTH_CHANGED: "forge:token-health-changed",
  FORGE_GET_SETTINGS: "forge:get-settings",
  FORGE_SET_DEFAULT_PROVIDER: "forge:set-default-provider",
  FORGE_GET_PROVIDERS: "forge:get-providers",
  FORGE_RESOLVE_PROVIDER: "forge:resolve-provider",
  FORGE_OPEN_ISSUES: "forge:open-issues",
  FORGE_OPEN_PRS: "forge:open-prs",
  FORGE_OPEN_COMMITS: "forge:open-commits",
  FORGE_OPEN_REPO: "forge:open-repo",
  FORGE_OPEN_ISSUE: "forge:open-issue",
  FORGE_GET_ISSUE_URL: "forge:get-issue-url",
  FORGE_GET_REPO_URL: "forge:get-repo-url",
  FORGE_ASSIGN_ISSUE: "forge:assign-issue",
  FORGE_UNASSIGN_ISSUE: "forge:unassign-issue",
  FORGE_APPROVE_PR: "forge:approve-pr",
  FORGE_REQUEST_CHANGES: "forge:request-changes",
  FORGE_DISMISS_REVIEW: "forge:dismiss-review",
  FORGE_REQUEST_REVIEWERS: "forge:request-reviewers",
  FORGE_CREATE_ISSUE: "forge:create-issue",
  FORGE_CLOSE_ISSUE: "forge:close-issue",
  FORGE_REOPEN_ISSUE: "forge:reopen-issue",
  FORGE_EDIT_ISSUE: "forge:edit-issue",
  FORGE_ADD_ISSUE_COMMENT: "forge:add-issue-comment",
  FORGE_ADD_ISSUE_LABEL: "forge:add-issue-label",
  FORGE_REMOVE_ISSUE_LABEL: "forge:remove-issue-label",
  FORGE_VALIDATE_TOKEN: "forge:validate-token",
  FORGE_SET_CREDENTIAL: "forge:set-credential",
  FORGE_GET_CREDENTIAL_STATUS: "forge:get-credential-status",
  FORGE_CLEAR_CREDENTIAL: "forge:clear-credential",
  FORGE_PREVIEW_CREDENTIAL_IMPORT: "forge:preview-credential-import",
  FORGE_COMMIT_CREDENTIAL_IMPORT: "forge:commit-credential-import",
  FORGE_LIST_ISSUES: "forge:list-issues",
  FORGE_LIST_PRS: "forge:list-prs",
  FORGE_GET_ISSUE: "forge:get-issue",
  FORGE_GET_PR: "forge:get-pr",
  FORGE_GET_CI_STATUS: "forge:get-ci-status",
  FORGE_GET_CHECKS: "forge:get-checks",
  FORGE_GET_REPO_METADATA: "forge:get-repo-metadata",
  FORGE_GET_CURRENT_USER: "forge:get-current-user",
  FORGE_CLASSIFY_PUSH_ERROR: "forge:classify-push-error",
  FORGE_GET_REPO_STATS: "forge:get-repo-stats",
  FORGE_GET_FIRST_PAGE_CACHE: "forge:get-first-page-cache",
  FORGE_GET_REPO_KEY: "forge:get-repo-key",
  FORGE_GET_PROJECT_HEALTH: "forge:get-project-health",
  FORGE_GET_ISSUE_TOOLTIP: "forge:get-issue-tooltip",
  FORGE_GET_PR_TOOLTIP: "forge:get-pr-tooltip",
  FORGE_GET_ISSUES_BY_NUMBERS: "forge:get-issues-by-numbers",
  FORGE_GET_PRS_BY_NUMBERS: "forge:get-prs-by-numbers",
  FORGE_GET_REFERENCES_BY_NUMBERS: "forge:get-references-by-numbers",
  FORGE_GET_PR_REVIEW_THREADS: "forge:get-pr-review-threads",
  FORGE_LIST_ISSUE_COMMENTS: "forge:list-issue-comments",
  FORGE_RESOLVE_AUTHOR_AVATAR: "forge:resolve-author-avatar",
  FORGE_GET_TOKEN_HEALTH: "forge:get-token-health",
  FORGE_GET_RATE_LIMIT_DETAILS: "forge:get-rate-limit-details",
  FORGE_OPEN_PR: "forge:open-pr",
  FORGE_CREATE_PR: "forge:create-pr",
  FORGE_CLOSE_PR: "forge:close-pr",
  FORGE_REOPEN_PR: "forge:reopen-pr",
  FORGE_MERGE_PR: "forge:merge-pr",
  FORGE_ENABLE_AUTO_MERGE: "forge:enable-auto-merge",
  FORGE_DISABLE_AUTO_MERGE: "forge:disable-auto-merge",
  FORGE_CONVERT_PR_TO_DRAFT: "forge:convert-pr-to-draft",
  FORGE_MARK_PR_READY_FOR_REVIEW: "forge:mark-pr-ready-for-review",
  FORGE_COMMENT_ON_PR: "forge:comment-on-pr",
  FORGE_EDIT_PR: "forge:edit-pr",
  FORGE_REPO_STATS_AND_PAGE_UPDATED: "forge:repo-stats-and-page-updated",
  FORGE_REPO_COUNTS_UPDATED: "forge:repo-counts-updated",

  // Forge audit log channels — separate prefix from `forge:*` so the codegen
  // produces a dedicated `forgeAudit` namespace in the renderer rather than
  // appending into the hand-written `forge` namespace.
  FORGE_AUDIT_GET_RECORDS: "forge-audit:get-records",
  FORGE_AUDIT_GET_CONFIG: "forge-audit:get-config",
  FORGE_AUDIT_GET_STATS: "forge-audit:get-stats",
  FORGE_AUDIT_CLEAR_LOG: "forge-audit:clear-log",
  FORGE_AUDIT_EXPORT_LOG: "forge-audit:export-log",
  FORGE_AUDIT_SET_ENABLED: "forge-audit:set-enabled",

  // Project groups and archive — user filing in the project switcher. Own
  // `project-groups:*` prefix so codegen produces a `projectGroups` namespace.
  PROJECT_GROUPS_LIST: "project-groups:list",
  PROJECT_GROUPS_CREATE: "project-groups:create",
  PROJECT_GROUPS_RENAME: "project-groups:rename",
  PROJECT_GROUPS_DELETE: "project-groups:delete",
  PROJECT_GROUPS_REORDER: "project-groups:reorder",
  PROJECT_GROUPS_SET_SORT_MODE: "project-groups:set-sort-mode",
  PROJECT_GROUPS_SET_MEMBERSHIP: "project-groups:set-membership",
  PROJECT_GROUPS_SET_ARCHIVED: "project-groups:set-archived",

  // Run history channels — durable recipe/fleet automation outcomes (#9949).
  // Dedicated `run-history:*` prefix so codegen produces a `runHistory`
  // renderer namespace.
  RUN_HISTORY_GET_RECORDS: "run-history:get-records",
  RUN_HISTORY_APPEND: "run-history:append",
  RUN_HISTORY_CLEAR: "run-history:clear",

  // Copy-tree run history (#11732). Read-only: the main process records a run
  // where it completes, so there is no append channel to forge entries through.
  COPY_TREE_HISTORY_GET_RECORDS: "copy-tree-history:get-records",

  // Scheduled-run history (#15976). Read-only: main registers runs and records
  // the facts on them.
  SCHEDULED_RUNS_LIST_BY_PROJECT: "scheduled-runs:list-by-project",
  SCHEDULED_RUNS_LIST_BY_SCHEDULE: "scheduled-runs:list-by-schedule",
  // Runs that settled with no window open, for a view's notification inbox (#15983).
  SCHEDULED_RUNS_TAKE_INBOX: "scheduled-runs:take-inbox",
  SCHEDULED_RUNS_ACK_INBOX: "scheduled-runs:ack-inbox",

  // Plugin channels
  PLUGIN_LIST: "plugin:list",
  PLUGIN_INSTALL: "plugin:install",
  PLUGIN_SET_ENABLED: "plugin:set-enabled",
  PLUGIN_INSTALL_FROM_FILE: "plugin:install-from-file",
  PLUGIN_INSTALL_FROM_PATH: "plugin:install-from-path",
  PLUGIN_INSTALL_FROM_URL: "plugin:install-from-url",
  PLUGIN_UNINSTALL: "plugin:uninstall",
  PLUGIN_CHECK_FOR_UPDATE: "plugin:check-for-update",
  PLUGIN_INVOKE: "plugin:invoke",
  PLUGIN_TOOLBAR_BUTTONS: "plugin:toolbar-buttons",
  PLUGIN_LAUNCH_ENTRIES: "plugin:launch-entries",
  PLUGIN_LAYOUTS: "plugin:layouts",
  PLUGIN_LAUNCH_GROUPS_HIDDEN_GET: "plugin:launch-groups-hidden-get",
  PLUGIN_LAUNCH_GROUP_HIDDEN_SET: "plugin:launch-group-hidden-set",
  PLUGIN_NOTIFICATION_SILENCES_GET: "plugin:notification-silences-get",
  PLUGIN_NOTIFICATION_SILENCE_SET: "plugin:notification-silence-set",
  PLUGIN_SEARCH_PROVIDERS_GET: "plugin:search-providers-get",
  PLUGIN_SEARCH_PROVIDERS_QUERY: "plugin:search-providers-query",
  PLUGIN_SEARCH_PROVIDERS_CANCEL: "plugin:search-providers-cancel",
  PLUGIN_SEARCH_PROVIDER_SHOWN_SET: "plugin:search-provider-shown-set",
  PLUGIN_CONTEXT_PROVIDERS_GET: "plugin:context-providers-get",
  PLUGIN_CONTEXT_PROVIDER_SEARCH: "plugin:context-provider-search",
  PLUGIN_CONTEXT_REFERENCES_RESOLVE: "plugin:context-references-resolve",
  PLUGIN_CONTEXT_PROVIDERS_ENABLED_SET: "plugin:context-providers-enabled-set",
  PLUGIN_KEYBINDINGS: "plugin:keybindings",
  PLUGIN_CONTEXT_MENU_ITEMS: "plugin:context-menu-items",
  PLUGIN_VALIDATE_ACTION_IDS: "plugin:validate-action-ids",
  PLUGIN_VALIDATE_MANIFEST: "plugin:validate-manifest",
  PLUGIN_ACTIONS_GET: "plugin:actions-get",
  PLUGIN_ACTIONS_REGISTER: "plugin:actions-register",
  PLUGIN_ACTIONS_UNREGISTER: "plugin:actions-unregister",
  PLUGIN_PANEL_KINDS_GET: "plugin:panel-kinds-get",
  /**
   * The SENDER project's slot state (§7.8): arbitrated claims, refusals and
   * the user's answers, with one revision. Never takes a project id from the
   * caller — a renderer asking for another project's slots is the leak project
   * scope exists to prevent.
   */
  PLUGIN_PROJECT_SURFACES_GET: "plugin:project-surfaces-get",
  PLUGIN_FILE_EDITOR_CHOICES_GET: "plugin:file-editor-choices-get",
  PLUGIN_FILE_EDITOR_CHOICE_SET: "plugin:file-editor-choice-set",
  /** Remember one slot answer for the SENDER's project, resolved against what is on offer. */
  PLUGIN_PROJECT_SURFACE_CHOICE_SET: "plugin:project-surface-choice-set",
  /** Remember an answer about several slots in one write, all or none, for the SENDER's project. */
  PLUGIN_PROJECT_SURFACE_CHOICES_SET: "plugin:project-surface-choices-set",
  /** The SENDER project's first-open layout seed (#13782). */
  PLUGIN_PROJECT_LAYOUT_SEED_GET: "plugin:project-layout-seed-get",
  /** Compare-and-set the SENDER project's layout seed, so only one view ever consumes it. */
  PLUGIN_PROJECT_LAYOUT_SEED_ADVANCE: "plugin:project-layout-seed-advance",
  /** The SENDER project's answer to its application's welcome tour (#14106). */
  PLUGIN_PROJECT_WELCOME_GET: "plugin:project-welcome-get",
  /** Record that the user skipped or finished the SENDER project's application welcome. */
  PLUGIN_PROJECT_WELCOME_SET: "plugin:project-welcome-set",
  /** Project-local plugins: the sender project's rows, valid and invalid alike. */
  PLUGIN_PROJECT_LIST: "plugin:project-list",
  /** Project-local plugins: record the trust decision for the SENDER's project. */
  PLUGIN_PROJECT_SET_TRUST: "plugin:project-set-trust",
  /** Project-local plugins: one-click activation of a staged plugin. */
  PLUGIN_PROJECT_ACTIVATE_STAGED: "plugin:project-activate-staged",
  /** Project-local plugins: manual re-scan of the sender project's plugins folder. */
  PLUGIN_PROJECT_RELOAD: "plugin:project-reload",
  /** Project-local plugins: switch one plugin off (or back on) on its own, without touching folder trust. */
  PLUGIN_PROJECT_SET_MUTED: "plugin:project-set-muted",
  /** Installed plugins: the sender project's per-project visibility overlay. */
  PLUGIN_PROJECT_VISIBILITY_GET: "plugin:project-visibility-get",
  /** Installed plugins: hide or show one installed plugin in the SENDER's project. */
  PLUGIN_PROJECT_VISIBILITY_SET: "plugin:project-visibility-set",
  /** Installed per-project packages: turn one on or off in the SENDER's project. */
  PLUGIN_PROJECT_INSTANCE_SET_ENABLED: "plugin:project-instance-set-enabled",
  /** Installed plugins: whether one plugin is hidden in projects that have not decided. */
  PLUGIN_VISIBILITY_DEFAULT_SET: "plugin:visibility-default-set",
  /** Lazy activation: force the plugin owning a contributed panel view to `activate()` before its module loads. */
  PLUGIN_ACTIVATE_FOR_VIEW: "plugin:activate-for-view",
  /** Renderer reports plugin panel lifecycle transitions (mounted/hidden/trashed/removed) for worker delivery. */
  PLUGIN_REPORT_PANEL_LIFECYCLE: "plugin:report-panel-lifecycle",
  /** Renderer reports its live non-plugin panel ids, so `host.reloadPanel` can refuse them (#12610). */
  PLUGIN_REPORT_PANEL_INVENTORY: "plugin:report-panel-inventory",
  /** Renderer reports which of its plugin panels say they hold unsaved work (#15031). */
  PLUGIN_REPORT_UNSAVED_PANELS: "plugin:report-unsaved-panels",
  /** A plugin's panels, in any view, that say they hold unsaved work (#15031). */
  PLUGIN_UNSAVED_PANELS_GET: "plugin:unsaved-panels-get",
  /** Renderer → main, fire-and-forget: batched plugin view cost observations. */
  PLUGIN_REPORT_VIEW_METRICS: "plugin:report-view-metrics",
  /** Renderer → main, fire-and-forget: the plugin push channels this renderer has subscribers for. */
  PLUGIN_REPORT_PUSH_LISTENERS: "plugin:report-push-listeners",
  /** Renderer → main, fire-and-forget: the kind of panel holding DOM focus in this view (#13221). */
  PLUGIN_REPORT_FOCUSED_PANEL: "plugin:report-focused-panel",
  /** The asking view's own project presence (#13813). */
  PLUGIN_PROJECT_PRESENCE_GET: "plugin:project-presence-get",
  /** Main → a project's renderers: that project's presence changed. */
  PLUGIN_PROJECT_PRESENCE_CHANGED: "plugin:project-presence-changed",
  /** Every tracked plugin's `PluginPerfSnapshot`. */
  PLUGIN_PERF_SNAPSHOTS_GET: "plugin:perf-snapshots-get",
  PLUGIN_CAPTURE_PANEL: "plugin:capture-panel",
  /** Renderer → main, fire-and-forget: start receiving `PLUGIN_PERF_SNAPSHOTS_CHANGED`. */
  PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE: "plugin:perf-snapshots-subscribe",
  PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE: "plugin:perf-snapshots-unsubscribe",
  /** Main → subscribed renderers, at most once a second: every tracked plugin's snapshot. */
  PLUGIN_PERF_SNAPSHOTS_CHANGED: "plugin:perf-snapshots-changed",
  /** Per-instance runtime health snapshot, for a renderer store hydrating after it subscribed. */
  PLUGIN_RUNTIME_STATUSES_GET: "plugin:runtime-statuses-get",
  /** Retire a plugin's backend generation and start a fresh one (panel recovery). */
  PLUGIN_RESTART_WORKER: "plugin:restart-worker",
  /** The user's Cancel on a plugin task (#13819). */
  PLUGIN_TASK_CANCEL: "plugin:task-cancel",
  /** The user's Dismiss on an interrupted plugin task (#13819). */
  PLUGIN_TASK_DISMISS: "plugin:task-dismiss",
  /** A plugin view importing files its person chose as artifacts (#14100). */
  PLUGIN_ARTIFACTS_IMPORT: "plugin:artifacts-import",
  /** A lease-bearing playback URL for one of a plugin's artifacts, for the calling view. */
  PLUGIN_ARTIFACT_SOURCE: "plugin:artifact-source",
  /** The view stopped playing a source: its lease ends. */
  PLUGIN_ARTIFACT_SOURCE_RELEASE: "plugin:artifact-source-release",
  PLUGIN_AGENTS_GET: "plugin:agents-get",
  PLUGIN_RECIPES_GET: "plugin:recipes-get",
  /** Plugin tours visible in the sender's project (#12773). */
  PLUGIN_TOURS_GET: "plugin:tours-get",
  PLUGIN_PROJECT_TEMPLATES_GET: "plugin:project-templates-get",
  PLUGIN_PROJECT_TEMPLATE_PREVIEW: "plugin:project-template-preview",
  /** Plugin views that mount outside the panel grid, visible in the sender's project (#13770). */
  PLUGIN_HOSTED_VIEWS_GET: "plugin:hosted-views-get",
  /** Every theme an installed plugin offers, app-wide (#13832). */
  PLUGIN_THEMES_GET: "plugin:themes-get",
  /** Plugin-shipped custom icons visible in the sender's project (#13143). */
  PLUGIN_ICONS_GET: "plugin:icons-get",
  /** Append one run timestamp to a plugin recipe's sidecar metadata (#11860). */
  PLUGIN_RECIPE_RECORD_USE: "plugin:recipe-record-use",
  /** Patch the user-owned half of a plugin recipe (empty-state pin, auto-assign). */
  PLUGIN_RECIPE_METADATA_UPDATE: "plugin:recipe-metadata-update",
  PLUGIN_FORGE_PROVIDERS_GET: "plugin:forge-providers-get",
  PLUGIN_FILE_DECORATIONS_GET: "plugin:file-decorations-get",
  /** The plugins a worktree delete confirmation asks for notes (#13805). */
  PLUGIN_WORKTREE_DELETE_NOTE_SOURCES_GET: "plugin:worktree-delete-note-sources-get",
  /** One plugin's notes for a worktree about to be deleted (#13805). */
  PLUGIN_WORKTREE_DELETE_NOTES_GET: "plugin:worktree-delete-notes-get",
  PLUGIN_WORKTREE_STATUS_GET: "plugin:worktree-status-get",
  PLUGIN_GET_AUDIT_RECORDS: "plugin:get-audit-records",
  PLUGIN_GET_AUDIT_CONFIG: "plugin:get-audit-config",
  PLUGIN_CLEAR_AUDIT_LOG: "plugin:clear-audit-log",
  PLUGIN_SET_AUDIT_ENABLED: "plugin:set-audit-enabled",
  PLUGIN_SET_AUDIT_MAX_RECORDS: "plugin:set-audit-max-records",
  PLUGIN_EXPORT_AUDIT_LOG: "plugin:export-audit-log",
  PLUGIN_GET_DIAGNOSTICS_SNAPSHOT: "plugin:get-diagnostics-snapshot",
  PLUGIN_SETTINGS_GET_VALUES: "plugin:settings-get-values",
  PLUGIN_SETTINGS_SET_VALUE: "plugin:settings-set-value",
  PLUGIN_SETTINGS_DELETE_VALUE: "plugin:settings-delete-value",
  PLUGIN_SETTINGS_REVEAL_SECRET: "plugin:settings-reveal-secret",
  /** Which declared `required` settings a plugin still has unset, for the panel setup strip. */
  PLUGIN_SETTINGS_REQUIRED_STATUS: "plugin:settings-required-status",
  /** A plugin's `contributes.setup` checklist as the host sees it, for the setup strip and settings (#13824). */
  PLUGIN_SETUP_STATUS: "plugin:setup-status",
  /** Skip or restore one setup step in the sender's project. */
  PLUGIN_SETUP_STEP_SKIPPED_SET: "plugin:setup-step-skipped-set",
  /** A plugin's `contributes.account` status for its settings row. Never carries a token. */
  PLUGIN_ACCOUNT_STATUS: "plugin:account-status",
  /** Start the declared OAuth sign-in from the settings row's click (#13823). */
  PLUGIN_ACCOUNT_CONNECT: "plugin:account-connect",
  PLUGIN_ACCOUNT_CANCEL_CONNECT: "plugin:account-cancel-connect",
  /** Store a pasted API token for a `kind: "token"` account. */
  PLUGIN_ACCOUNT_SET_TOKEN: "plugin:account-set-token",
  PLUGIN_ACCOUNT_DISCONNECT: "plugin:account-disconnect",
  /** Every declared connection's settings row status (#14102). Never carries a token. */
  PLUGIN_ACCOUNT_LIST: "plugin:account-list",
  /** Run a connection's declared test with its stored tokens; answers what the service said. */
  PLUGIN_ACCOUNT_TEST: "plugin:account-test",
  /** Which connection the sender's project uses for a plugin, and its choices. */
  PLUGIN_ACCOUNT_BINDING_GET: "plugin:account-binding-get",
  /** Choose the connection the sender's project uses for a plugin. */
  PLUGIN_ACCOUNT_BINDING_SET: "plugin:account-binding-set",
  /** Cancel an in-flight plugin install by its job id (#11302). */
  PLUGIN_CANCEL_INSTALL: "plugin:cancel-install",
  /** Phase/entry progress for an in-flight install, targeted at the initiating window (#11302). */
  PLUGIN_INSTALL_PROGRESS: "plugin:install-progress",
  /** Native folder/file chooser for plugin path/directory/file settings fields. */
  PLUGIN_PICK_PATH: "plugin:pick-path",
  /** Existence probe for a stored plugin `mustExist` path setting. */
  PLUGIN_PATH_EXISTS: "plugin:path-exists",
  /** Snapshot a plugin's existing databases to a file or folder the user picks. */
  PLUGIN_BACKUP_DATABASES: "plugin:backup-databases",
  /** Opt-in background plugin update check (#10893): read the enabled setting. */
  PLUGIN_BG_UPDATE_CHECK_SETTINGS_GET: "plugin:bg-update-check-settings-get",
  /** Opt-in background plugin update check (#10893): set the enabled setting. */
  PLUGIN_BG_UPDATE_CHECK_SETTINGS_SET: "plugin:bg-update-check-settings-set",
  /** Opt-in background plugin update check (#10893): hydrate the last cached result. */
  PLUGIN_BG_UPDATE_CHECK_LATEST: "plugin:bg-update-check-latest",
  /** Bridge: main process dispatches a plugin-sourced action request to the renderer. */
  PLUGIN_DISPATCH_ACTION_REQUEST: "plugin:dispatch-action-request",
  /** Bridge: renderer returns the plugin-sourced action dispatch result to the main process. */
  PLUGIN_DISPATCH_ACTION_RESPONSE: "plugin:dispatch-action-response",
  /** Bridge: main process asks the renderer for the plugin-facing action catalog (#10561). */
  PLUGIN_ACTIONS_LIST_REQUEST: "plugin:actions-list-request",
  /** Bridge: renderer returns the projected action catalog to the main process. */
  PLUGIN_ACTIONS_LIST_RESPONSE: "plugin:actions-list-response",
  /** Bridge: main process asks the renderer for a single projected action entry (#10561). */
  PLUGIN_ACTIONS_GET_REQUEST: "plugin:actions-get-request",
  /** Bridge: renderer returns the single projected action entry (or null) to the main process. */
  PLUGIN_ACTIONS_GET_RESPONSE: "plugin:actions-get-response",
  /** Bridge: main process asks the renderer for the project's agent panes (`host.agents.list`). */
  PLUGIN_AGENTS_LIST_REQUEST: "plugin:agents-list-request",
  /** Bridge: renderer returns the project's agent panes to the main process. */
  PLUGIN_AGENTS_LIST_RESPONSE: "plugin:agents-list-response",
  /** Bridge: main process asks the renderer to render an imperative plugin UI prompt (#10522). */
  PLUGIN_UI_PROMPT_REQUEST: "plugin:ui-prompt-request",
  /** Bridge: renderer returns the user's answer to a plugin UI prompt (fire-and-forget). */
  PLUGIN_UI_PROMPT_RESPONSE: "plugin:ui-prompt-response",
  /** Bridge: main process tells the renderer to drop a plugin's pending UI prompts on unload. */
  PLUGIN_UI_PROMPT_CANCEL: "plugin:ui-prompt-cancel",
  /** Bridge: main process asks the renderer holding a plugin panel to reload its view (#12610). */
  PLUGIN_PANEL_RELOAD_REQUEST: "plugin:panel-reload-request",
  /** Bridge: renderer acknowledges (or refuses) a plugin panel reload request. */
  PLUGIN_PANEL_RELOAD_RESPONSE: "plugin:panel-reload-response",

  // Plugin MCP supervisor channels (#9233) — stdio MCP servers contributed by
  // plugin manifests, supervised in the main process via execa. Distinct from
  // `mcp-server:*`, which covers the in-process inbound MCP server.
  PLUGIN_MCP_LIST: "plugin-mcp:list",
  PLUGIN_MCP_GET_STDERR: "plugin-mcp:get-stderr",
  PLUGIN_MCP_RESTART: "plugin-mcp:restart",
  // Lazy two-tier tool discovery (#9235): tier-1 summaries on demand and the
  // tier-2 full schema for a single selected tool.
  PLUGIN_MCP_LIST_TOOLS: "plugin-mcp:list-tools",
  PLUGIN_MCP_GET_FULL_SCHEMA: "plugin-mcp:get-full-schema",
  // Advanced tuning: the global tool-count cap surfaced as a setting (#9235).
  PLUGIN_MCP_GET_CONFIG: "plugin-mcp:get-config",
  PLUGIN_MCP_SET_CONFIG: "plugin-mcp:set-config",
  // Gated tool dispatch (#10461): callTool runs the rate-limit → consent →
  // dispatch pipeline; resolveConsent is the renderer's reply to a consent push.
  PLUGIN_MCP_CALL_TOOL: "plugin-mcp:call-tool",
  PLUGIN_MCP_RESOLVE_CONSENT: "plugin-mcp:resolve-consent",

  // Just-in-time plugin host-capability consent (#10524). The renderer's reply
  // to a `plugin-capability:consent-request` push; the request itself rides the
  // typed event bus. Distinct from the per-tool plugin-MCP consent above —
  // this gates first use of a host capability (shell:exec, fs:*-write, git:write).
  PLUGIN_CAPABILITY_RESOLVE_CONSENT: "plugin-capability:resolve-consent",
  // Receipt for that push (#11708), sent when the prompt is enqueued rather
  // than when it is answered. A push into a renderer with no listener is a
  // silent no-op, so without an explicit receipt an undeliverable prompt is
  // indistinguishable from an ignored one until the five-minute timeout.
  PLUGIN_CAPABILITY_ACKNOWLEDGE_CONSENT: "plugin-capability:acknowledge-consent",
  // The per-plugin "Allow project targeting" switch (#13119): the
  // `project:dispatch` grant that lets an app-wide plugin name a target project
  // on `host.dispatch`. Set only from the Plugin Manager, never by a prompt.
  PLUGIN_CAPABILITY_GET_PROJECT_TARGETING: "plugin-capability:get-project-targeting",
  PLUGIN_CAPABILITY_SET_PROJECT_TARGETING: "plugin-capability:set-project-targeting",
  // The per-plugin "Allow OS notifications" switch (#13505): the
  // `notification:os` grant behind `host.notify({ os: true })`. Set only from
  // the Plugin Manager, never by a prompt.
  PLUGIN_CAPABILITY_GET_OS_NOTIFICATIONS: "plugin-capability:get-os-notifications",
  PLUGIN_CAPABILITY_SET_OS_NOTIFICATIONS: "plugin-capability:set-os-notifications",
  // The per-plugin "Show notes when deleting a worktree" switch (#13805). On by
  // default; off means the plugin isn't asked.
  PLUGIN_CAPABILITY_GET_WORKTREE_DELETE_NOTES: "plugin-capability:get-worktree-delete-notes",
  PLUGIN_CAPABILITY_SET_WORKTREE_DELETE_NOTES: "plugin-capability:set-worktree-delete-notes",
  // The per-plugin "Show in attention views" switch (#13821): whether a
  // plugin's panel activity reports appear as rows in Pilot, the dock pills and
  // the sidebar filters. Set only from the Plugin Manager, never by a prompt.
  PLUGIN_CAPABILITY_GET_PANEL_ATTENTION: "plugin-capability:get-panel-attention",
  PLUGIN_CAPABILITY_SET_PANEL_ATTENTION: "plugin-capability:set-panel-attention",
  // Every instance id with that switch on, so each view can join reports
  // against it without one read per plugin.
  PLUGIN_CAPABILITY_LIST_PANEL_ATTENTION: "plugin-capability:list-panel-attention",

  // Plugin managed-process channels (#9234) — child processes spawned by a
  // plugin via `host.process.spawn` (gated on `shell:exec`). `list` is the
  // read-only renderer observability surface (e.g. a process dashboard);
  // streaming output reaches a plugin's panels over its `postToPanel` transport.
  PLUGIN_PROCESS_LIST: "plugin-process:list",

  // Config reload channels
  APP_RELOAD_CONFIG: "app:reload-config",
  APP_CONFIG_RELOADED: "app:config-reloaded",

  // Agent preset channels
  AGENT_PRESETS_UPDATED: "agent-presets:updated",
  AGENT_CAPABILITIES_GET_CCR_PRESETS: "agent-capabilities:get-ccr-presets",
  AGENT_CAPABILITIES_GET_RESOLVED_MODEL_LIST: "agent-capabilities:get-resolved-model-list",

  // Performance capture channels
  PERF_FLUSH_RENDERER_MARKS: "perf:flush-renderer-marks",

  // Host-owned agent defaults: assistant agent + default terminal agent (#13345)
  AGENT_DEFAULTS_GET: "agent-defaults:get",
  AGENT_DEFAULTS_SET: "agent-defaults:set",
  AGENT_DEFAULTS_MIGRATE_LEGACY: "agent-defaults:migrate-legacy",
  AGENT_DEFAULTS_CHANGED: "agent-defaults:changed",

  // This machine's toolbar agent pins (#14702)
  AGENT_TOOLBAR_PINS_GET: "agent-toolbar-pins:get",
  AGENT_TOOLBAR_PINS_SET: "agent-toolbar-pins:set",
  AGENT_TOOLBAR_PINS_CHANGED: "agent-toolbar-pins:changed",

  // Per-project presentation profile (#13771)
  PROJECT_PRESENTATION_GET: "project-presentation:get",
  PROJECT_PRESENTATION_SET_LEVEL: "project-presentation:set-level",
  PROJECT_PRESENTATION_ANSWER_SUGGESTION: "project-presentation:answer-suggestion",
  PROJECT_PRESENTATION_SET_TOOLBAR_ENABLED: "project-presentation:set-toolbar-enabled",
  PROJECT_PRESENTATION_SET_PLUGIN_BUTTON_PROMOTED:
    "project-presentation:set-plugin-button-promoted",
  PROJECT_PRESENTATION_RESET_TOOLBAR: "project-presentation:reset-toolbar",
  PROJECT_PRESENTATION_SET_LAUNCHER_GROUP_ORDER: "project-presentation:set-launcher-group-order",
  PROJECT_PRESENTATION_SET_FEATURED_LAUNCH_ENTRY: "project-presentation:set-featured-launch-entry",
  PROJECT_PRESENTATION_CHANGED: "project-presentation:changed",

  // The sender project's own theme (#13833)
  PROJECT_THEME_GET: "project-theme:get",
  PROJECT_THEME_SET_THEME: "project-theme:set-theme",
  PROJECT_THEME_ANSWER_SUGGESTION: "project-theme:answer-suggestion",
  PROJECT_THEME_RESET_SUGGESTION: "project-theme:reset-suggestion",
  PROJECT_THEME_CHANGED: "project-theme:changed",

  // The sender project's custom worktree titles (#14022)
  WORKTREE_TITLES_HYDRATE: "worktree-titles:hydrate",
  WORKTREE_TITLES_SET: "worktree-titles:set",
  WORKTREE_TITLES_PRUNE: "worktree-titles:prune",
  WORKTREE_TITLES_CHANGED: "worktree-titles:changed",

  // The sender project's review marks (#14584)
  REVIEW_MARKS_HYDRATE: "review-marks:hydrate",
  REVIEW_MARKS_MARK: "review-marks:mark",
  REVIEW_MARKS_MARK_CAPTURED: "review-marks:mark-captured",
  REVIEW_MARKS_CLEAR: "review-marks:clear",
  REVIEW_MARKS_CAPTURE: "review-marks:capture",
  REVIEW_MARKS_COMPARE: "review-marks:compare",
  REVIEW_MARKS_FILE_SINCE: "review-marks:file-since",
  REVIEW_MARKS_CHANGED: "review-marks:changed",

  // The sender project's schedules (#15975)
  SCHEDULES_LIST: "schedules:list",
  SCHEDULES_CREATE: "schedules:create",
  SCHEDULES_UPDATE: "schedules:update",
  SCHEDULES_SET_ENABLED: "schedules:set-enabled",
  SCHEDULES_REMOVE: "schedules:remove",
  SCHEDULES_CHANGED: "schedules:changed",
  SCHEDULES_RUN_NOW: "schedules:run-now",
  SCHEDULES_OS_JOB_STATUS: "schedules:os-job-status",
  SCHEDULES_REPAIR_OS_JOB: "schedules:repair-os-job",
  // Main asks the view showing a project to launch a scheduled run (#15978)
  SCHEDULES_LAUNCH_REQUEST: "schedules:launch-request",
  SCHEDULES_LAUNCH_RESPONSE: "schedules:launch-response",
  // Main asks the views holding a run's pane to apply its done policy (#15982)
  SCHEDULES_FINISH_REQUEST: "schedules:finish-request",
  SCHEDULES_RUN_CLOSED: "schedules:run-closed",

  // Decisions, as main observes it (#16001). The owner's machine only.
  DECISIONS_GET_STATUS: "decisions:get-status",
  // One pane's Decisions state, for its chrome to show on mount (#16016).
  // Read from the machine that owns the pane.
  DECISIONS_GET_PANE_STATE: "decisions:get-pane-state",
  DECISIONS_SET_ENABLED: "decisions:set-enabled",
  // A relay URL's unsigned health and protocol check (#16005), from main.
  DECISIONS_CHECK_RELAY: "decisions:check-relay",
  // Claiming a relay, restoring an identity from a recovery kit, and removing
  // this computer's identity (#16006), all in main.
  DECISIONS_CLAIM_RELAY: "decisions:claim-relay",
  DECISIONS_RESTORE_IDENTITY: "decisions:restore-identity",
  DECISIONS_DISCONNECT_RELAY: "decisions:disconnect-relay",
  // The devices paired with this computer's relay identity, and pairing a
  // phone through a one-time invitation and matching digits (#16009).
  DECISIONS_LIST_DEVICES: "decisions:list-devices",
  DECISIONS_START_PAIRING: "decisions:start-pairing",
  DECISIONS_GET_PAIRING: "decisions:get-pairing",
  DECISIONS_APPROVE_PAIRING: "decisions:approve-pairing",
  DECISIONS_DECLINE_PAIRING: "decisions:decline-pairing",

  // Per-service connectivity channels
  CONNECTIVITY_GET_STATE: "connectivity:get-state",
  CONNECTIVITY_SERVICE_CHANGED: "connectivity:service-changed",

  // Which windows hold a live view of which projects (#12597)
  PROJECT_PRESENCE_GET_SNAPSHOT: "project-presence:get-snapshot",
  PROJECT_PRESENCE_CHANGED: "project-presence:changed",

  // Scratch (throwaway one-off agent workspace) channels
  SCRATCH_GET_ALL: "scratch:get-all",
  SCRATCH_GET_CURRENT: "scratch:get-current",
  SCRATCH_CREATE: "scratch:create",
  SCRATCH_UPDATE: "scratch:update",
  SCRATCH_REMOVE: "scratch:remove",
  SCRATCH_SWITCH: "scratch:switch",
  SCRATCH_SAVE_AS_PROJECT: "scratch:save-as-project",
  SCRATCH_UPDATED: "scratch:updated",
  SCRATCH_REMOVED: "scratch:removed",
  SCRATCH_ON_SWITCH: "scratch:on-switch",

  // Workspace discovery — the catalog of every project and scratch, spanning
  // both stores, so an MCP client can look a workspace id up instead of
  // deriving one (#12307).
  WORKSPACE_LIST: "workspace:list",

  // The user's "keep this workspace resident" grant (#12313). Renderer-only by
  // design: the action manifest is the MCP tool surface, so routing this
  // through an action would let a bound client grant itself the residency
  // #11790 refused to grant it automatically.
  WORKSPACE_RESIDENCY_GET: "workspace-residency:get",
  WORKSPACE_RESIDENCY_SET: "workspace-residency:set",

  // Every live terminal and plugin process across all projects (#13175).
  // Renderer-only: a live terminal is killed through the existing terminal
  // kill, and a closed terminal's remaining processes through the host that
  // recorded them (#13174) — both behind a confirm in the processes view.
  PROCESSES_GET_SNAPSHOT: "processes:get-snapshot",
  PROCESSES_KILL_CLOSED_TERMINAL_PROCESSES: "processes:kill-closed-terminal-processes",

  // Per-project consent for plugin agent tools (`contributes.agentMcp`).
  // Renderer-only by design: an action here would be on the MCP tool surface,
  // and an agent must never be able to grant itself a plugin's tools.
  PLUGIN_AGENT_MCP_LIST_PROJECT_PLUGINS: "plugin-agent-mcp:list-project-plugins",
  PLUGIN_AGENT_MCP_SET_PLUGIN_ACCESS: "plugin-agent-mcp:set-plugin-access",

  // Remote Hosts: remoteHosts (shell).
  REMOTE_HOSTS_LIST: "remote-hosts:list",
  REMOTE_HOSTS_LIST_RECENT: "remote-hosts:list-recent",
  REMOTE_HOSTS_ADD: "remote-hosts:add",
  REMOTE_HOSTS_UPDATE: "remote-hosts:update",
  REMOTE_HOSTS_FORGET: "remote-hosts:forget",
  REMOTE_HOSTS_CONNECT: "remote-hosts:connect",
  REMOTE_HOSTS_DISCONNECT: "remote-hosts:disconnect",
  REMOTE_HOSTS_GET_WINDOW_HOST: "remote-hosts:get-window-host",
  REMOTE_HOSTS_TAKE_PROJECT_OFFER: "remote-hosts:take-project-offer",
  REMOTE_HOSTS_SWITCH_WINDOW_HOST: "remote-hosts:switch-window-host",
  REMOTE_HOSTS_GET_PENDING_SWITCH: "remote-hosts:get-pending-switch",
  REMOTE_HOSTS_CANCEL_PENDING_SWITCH: "remote-hosts:cancel-pending-switch",
  REMOTE_HOSTS_DISCOVER: "remote-hosts:discover",
  REMOTE_HOSTS_PROBE: "remote-hosts:probe",
  REMOTE_HOSTS_GET_LOCAL_HANDSHAKE: "remote-hosts:get-local-handshake",
  REMOTE_HOSTS_IS_IN_USE: "remote-hosts:is-in-use",
  REMOTE_HOSTS_PLAN_INSTALL: "remote-hosts:plan-install",
  REMOTE_HOSTS_INSTALL: "remote-hosts:install",
  REMOTE_HOSTS_GET_INSTALL_STATUS: "remote-hosts:get-install-status",
  REMOTE_HOSTS_CANCEL_INSTALL: "remote-hosts:cancel-install",
  REMOTE_HOSTS_START_HOST_MODE: "remote-hosts:start-host-mode",
  REMOTE_HOSTS_LIST_HOST_PROJECTS: "remote-hosts:list-host-projects",
  REMOTE_HOSTS_LIST_CLIPBOARD_GRANTS: "remote-hosts:list-clipboard-grants",
  REMOTE_HOSTS_RESET_CLIPBOARD_GRANTS: "remote-hosts:reset-clipboard-grants",
  REMOTE_HOSTS_LIST_PLUGIN_VIEW_CONSENTS: "remote-hosts:list-plugin-view-consents",
  REMOTE_HOSTS_RESET_PLUGIN_VIEW_CONSENT: "remote-hosts:reset-plugin-view-consent",
  REMOTE_HOSTS_PREPARE_PLUGIN_VIEW: "remote-hosts:prepare-plugin-view",
  REMOTE_HOSTS_EVENT: "remote-hosts:event",

  // Remote Hosts: hostMode (shell).
  HOST_MODE_GET_STATUS: "host-mode:get-status",
  HOST_MODE_SET_ENABLED: "host-mode:set-enabled",
  HOST_MODE_RUN_KEYCHAIN_PREFLIGHT: "host-mode:run-keychain-preflight",
  HOST_MODE_EVENT: "host-mode:event",
  DEVICE_ANSWER_GET_STATUS: "device-answer:get-status",
  DEVICE_ANSWER_SET_ENABLED: "device-answer:set-enabled",
  DEVICE_ANSWER_CREATE_PAIRING_CODE: "device-answer:create-pairing-code",
  DEVICE_ANSWER_CANCEL_PAIRING_CODE: "device-answer:cancel-pairing-code",
  DEVICE_ANSWER_REVOKE_DEVICE: "device-answer:revoke-device",
  DEVICE_ANSWER_EVENT: "device-answer:event",

  // Remote Hosts: driveLease (host).
  DRIVE_LEASE_GET: "drive-lease:get",
  DRIVE_LEASE_TAKE_OVER: "drive-lease:take-over",
  DRIVE_LEASE_REPORT_NAVIGATION: "drive-lease:report-navigation",
  DRIVE_LEASE_EVENT: "drive-lease:event",

  // Remote Hosts: operations (host).
  OPERATIONS_GET_STATUS: "operations:get-status",
  OPERATIONS_LIST: "operations:list",
  OPERATIONS_CANCEL: "operations:cancel",
  OPERATIONS_EVENT: "operations:event",

  // Remote Hosts: hostFiles (host).
  HOST_FILES_LIST_DIRECTORY: "host-files:list-directory",
  HOST_FILES_GET_PICKER_ROOTS: "host-files:get-picker-roots",

  // Remote Hosts: fileTransfer (shell).
  FILE_TRANSFER_UPLOAD_LOCAL_FILE: "file-transfer:upload-local-file",
  FILE_TRANSFER_UPLOAD_BYTES: "file-transfer:upload-bytes",
  FILE_TRANSFER_DOWNLOAD: "file-transfer:download",
  FILE_TRANSFER_GRANT_CLICKED_FILE: "file-transfer:grant-clicked-file",
  FILE_TRANSFER_CANCEL: "file-transfer:cancel",
  FILE_TRANSFER_ANSWER_HOST_PICK: "file-transfer:answer-host-pick",
  FILE_TRANSFER_GET_PREVIEW_CAPABILITY: "file-transfer:get-preview-capability",
  FILE_TRANSFER_STAT_LOCAL_FILE: "file-transfer:stat-local-file",
  FILE_TRANSFER_GET_UPLOAD_PREFERENCES: "file-transfer:get-upload-preferences",
  FILE_TRANSFER_SET_UPLOAD_PREFERENCES: "file-transfer:set-upload-preferences",
  FILE_TRANSFER_EVENT: "file-transfer:event",
  // preload → main only: the paths of Files the person dropped or pasted in a remote view.
  FILE_TRANSFER_GRANT_LOCAL_SOURCES: "file-transfer:grant-local-sources",

  // Remote Hosts: hostSwitch (shell).
  HOST_SWITCH_PLAN: "host-switch:plan",
  HOST_SWITCH_PREPARE: "host-switch:prepare",
  HOST_SWITCH_CHECK_DESTINATION: "host-switch:check-destination",
  HOST_SWITCH_EXECUTE: "host-switch:execute",
  HOST_SWITCH_STATUS: "host-switch:status",
  HOST_SWITCH_CANCEL: "host-switch:cancel",
  HOST_SWITCH_LOCATE: "host-switch:locate",
  HOST_SWITCH_SUGGEST_CLONE_DESTINATION: "host-switch:suggest-clone-destination",
  HOST_SWITCH_LIST_DIRECTORY: "host-switch:list-directory",
  HOST_SWITCH_PICKER_ROOTS: "host-switch:picker-roots",

  // Remote Hosts: projectMatch (host).
  PROJECT_MATCH_FIND: "project-match:find",
  PROJECT_MATCH_SCAN: "project-match:scan",
  PROJECT_MATCH_FIND_WORKTREE_FOR_BRANCH: "project-match:find-worktree-for-branch",
  PROJECT_MATCH_TAKE_PENDING_SETUP: "project-match:take-pending-setup",

  // Remote Hosts: hostMetrics (shell).
  HOST_METRICS_GET_SNAPSHOTS: "host-metrics:get-snapshots",
  HOST_METRICS_LIST_FLEET_TARGETS: "host-metrics:list-fleet-targets",
  HOST_METRICS_SUBMIT_FLEET: "host-metrics:submit-fleet",
  HOST_METRICS_LIST_WORKTREES: "host-metrics:list-worktrees",
  HOST_METRICS_LINK_ACTIVITY: "host-metrics:link-activity",
  HOST_METRICS_PROCESS_INVENTORY: "host-metrics:process-inventory",
  HOST_METRICS_EVENT: "host-metrics:event",

  // Remote Hosts: canopyHost (shell).
  CANOPY_HOST_INVOKE: "canopy-host:invoke",
  CANOPY_HOST_RELEASE: "canopy-host:release",
  CANOPY_HOST_LIST_ASSISTANTS: "canopy-host:list-assistants",
  CANOPY_HOST_READ_ASSISTANT_WORK: "canopy-host:read-assistant-work",
  CANOPY_HOST_WATCH_ASSISTANT: "canopy-host:watch-assistant",
  CANOPY_HOST_RESOLVE_ASSISTANT: "canopy-host:resolve-assistant",
  CANOPY_HOST_ASSISTANT_INVOKE: "canopy-host:assistant-invoke",
  CANOPY_HOST_RELEASE_ASSISTANT: "canopy-host:release-assistant",
  CANOPY_HOST_EVENT: "canopy-host:event",

  // Remote Hosts: portForwards (shell).
  PORT_FORWARDS_LIST: "port-forwards:list",
  PORT_FORWARDS_FORWARD: "port-forwards:forward",
  PORT_FORWARDS_STOP: "port-forwards:stop",
  PORT_FORWARDS_RELEASE: "port-forwards:release",
  PORT_FORWARDS_LIST_HOST_PORTS: "port-forwards:list-host-ports",
  PORT_FORWARDS_EVENT: "port-forwards:event",

  // Remote Hosts: pluginParity (shell).
  PLUGIN_PARITY_DIFF: "plugin-parity:diff",
  PLUGIN_PARITY_INSTALL_ON_HOST: "plugin-parity:install-on-host",
  PLUGIN_PARITY_UPDATE_ON_HOST: "plugin-parity:update-on-host",
  PLUGIN_PARITY_CLAIM_SWITCH_NOTICE: "plugin-parity:claim-switch-notice",

  // Remote Hosts: settingsCopy (shell).
  SETTINGS_COPY_PREVIEW: "settings-copy:preview",
  SETTINGS_COPY_APPLY: "settings-copy:apply",
  SETTINGS_COPY_STATUS: "settings-copy:status",
  SETTINGS_COPY_UNDO: "settings-copy:undo",

  // Remote Hosts: hostSettings (shell).
  HOST_SETTINGS_READ: "host-settings:read",
  HOST_SETTINGS_UPDATE: "host-settings:update",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
