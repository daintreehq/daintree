export const PERF_MARKS = {
  APP_BOOT_START: "app_boot_start",
  /**
   * Renderer fired the `app:boot` IPC at module-eval time (before `createRoot`),
   * so the round-trip overlaps React parse and the first commit (#8820).
   * Distinct from the main-process `APP_BOOT_START`, which marks `app.ready`.
   */
  RENDERER_APP_BOOT_IPC_SENT: "renderer_app_boot_ipc_sent",
  EARLY_PATH_REFRESH_START: "early_path_refresh_start",
  EARLY_PATH_REFRESH_COMPLETE: "early_path_refresh_complete",
  MAIN_WINDOW_CREATED: "main_window_created",
  /**
   * Recorded the moment `win.show()` is called from the dom-ready-gated
   * `showOnce()` path in `createWindow.ts` — i.e. when the OS is asked to map
   * the window on screen. Pairs with `MAIN_WINDOW_CREATED` and `APP_BOOT_START`
   * to expose the window-reveal phase the cold-start harness was previously
   * blind to. Carries `meta: { fallback: true }` when the 5s fallback timer
   * fired instead of dom-ready.
   */
  MAIN_WINDOW_SHOWN: "main_window_shown",
  RENDERER_READY: "renderer_ready",
  RENDERER_FIRST_INTERACTIVE: "renderer_first_interactive",
  /**
   * The post-hydration listener set (notification/GitHub/store/sound/dev-server
   * hooks) mounts once `isStateLoaded` flips true, after the startup skeleton
   * fades. Staging these out of `AppInner`'s first commit keeps their effects
   * off the first flush; this mark anchors the staged mount so LoAF attribution
   * windows stay readable (#9769).
   */
  POST_HYDRATION_LISTENERS_MOUNT: "post_hydration_listeners_mount",

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
  /**
   * Emitted exactly once per `handleAppHydrate` (cold boot AND project-switch
   * hydrates) with `hit`/`reason` metadata recording whether the prefetched
   * HydrateResult cache serviced the request. Mirrors POOL_HIT/POOL_MISS so
   * `perf:cold-start` can prove the whenReady boot-prime prefetch actually
   * wins the race instead of inferring it from PROJECT_STATE_READ placement.
   */
  APP_HYDRATE_PREFETCH: "app_hydrate_prefetch",
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
  /**
   * Double-rAF after the selection commit — the first frame the user can see
   * the new worktree's panels. `WORKTREE_SWITCH_END` anchors on store
   * mutation + terminal policy, which finishes before paint; this mark is the
   * perceived-latency boundary for the app's highest-frequency navigation.
   */
  WORKTREE_SWITCH_PAINTED: "worktree_switch_painted",

  /**
   * End-to-end project-switch trace on the real ProjectViewManager path. Every
   * mark carries `switchId` in meta so one switch can be stitched across the
   * outgoing renderer, main, and the incoming renderer. Ordered as they fire.
   */
  // Outgoing renderer
  PROJECT_SWITCH_KEYDOWN: "project_switch.keydown",
  PROJECT_SWITCH_INTENT: "project_switch.intent",
  PROJECT_SWITCH_BUSY_PAINTED: "project_switch.busy_painted",
  PROJECT_SWITCH_PERSIST_IDLE: "project_switch.persist_idle",
  PROJECT_SWITCH_SNAPSHOT_BUILT: "project_switch.snapshot_built",
  PROJECT_SWITCH_IPC_SENT: "project_switch.ipc_sent",
  // Main
  PROJECT_SWITCH_MAIN_RECEIVED: "project_switch.main_received",
  PROJECT_SWITCH_MAIN_LOOP_PROBE: "project_switch.main_loop_probe",
  PROJECT_SWITCH_PENDING_PERSIST_DONE: "project_switch.pending_persist_done",
  PROJECT_SWITCH_CHAIN_ENTERED: "project_switch.chain_entered",
  PROJECT_SWITCH_VIEW_ATTACHED: "project_switch.view_attached",
  PROJECT_SWITCH_LOAD_FINISHED: "project_switch.load_finished",
  PROJECT_SWITCH_GATE_RESOLVED: "project_switch.gate_resolved",
  PROJECT_SWITCH_REVEALED: "project_switch.revealed",
  PROJECT_SWITCH_SWAP_DONE: "project_switch.swap_done",
  PROJECT_SWITCH_PTY_PORT_SENT: "project_switch.pty_port_sent",
  PROJECT_SWITCH_WORKTREES_LOADED: "project_switch.worktrees_loaded",
  PROJECT_SWITCH_SETTLED: "project_switch.settled",
  PROJECT_SWITCH_FIRST_INTERACTIVE: "project_switch.first_interactive",
  // Incoming renderer
  PROJECT_SWITCH_ON_SWITCH_RECEIVED: "project_switch.on_switch_received",
  PROJECT_SWITCH_WARM_ACTIVATED_RECEIVED: "project_switch.warm_activated_received",
  PROJECT_SWITCH_FOCUSED_PANE_WOKEN: "project_switch.focused_pane_woken",
  PROJECT_SWITCH_ALL_PANES_WOKEN: "project_switch.all_panes_woken",
  PROJECT_SWITCH_WARM_PAINT_SIGNALLED: "project_switch.warm_paint_signalled",
  PROJECT_SWITCH_REVEALED_RECEIVED: "project_switch.revealed_received",
  PROJECT_SWITCH_REVEAL_REPAINT_DONE: "project_switch.reveal_repaint_done",
  PROJECT_SWITCH_PTY_PORT_READY: "project_switch.pty_port_ready",
  /** Whether a warm reveal moved DOM focus back onto a terminal, or why not. */
  PROJECT_SWITCH_FOCUS_RESTORE: "project_switch.focus_restore",
  // Spec-driven: emitted by the E2E harness through `__daintreeMarkPerf`.
  PROJECT_SWITCH_NONCE_PAINTED: "project_switch.nonce_painted",
  PROJECT_SWITCH_NONCE_FRAME: "project_switch.nonce_frame",

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
  /**
   * Whether a cold switch's `terminal:get-for-project` was served from the
   * inventory main prefetched when the switch arrived, or paid the pty-host
   * round trip on the hydration critical path.
   */
  TERMINAL_INVENTORY_PREFETCH: "terminal_inventory_prefetch",
  /**
   * Sampled keystroke→echo delta: time from a MessagePort terminal write to
   * the next port data chunk for the same terminal id (~1/32 writes; pairs
   * older than 250ms are discarded so unrelated output isn't counted as
   * echo). Measured in `terminalClient`; the end-to-end input-latency signal
   * the batcher/coalescer/paint-gate tuning is otherwise blind to.
   */
  INPUT_ECHO_LATENCY: "input_echo_latency",

  /**
   * Bracket the synchronous `terminal.open(hostElement)` call in
   * `TerminalInstanceService.attach()` — the cold-path first-paint step that
   * builds xterm's DOM, forces a reflow to measure the cell grid, and inits
   * the active renderer. Paired so the cold-start harness can attribute how
   * much of the new-terminal latency is `open()` itself vs. font/addon work
   * around it (#9809).
   */
  TERMINAL_OPEN_START: "terminal_open_start",
  TERMINAL_OPEN_END: "terminal_open_end",
  /**
   * First real PTY write to reach `terminal.write()` for a given terminal —
   * fired once per terminal after the hibernation/serialized-restore early
   * exits. Carries `elapsedSinceOpenMs` (time from `open()` to first visible
   * byte) so the gap between an opened-but-empty grid and first content is
   * measurable in `perf:cold-start` (#9809).
   */
  TERMINAL_FIRST_WRITE: "terminal_first_write",
  /** Renderer-independent hashes of newly painted xterm buffer lines. */
  TERMINAL_OUTPUT_PAINTED: "terminal_output_painted",

  /**
   * Emitted per spawn from the pty-host when `acquireByKey` finds (HIT) or
   * misses (MISS) a pre-warmed entry for the requested (cwd, envHash). Lets
   * `perf:cold-start` measure pool hit rate on session restore instead of the
   * DAINTREE_VERBOSE-only log line (#9774).
   */
  POOL_HIT: "pty_pool_hit",
  POOL_MISS: "pty_pool_miss",

  IPC_REQUEST_START: "ipc_request_start",
  IPC_REQUEST_END: "ipc_request_end",

  RENDERER_CLS_SAMPLE: "renderer_cls_sample",
  RENDERER_CLS_FINAL: "renderer_cls_final",

  // Per-WebContentsView preload evaluation cost (#9770). Captured in the
  // sandboxed preload and flushed via PERF_FLUSH_RENDERER_MARKS at preload
  // bottom; the main-process handler correlates each pair with its view via
  // the sender's webContents id.
  PRELOAD_EVAL_START: "preload.eval:start",
  PRELOAD_EVAL_END: "preload.eval:end",
  PRELOAD_EXPOSE_IN_MAIN_WORLD_START: "preload.exposeInMainWorld:start",
  PRELOAD_EXPOSE_IN_MAIN_WORLD_END: "preload.exposeInMainWorld:end",
} as const;

export type PerfMarkName = (typeof PERF_MARKS)[keyof typeof PERF_MARKS];

/** Non-cryptographic 64-bit fingerprint for correlating terminal lines without recording output. */
export function hashPerfLine(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

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
