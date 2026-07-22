export const CHANNELS = {
  WORKTREE_GET_ALL: "worktree:get-all",
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
  WORKTREE_RESTART_SERVICE: "worktree:restart-service",
  WORKTREE_RETRY_PROJECT_LOAD: "worktree:retry-project-load",
  WORKTREE_RETRY_AUTH_FETCH: "worktree:retry-auth-fetch",
  PROJECT_WORKTREE_LOAD_STATUS: "project:worktree-load-status",

  TERMINAL_SPAWN: "terminal:spawn",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_INPUT: "terminal:input",
  TERMINAL_SUBMIT: "terminal:submit",
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
  TERMINAL_GET_ANALYSIS_BUFFER: "terminal:get-analysis-buffer",
  TERMINAL_GET_INFO: "terminal:get-info",
  TERMINAL_ACKNOWLEDGE_DATA: "terminal:acknowledge-data",
  TERMINAL_FORCE_RESUME: "terminal:force-resume",
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
  TERMINAL_REDUCE_SCROLLBACK: "terminal:reduce-scrollback",
  TERMINAL_RESTORE_SCROLLBACK: "terminal:restore-scrollback",
  TERMINAL_RESTART_SERVICE: "terminal:restart-service",
  WATCHDOG_RESTART: "watchdog:restart",
  TERMINAL_FD_LEAK_WARNING: "terminal:fd-leak-warning",
  TERMINAL_RESOURCE_METRICS: "terminal:resource-metrics",

  AGENT_SESSION_LIST: "agent-session:list",
  AGENT_SESSION_CLEAR: "agent-session:clear",
  AGENT_SESSION_GET_RETENTION: "agent-session:get-retention",
  AGENT_SESSION_SET_RETENTION: "agent-session:set-retention",

  FILES_SEARCH: "files:search",
  FILES_READ: "files:read",

  DIFF_MEDIA_READ_FILE_VERSIONS: "diff-media:read-file-versions",

  FILE_BROWSER_LIST_DIRECTORY: "file-browser:list-directory",
  FILE_BROWSER_STAT_PATHS: "file-browser:stat-paths",

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
  SYSTEM_REQUEST_INTERACTIVE_OVERRIDE: "system:request-interactive-override",
  SYSTEM_GET_WHY_SLOW_SNAPSHOT: "system:get-why-slow-snapshot",
  SYSTEM_GET_MEMORY_SNAPSHOT: "system:get-memory-snapshot",
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
  APP_DISMISS_ROSETTA_WARNING: "app:dismiss-rosetta-warning",
  MENU_ACTION: "menu:action",
  MENU_SHOW_CONTEXT: "menu:show-context",

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
  PROJECT_REMOVED: "project:removed",
  PROJECT_SWITCH: "project:switch",
  PROJECT_PREFETCH_HYDRATE: "project:prefetch-hydrate",
  PROJECT_OPEN_DIALOG: "project:open-dialog",
  PROJECT_ON_SWITCH: "project:on-switch",
  PROJECT_FOCUS_ON_ACTIVATE: "project:focus-on-activate",
  PROJECT_BACKGROUND_RESIZE: "project:background-resize",
  PROJECT_GET_SETTINGS: "project:get-settings",
  PROJECT_SAVE_SETTINGS: "project:save-settings",
  PROJECT_DETECT_RUNNERS: "project:detect-runners",
  PROJECT_LIST_REMOTES: "project:list-remotes",
  PROJECT_CLOSE: "project:close",
  PROJECT_FREE_MEMORY: "project:free-memory",
  PROJECT_REOPEN: "project:reopen",
  PROJECT_GET_STATS: "project:get-stats",
  PROJECT_GET_BULK_STATS: "project:get-bulk-stats",
  PROJECT_GET_NOTIFICATION_OVERRIDES: "project:get-notification-overrides",
  PROJECT_STATS_UPDATED: "project:stats-updated",
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
  AGENT_SETTINGS_GET: "agent-settings:get",
  AGENT_SETTINGS_SET: "agent-settings:set",
  AGENT_SETTINGS_SET_GLOBAL: "agent-settings:set-global",
  AGENT_SETTINGS_SET_GLOBAL_INLINE: "agent-settings:set-global-inline",
  AGENT_SETTINGS_RESET: "agent-settings:reset",
  AGENT_SETTINGS_STAMP_VERSION: "agent-settings:stamp-version",

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

  ACCESSIBILITY_GET_ENABLED: "accessibility:get-enabled",
  ACCESSIBILITY_SUPPORT_CHANGED: "accessibility:support-changed",

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
  GIT_FORCE_PUSH_WITH_LEASE: "git:force-push-with-lease",
  GIT_LIST_REMOTE_COMMITS: "git:list-remote-commits",
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
  PORTAL_SHOW_NEW_TAB_MENU: "portal:show-new-tab-menu",
  PORTAL_NAV_EVENT: "portal:nav-event",
  PORTAL_FOCUS: "portal:focus",
  PORTAL_BLUR: "portal:blur",
  PORTAL_NEW_TAB_MENU_ACTION: "portal:new-tab-menu-action",
  PORTAL_TAB_EVICTED: "portal:tab-evicted",
  PORTAL_TABS_EVICTED: "portal:tabs-evicted",

  HIBERNATION_GET_CONFIG: "hibernation:get-config",
  HIBERNATION_UPDATE_CONFIG: "hibernation:update-config",
  HIBERNATION_PROJECT_HIBERNATED: "hibernation:project-hibernated",

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

  COMMANDS_LIST: "commands:list",
  COMMANDS_GET: "commands:get",
  COMMANDS_EXECUTE: "commands:execute",
  COMMANDS_GET_BUILDER: "commands:get-builder",

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
  HELP_REPORT_PANEL_OPEN: "help:report-panel-open",
  HELP_GET_PINNED_ACTION_CONTEXT: "help:get-pinned-action-context",

  CLIPBOARD_SAVE_IMAGE: "clipboard:save-image",
  CLIPBOARD_THUMBNAIL_FROM_PATH: "clipboard:thumbnail-from-path",
  CLIPBOARD_WRITE_IMAGE: "clipboard:write-image",
  CLIPBOARD_WRITE_TEXT: "clipboard:write-text",
  CLIPBOARD_WRITE_SELECTION: "clipboard:write-selection",
  CLIPBOARD_READ_SELECTION: "clipboard:read-selection",

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
   * Revoke every grant currently held by the named session. Returns the
   * count of revoked grants for the renderer's confirmation copy. Caller-
   * pin checked.
   */
  MCP_SERVER_REVOKE_SESSION_GRANTS: "mcp-server:revoke-session-grants",
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
  VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
  VOICE_INPUT_START: "voice-input:start",
  VOICE_INPUT_STOP: "voice-input:stop",
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
  VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
  VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
  VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",

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
  ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN: "onboarding:checklist-mark-celebration-shown",
  ONBOARDING_CHECKLIST_PUSH: "onboarding:checklist-push",

  // Milestone channels
  MILESTONES_GET: "milestones:get",
  MILESTONES_MARK_SHOWN: "milestones:mark-shown",

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
  FORGE_OPEN_ISSUE: "forge:open-issue",
  FORGE_GET_ISSUE_URL: "forge:get-issue-url",
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
  FORGE_LIST_ISSUES: "forge:list-issues",
  FORGE_LIST_PRS: "forge:list-prs",
  FORGE_GET_ISSUE: "forge:get-issue",
  FORGE_GET_PR: "forge:get-pr",
  FORGE_GET_REPO_METADATA: "forge:get-repo-metadata",
  FORGE_GET_CURRENT_USER: "forge:get-current-user",
  FORGE_CLASSIFY_PUSH_ERROR: "forge:classify-push-error",
  FORGE_GET_REPO_STATS: "forge:get-repo-stats",
  FORGE_GET_FIRST_PAGE_CACHE: "forge:get-first-page-cache",
  FORGE_GET_PROJECT_HEALTH: "forge:get-project-health",
  FORGE_GET_ISSUE_TOOLTIP: "forge:get-issue-tooltip",
  FORGE_GET_PR_TOOLTIP: "forge:get-pr-tooltip",
  FORGE_GET_ISSUES_BY_NUMBERS: "forge:get-issues-by-numbers",
  FORGE_GET_PRS_BY_NUMBERS: "forge:get-prs-by-numbers",
  FORGE_GET_PR_REVIEW_THREADS: "forge:get-pr-review-threads",
  FORGE_RESOLVE_AUTHOR_AVATAR: "forge:resolve-author-avatar",
  FORGE_GET_TOKEN_HEALTH: "forge:get-token-health",
  FORGE_GET_RATE_LIMIT_DETAILS: "forge:get-rate-limit-details",
  FORGE_OPEN_PR: "forge:open-pr",
  FORGE_CREATE_PR: "forge:create-pr",
  FORGE_CLOSE_PR: "forge:close-pr",
  FORGE_REOPEN_PR: "forge:reopen-pr",
  FORGE_MERGE_PR: "forge:merge-pr",
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

  // Run history channels — durable recipe/fleet automation outcomes (#9949).
  // Dedicated `run-history:*` prefix so codegen produces a `runHistory`
  // renderer namespace.
  RUN_HISTORY_GET_RECORDS: "run-history:get-records",
  RUN_HISTORY_APPEND: "run-history:append",
  RUN_HISTORY_CLEAR: "run-history:clear",

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
  PLUGIN_KEYBINDINGS: "plugin:keybindings",
  PLUGIN_CONTEXT_MENU_ITEMS: "plugin:context-menu-items",
  PLUGIN_VALIDATE_ACTION_IDS: "plugin:validate-action-ids",
  PLUGIN_ACTIONS_GET: "plugin:actions-get",
  PLUGIN_ACTIONS_REGISTER: "plugin:actions-register",
  PLUGIN_ACTIONS_UNREGISTER: "plugin:actions-unregister",
  PLUGIN_PANEL_KINDS_GET: "plugin:panel-kinds-get",
  /** Lazy activation: force the plugin owning a contributed panel view to `activate()` before its module loads. */
  PLUGIN_ACTIVATE_FOR_VIEW: "plugin:activate-for-view",
  PLUGIN_AGENTS_GET: "plugin:agents-get",
  PLUGIN_FORGE_PROVIDERS_GET: "plugin:forge-providers-get",
  PLUGIN_FILE_DECORATIONS_GET: "plugin:file-decorations-get",
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
  /** Native folder/file chooser for plugin path/directory/file settings fields. */
  PLUGIN_PICK_PATH: "plugin:pick-path",
  /** Existence probe for a stored plugin `mustExist` path setting. */
  PLUGIN_PATH_EXISTS: "plugin:path-exists",
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
  /** Bridge: main process asks the renderer to render an imperative plugin UI prompt (#10522). */
  PLUGIN_UI_PROMPT_REQUEST: "plugin:ui-prompt-request",
  /** Bridge: renderer returns the user's answer to a plugin UI prompt (fire-and-forget). */
  PLUGIN_UI_PROMPT_RESPONSE: "plugin:ui-prompt-response",
  /** Bridge: main process tells the renderer to drop a plugin's pending UI prompts on unload. */
  PLUGIN_UI_PROMPT_CANCEL: "plugin:ui-prompt-cancel",

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

  // Per-service connectivity channels
  CONNECTIVITY_GET_STATE: "connectivity:get-state",
  CONNECTIVITY_SERVICE_CHANGED: "connectivity:service-changed",

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
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
