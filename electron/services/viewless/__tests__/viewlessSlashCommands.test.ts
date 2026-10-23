import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { Project } from "../../../../shared/types/project.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, PROJECT, request } from "./viewlessTestDeps.js";

const OTHER: Project = { ...PROJECT, id: "proj-2", path: "/other", name: "Other" } as Project;

const COMMANDS = [{ id: "/usage", label: "/usage", description: "Usage", scope: "built-in" }];

function depsAnswering() {
  const made = makeDeps({
    getProject: (id) => ({ [PROJECT.id]: PROJECT, [OTHER.id]: OTHER })[id] ?? null,
  });
  made.invoke.mockImplementation(async (_projectId, channel) =>
    channel === CHANNELS.SLASH_COMMANDS_LIST ? COMMANDS : undefined
  );
  return made;
}

/** An agent's slash commands listed on a host nobody has open (#14122). */
describe("viewless slashCommands.list", () => {
  it("lists the bound project's commands for claude by default, through the view's handler", async () => {
    const { deps, invoke } = depsAnswering();

    const result = await executeViewlessAction(request("slashCommands.list", undefined), deps);

    expect(result).toEqual({ ok: true, result: { commands: COMMANDS } });
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.SLASH_COMMANDS_LIST, [
      { agentId: "claude", projectPath: PROJECT.path },
    ]);
  });

  it("reads another of the host's projects by id, the id winning over a path", async () => {
    const { deps, invoke } = depsAnswering();

    const result = await executeViewlessAction(
      request("slashCommands.list", { agentId: "codex", projectId: OTHER.id, projectPath: "/x" }),
      deps
    );

    expect(result).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.SLASH_COMMANDS_LIST, [
      { agentId: "codex", projectPath: OTHER.path },
    ]);
  });

  it("reads the bound project by its own id, ignoring a path beside it", async () => {
    const { deps, invoke } = depsAnswering();

    await executeViewlessAction(
      request("slashCommands.list", { projectId: PROJECT.id, projectPath: "/x" }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.SLASH_COMMANDS_LIST, [
      { agentId: "claude", projectPath: PROJECT.path },
    ]);
  });

  it("takes a path when no id is given", async () => {
    const { deps, invoke } = depsAnswering();

    await executeViewlessAction(request("slashCommands.list", { projectPath: "/elsewhere" }), deps);

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.SLASH_COMMANDS_LIST, [
      { agentId: "claude", projectPath: "/elsewhere" },
    ]);
  });

  it("refuses an unknown project id and an agent with no slash commands, running nothing", async () => {
    const { deps, invoke } = depsAnswering();

    const unknown = await executeViewlessAction(
      request("slashCommands.list", { projectId: "nope" }),
      deps
    );
    const badAgent = await executeViewlessAction(
      request("slashCommands.list", { agentId: "not-an-agent" }),
      deps
    );

    expect(unknown).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(badAgent).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a handler failure as an execution error", async () => {
    const { deps, invoke } = depsAnswering();
    invoke.mockRejectedValue(new Error("boom"));

    const result = await executeViewlessAction(request("slashCommands.list", {}), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });
});
