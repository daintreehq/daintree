import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, PROJECT, request } from "./viewlessTestDeps.js";

/** A host's workspaces, readiness included, listed with nothing open on it (#14122). */
describe("viewless workspace.list", () => {
  it("answers through the view's handler, as the view's action shapes it", async () => {
    const { deps, invoke } = makeDeps();
    const rows = [
      {
        workspaceId: PROJECT.id,
        path: PROJECT.path,
        name: PROJECT.name,
        kind: "project",
        hasLiveView: false,
        frontendAttached: false,
      },
    ];
    invoke.mockImplementation(async (_projectId, channel) =>
      channel === CHANNELS.WORKSPACE_LIST ? rows : undefined
    );

    const result = await executeViewlessAction(request("workspace.list", undefined), deps);

    expect(result).toEqual({ ok: true, result: { workspaces: rows } });
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.WORKSPACE_LIST, []);
  });

  it("reports a handler failure as an execution error", async () => {
    const { deps, invoke } = makeDeps();
    invoke.mockRejectedValue(new Error("db unavailable"));

    const result = await executeViewlessAction(request("workspace.list", undefined), deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("db unavailable") },
    });
  });
});
