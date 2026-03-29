import { describe, expect, it } from "vitest";
import { PERF_MARKS } from "../marks.js";

describe("PERF_MARKS", () => {
  it("contains required instrumentation marks", () => {
    expect(PERF_MARKS.APP_BOOT_START).toBe("app_boot_start");
    expect(PERF_MARKS.MAIN_WINDOW_CREATED).toBe("main_window_created");
    expect(PERF_MARKS.RENDERER_READY).toBe("renderer_ready");
    expect(PERF_MARKS.HYDRATE_START).toBe("hydrate_start");
    expect(PERF_MARKS.HYDRATE_COMPLETE).toBe("hydrate_complete");
    expect(PERF_MARKS.PROJECT_SWITCH_START).toBe("project_switch_start");
    expect(PERF_MARKS.PROJECT_SWITCH_END).toBe("project_switch_end");
    expect(PERF_MARKS.WORKTREE_SWITCH_START).toBe("worktree_switch_start");
    expect(PERF_MARKS.WORKTREE_SWITCH_END).toBe("worktree_switch_end");
    expect(PERF_MARKS.DEVPREVIEW_ENSURE_START).toBe("devpreview_ensure_start");
    expect(PERF_MARKS.TERMINAL_DATA_RECEIVED).toBe("terminal_data_received");
    expect(PERF_MARKS.TERMINAL_DATA_PARSED).toBe("terminal_data_parsed");
    expect(PERF_MARKS.TERMINAL_DATA_RENDERED).toBe("terminal_data_rendered");
    expect(PERF_MARKS.IPC_REQUEST_START).toBe("ipc_request_start");
    expect(PERF_MARKS.IPC_REQUEST_END).toBe("ipc_request_end");

    expect(PERF_MARKS.PROJECT_SWITCH_CLEANUP).toBe("project_switch_cleanup");
    expect(PERF_MARKS.PROJECT_SWITCH_LOAD_PROJECT).toBe("project_switch_load_project");
    expect(PERF_MARKS.HYDRATE_BOOTSTRAP).toBe("hydrate_bootstrap");
    expect(PERF_MARKS.HYDRATE_APP_CLIENT).toBe("hydrate_app_client");
    expect(PERF_MARKS.HYDRATE_GET_TERMINALS).toBe("hydrate_get_terminals");
    expect(PERF_MARKS.HYDRATE_RESTORE_SNAPSHOTS_CRITICAL).toBe(
      "hydrate_restore_snapshots_critical"
    );
  });

  it("has unique values", () => {
    const values = Object.values(PERF_MARKS);
    expect(new Set(values).size).toBe(values.length);
  });
});
