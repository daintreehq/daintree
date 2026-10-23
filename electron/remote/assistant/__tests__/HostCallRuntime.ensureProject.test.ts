import { describe, expect, it, vi } from "vitest";
import {
  HostEnsureProjectResultSchema,
  type HostEnsureAnswer,
} from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { AssistantEnsureRequest } from "../../projects/HostSwitchService.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const STUDIO: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "disconnected" },
  lastSeenAt: null,
  summary: null,
};

const READY: HostEnsureAnswer = {
  status: "ready",
  project: {
    projectId: "studio-p1",
    name: "app",
    path: "/Users/me/Projects/app",
    worktreePath: null,
    how: "cloned",
    leftHere: { uncommittedChanges: 0, unpushedCommits: null },
    setupRecipes: [],
    note: null,
  },
};

function runtimeWith(
  ensure: ((request: AssistantEnsureRequest) => Promise<HostEnsureAnswer>) | undefined,
  options: { control?: boolean; running?: boolean } = {}
) {
  const ensureProject = ensure ? vi.fn(ensure) : undefined;
  const runtime = new HostCallRuntime({
    getSessionLane: () => ({ projectId: RUN.projectId, slot: 0 }),
    callerRun: (id) => (options.running === false || id !== "a" ? null : RUN),
    client: () => null,
    hosts: () => [STUDIO],
    inLocalView: () => true,
    controlEnabled: () => options.control !== false,
    ...(ensureProject ? { ensureProject } : {}),
  });
  return { runtime, ensureProject };
}

describe("HostCallRuntime.ensureProject (#14140)", () => {
  it("brings the calling assistant's own project, never one it names", async () => {
    const { runtime, ensureProject } = runtimeWith(async () => READY);

    const result = await runtime.ensureProject("a", {
      hostId: "studio",
      worktree: true,
      accept: ["unpushed"],
    });

    expect(result).toEqual({
      ok: true,
      value: { outcome: "ok", detail: null, retryAfterMs: null, hostId: "studio", answer: READY },
    });
    expect(HostEnsureProjectResultSchema.safeParse(result.ok && result.value).success).toBe(true);
    expect(ensureProject).toHaveBeenCalledWith({
      toHostId: "studio",
      projectId: RUN.projectId,
      worktreePath: null,
      worktree: true,
      copy: null,
      accept: ["unpushed"],
    });
  });

  it("reaches no host whose control switch is off here", async () => {
    const { runtime, ensureProject } = runtimeWith(async () => READY, { control: false });

    const result = await runtime.ensureProject("a", { hostId: "studio" });

    expect(result).toMatchObject({ ok: true, value: { outcome: "opted_out", answer: null } });
    expect(ensureProject).not.toHaveBeenCalled();
  });

  it("refuses a caller that is no assistant running here", async () => {
    const { runtime, ensureProject } = runtimeWith(async () => READY, { running: false });

    await expect(runtime.ensureProject("a", { hostId: "studio" })).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(ensureProject).not.toHaveBeenCalled();
  });

  it("names unknown hosts and this machine as no place to bring it", async () => {
    const { runtime, ensureProject } = runtimeWith(async () => READY);

    await expect(runtime.ensureProject("a", { hostId: "nowhere" })).resolves.toMatchObject({
      value: { outcome: "not_found" },
    });
    await expect(runtime.ensureProject("a", { hostId: "local" })).resolves.toMatchObject({
      value: { outcome: "policy_rejected" },
    });
    expect(ensureProject).not.toHaveBeenCalled();
  });

  it("is unsupported where no switch service is installed", async () => {
    const { runtime } = runtimeWith(undefined);

    await expect(runtime.ensureProject("a", { hostId: "studio" })).resolves.toMatchObject({
      value: { outcome: "unsupported", answer: null },
    });
  });

  it.each([
    ["UNSUPPORTED", "unsupported"],
    ["PERMISSION", "policy_rejected"],
    ["HOST_DISCONNECTED", "disconnected"],
    ["VALIDATION", "conflict"],
    ["OUTCOME_UNKNOWN", "ambiguous"],
  ] as const)("reports a %s failure as %s, in fixed words", async (code, outcome) => {
    const { runtime } = runtimeWith(async () => {
      throw new AppError({ code, message: "/secret/path/on/host" });
    });

    const result = await runtime.ensureProject("a", { hostId: "studio" });

    expect(result).toMatchObject({ ok: true, value: { outcome, answer: null } });
    expect(JSON.stringify(result)).not.toContain("/secret/path");
  });
});
