export const PERF_MARKS = {
  APP_BOOT_START: "app_boot_start",
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

  HYDRATE_START: "hydrate_start",
  HYDRATE_RESTORE_PANELS_START: "hydrate_restore_panels_start",
  HYDRATE_RESTORE_PANELS_END: "hydrate_restore_panels_end",
  HYDRATE_RESTORE_TAB_GROUPS_END: "hydrate_restore_tab_groups_end",
  HYDRATE_BOOTSTRAP: "hydrate_bootstrap",
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
