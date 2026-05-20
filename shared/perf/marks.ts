export const PERF_MARKS = {
  APP_BOOT_START: "app_boot_start",
  EARLY_PATH_REFRESH_START: "early_path_refresh_start",
  EARLY_PATH_REFRESH_COMPLETE: "early_path_refresh_complete",
  MAIN_WINDOW_CREATED: "main_window_created",
  RENDERER_READY: "renderer_ready",
  RENDERER_FIRST_INTERACTIVE: "renderer_first_interactive",

  SERVICE_INIT_START: "service_init_start",
  WINDOW_SERVICES_START: "window_services_start",
  SERVICE_INIT_MIGRATIONS_DONE: "service_init_migrations_done",
  SERVICE_INIT_PTY_READY: "service_init_pty_ready",
  SERVICE_INIT_WORKSPACE_READY: "service_init_workspace_ready",
  SERVICE_INIT_IPC_READY: "service_init_ipc_ready",
  SERVICE_INIT_COMPLETE: "service_init_complete",
  DEFERRED_SERVICES_START: "deferred_services_start",
  DEFERRED_SERVICES_COMPLETE: "deferred_services_complete",

  PTY_HOST_FORK_DISPATCHED: "pty_host_fork_dispatched",
  PTY_HOST_MODULE_EVAL_COMPLETE: "pty_host_module_eval_complete",
  PTY_HOST_NATIVE_MODULE_READY: "pty_host_native_module_ready",
  PTY_HOST_READY_POSTED: "pty_host_ready_posted",

  WORKSPACE_HOST_FORK_DISPATCHED: "workspace_host_fork_dispatched",
  WORKSPACE_HOST_MODULE_EVAL_COMPLETE: "workspace_host_module_eval_complete",
  WORKSPACE_HOST_NATIVE_MODULE_READY: "workspace_host_native_module_ready",
  WORKSPACE_HOST_READY_POSTED: "workspace_host_ready_posted",

  CRASH_RECOVERY_GATE: "crash_recovery_gate",
  HYDRATE_START: "hydrate_start",
  HYDRATE_RESTORE_PANELS_START: "hydrate_restore_panels_start",
  HYDRATE_RESTORE_PANELS_END: "hydrate_restore_panels_end",
  HYDRATE_RESTORE_TAB_GROUPS_END: "hydrate_restore_tab_groups_end",
  HYDRATE_BOOTSTRAP: "hydrate_bootstrap",
  HYDRATE_BOOTSTRAP_LOAD_OVERRIDES: "hydrate_bootstrap_load_overrides",
  HYDRATE_BOOTSTRAP_INIT_USER_AGENTS: "hydrate_bootstrap_init_user_agents",
  HYDRATE_APP_CLIENT: "hydrate_app_client",
  HYDRATE_GET_TERMINALS: "hydrate_get_terminals",
  HYDRATE_RESTORE_SNAPSHOTS_CRITICAL: "hydrate_restore_snapshots_critical",
  HYDRATE_COMPLETE: "hydrate_complete",

  PROJECT_SWITCH_START: "project_switch_start",
  PROJECT_SWITCH_END: "project_switch_end",
  PROJECT_SWITCH_CLEANUP: "project_switch_cleanup",
  PROJECT_SWITCH_LOAD_PROJECT: "project_switch_load_project",
  WORKTREE_SWITCH_START: "worktree_switch_start",
  WORKTREE_SWITCH_END: "worktree_switch_end",

  PROJECT_STATE_WRITE: "project_state_write",
  PROJECT_STATE_READ: "project_state_read",
  PROJECT_STATE_QUARANTINE: "project_state_quarantine",

  DEVPREVIEW_ENSURE_START: "devpreview_ensure_start",
  DEVPREVIEW_TERMINAL_SPAWNED: "devpreview_terminal_spawned",
  DEVPREVIEW_URL_DETECTED: "devpreview_url_detected",
  DEVPREVIEW_RUNNING: "devpreview_running",
  DEVPREVIEW_RESTART_START: "devpreview_restart_start",
  DEVPREVIEW_RESTART_END: "devpreview_restart_end",

  TERMINAL_DATA_RECEIVED: "terminal_data_received",
  TERMINAL_DATA_PARSED: "terminal_data_parsed",
  TERMINAL_DATA_RENDERED: "terminal_data_rendered",

  IPC_REQUEST_START: "ipc_request_start",
  IPC_REQUEST_END: "ipc_request_end",

  RENDERER_CLS_SAMPLE: "renderer_cls_sample",
  RENDERER_CLS_FINAL: "renderer_cls_final",
} as const;

export type PerfMarkName = (typeof PERF_MARKS)[keyof typeof PERF_MARKS];

export interface RendererPerfRecord {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

export interface RendererPerfFlushPayload {
  marks: RendererPerfRecord[];
  rendererTimeOrigin: number;
  rendererT0: number;
}
