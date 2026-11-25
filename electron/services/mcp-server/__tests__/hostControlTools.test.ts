import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindHostControl,
  readHostInventory,
  runHostControlTool,
  setHostControlRuntime,
  type HostControlRuntimeHandle,
} from "../hostControlTools.js";

/** What the fake runtime tells a session it refuses. */
const LACKS_WINDOW = "Host tools need this assistant attached to a window of its project.";

function fakeRuntime() {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  return {
    isCallReachable: vi.fn((helpSessionId: string) => helpSessionId === "hub"),
    callerRefusal: vi.fn((helpSessionId: string) =>
      helpSessionId === "hub" ? null : LACKS_WINDOW
    ),
    list: vi.fn(() => ok({ hosts: [] })),
    call: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, callId: "c", result: null })
    ),
    ensureProject: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, hostId: "h", answer: null })
    ),
    settings: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, ticket: null, hosts: [] })
    ),
    watch: vi.fn(() =>
      ok({
        outcome: "ok" as const,
        detail: null,
        retryAfterMs: null,
        armed: false,
        watches: [],
        observed: null,
      })
    ),
    bringBack: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, answer: null })
    ),
    status: vi.fn(() => ok({ hosts: [], targets: [], terminals: [] })),
  } satisfies HostControlRuntimeHandle;
}

describe("bindHostControl (#13493)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("answers for whichever help session the transport is bound to at each call", async () => {
    const runtime = fakeRuntime();
    uninstall = setHostControlRuntime(runtime);
    let bound: string | undefined = "hub";
    const access = bindHostControl(() => bound);

    expect(access.isCallReachable()).toBe(true);
    await access.run("host.list", {});
    expect(runtime.list).toHaveBeenCalledWith("hub", {});
    await access.run("host.list", { includeAgents: true, projectId: "p1" });
    expect(runtime.list).toHaveBeenLastCalledWith("hub", { includeAgents: true, projectId: "p1" });
    expect(await access.run("host.list", { includeAgents: "yes" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });

    bound = undefined;
    expect(access.isCallReachable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(runtime.list).toHaveBeenCalledTimes(2);
  });

  it("offers nothing once the runtime is gone, and keeps a newer one on a late teardown", async () => {
    const older = setHostControlRuntime(fakeRuntime());
    const access = bindHostControl(() => "hub");
    older();
    expect(access.isCallReachable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });

    const again = setHostControlRuntime(fakeRuntime());
    uninstall = setHostControlRuntime(fakeRuntime());
    again();
    expect(access.isCallReachable()).toBe(true);
  });
});

describe("runHostControlTool (#13493)", () => {
  it("refuses arguments outside the schema, and any retired host tool, in fixed words", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const [missingTool, retired] = await Promise.all([
      runHostControlTool("host.call", { hostId: "h" }, access, { tier: "core" }),
      runHostControlTool(
        "host.sendMessage",
        { hostId: "h", projectId: "p", slot: 0, generation: "g", text: "hi" },
        access
      ),
    ]);
    uninstall();
    expect(missingTool).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: "The arguments don't match this tool's schema: 'tool' is required.",
    });
    expect(retired).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: "The arguments don't match this tool's schema.",
    });
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it("refuses a session that can't call before reading anything it sent (#18164)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "viewless");
    const answers = await Promise.all([
      runHostControlTool("host.status", {}, access, { tier: "full" }),
      runHostControlTool(
        "host.status",
        { targets: [{ hostId: "local", projectId: "p1" }] },
        access,
        { tier: "full" }
      ),
      runHostControlTool("host.call", { hostId: "h" }, access, { tier: "full" }),
      runHostControlTool("host.list", { includeAgents: "yes" }, access),
      runHostControlTool("host.settings", { operation: "read" }, access),
      runHostControlTool("host.watch", "not even an object", access),
      runHostControlTool("host.retired", {}, access),
    ]);
    uninstall();
    for (const answer of answers) {
      expect(answer).toEqual({ ok: false, code: "NOT_ELIGIBLE", message: LACKS_WINDOW });
    }
    expect(runtime.callerRefusal).toHaveBeenCalledWith("viewless");
    for (const method of [runtime.status, runtime.call, runtime.list, runtime.settings]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(runtime.watch).not.toHaveBeenCalled();
  });

  it("names the first field a parse refused, by the schema's own names, never what was sent (#18164)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const lead = "The arguments don't match this tool's schema: ";
    const cases: Array<[string, unknown, string]> = [
      ["host.status", {}, "'targets' is required."],
      ["host.status", { targets: [] }, "'targets' should have at least 1 item."],
      [
        "host.status",
        { targets: [{ hostId: "local", projectId: "p" }, { hostId: "local" }] },
        "'targets[1].projectId' is required.",
      ],
      [
        "host.status",
        { targets: [{ hostId: "local", projectId: "p" }], includeOutput: { lines: 0 } },
        "'includeOutput.lines' should be no less than 1.",
      ],
      ["host.list", { includeAgents: "yes" }, "'includeAgents' should be a boolean."],
      [
        "host.watch",
        { operation: "poll" },
        `'operation' should be one of "arm", "cancel", "list", "read".`,
      ],
      [
        "host.call",
        { hostId: "h", projectId: "p", tool: "t", args: "x" },
        "'args' should be an object.",
      ],
      // A rule across fields says so in its own fixed words.
      [
        "host.call",
        { hostId: "h", tool: "t" },
        "the arguments should name one target: a projectId, or throwaway: true.",
      ],
      [
        "host.call",
        { hostId: "h", projectId: "p", tool: "t", callId: "a", newCallId: "b" },
        "'newCallId' can't be sent with callId.",
      ],
      [
        "host.call",
        { hostId: "studio", projectId: "p", tool: "x".repeat(129) },
        "'tool' should be at most 128 characters on another machine.",
      ],
      // A throwaway call missing a field is told that field, not the throwaway tools.
      [
        "host.call",
        { throwaway: true, tool: "throwaway.launch", args: { agentId: "claude" } },
        "'hostId' is required.",
      ],
      [
        "host.status",
        {
          targets: [
            { hostId: "local", projectId: "p" },
            { hostId: "local", projectId: "p" },
          ],
        },
        "'targets' should name each project once.",
      ],
      [
        "host.status",
        { targets: [{ hostId: "local", projectId: "p" }], includeOutput: "all" },
        "'includeOutput' matches none of its accepted forms.",
      ],
      [
        "host.settings",
        { operation: "apply", ticket: "t", hostIds: ["h"] },
        `these fields don't go together for operation "apply". Each field's description says which operations take it.`,
      ],
      [
        "host.watch",
        { operation: "cancel" },
        `these fields don't go together for operation "cancel". Each field's description says which operations take it.`,
      ],
      ["host.bringBack", "studio", "the arguments should be an object."],
    ];
    for (const [toolId, args, reason] of cases) {
      const answer = await runHostControlTool(toolId, args, access, { tier: "full" });
      expect(answer, `${toolId} ${JSON.stringify(args)}`).toEqual({
        ok: false,
        code: "INVALID_ARGS",
        message: `${lead}${reason}`,
      });
    }

    // A key it doesn't take is named by where it was sent, never by its own name.
    const unknownKey = await runHostControlTool(
      "host.settings",
      { operation: "preview", hostIds: ["h"], patch: { "sk-live-secret": true } },
      access
    );
    expect(unknownKey).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: `${lead}'patch' has a field this tool doesn't take.`,
    });
    // Nor does a bad value repeat itself.
    const badValue = await runHostControlTool(
      "host.settings",
      { operation: "preview", hostIds: ["h"], patch: { canopyMode: "sk-live-secret" } },
      access
    );
    expect(badValue).toMatchObject({ code: "INVALID_ARGS" });
    expect(JSON.stringify(badValue)).not.toContain("sk-live-secret");
    expect(badValue).toMatchObject({
      message: `${lead}'patch.canopyMode' should be one of "unset", "on", "hidden".`,
    });
    uninstall();
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.settings).not.toHaveBeenCalled();
  });

  it("hands host.call to the runtime with the calling session's tier, and never without one", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", projectId: "p", tool: "terminal.list", args: { owned: true } };

    await runHostControlTool("host.call", args, access, { tier: "full" });
    const untiered = await runHostControlTool("host.call", args, access);
    const missing = await runHostControlTool(
      "host.call",
      { hostId: "h", tool: "terminal.list" },
      access,
      { tier: "core" }
    );
    uninstall();
    expect(runtime.call).toHaveBeenCalledTimes(1);
    expect(runtime.call).toHaveBeenCalledWith("hub", args, { tier: "full" });
    expect(untiered).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(missing).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.call exactly one target, and refuses both or neither at the boundary (#14444)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const launch = { tool: "throwaway.launch", args: { agentId: "claude" } };
    const send = (args: Record<string, unknown>) =>
      runHostControlTool("host.call", { hostId: "h", ...args }, access, { tier: "core" });

    const throwaway = await send({ throwaway: true, ...launch });
    const project = await send({ projectId: "p", tool: "terminal.list" });
    const refused = await Promise.all([
      send({ projectId: "p", throwaway: true, ...launch }),
      send(launch),
      send({ throwaway: false, ...launch }),
      // A throwaway target takes only its own tools, with only their own arguments.
      send({ throwaway: true, tool: "terminal.list" }),
      send({ throwaway: true, tool: "throwaway.launch", args: { agentId: "claude", cwd: "/" } }),
      send({ throwaway: true, tool: "throwaway.close" }),
    ]);
    uninstall();
    expect(throwaway).toMatchObject({ ok: true });
    expect(project).toMatchObject({ ok: true });
    expect(runtime.call).toHaveBeenCalledTimes(2);
    expect(runtime.call).toHaveBeenNthCalledWith(
      1,
      "hub",
      { hostId: "h", throwaway: true, ...launch },
      { tier: "core" }
    );
    for (const result of refused) expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    // A throwaway call that doesn't parse names the tools it takes (#14446); others don't.
    const [, neither, notTrue, projectTool] = refused;
    expect(projectTool).toMatchObject({
      message: expect.stringContaining("throwaway.close {runId}"),
    });
    // One that isn't a throwaway call is told what it got wrong, never the throwaway tools.
    expect(neither).toMatchObject({
      message:
        "The arguments don't match this tool's schema: the arguments should name one target: a projectId, or throwaway: true.",
    });
    expect(notTrue).toMatchObject({
      message: "The arguments don't match this tool's schema: 'throwaway' should be true.",
    });
  });

  it("hands host.call the caller's own first-send id, and refuses one sent beside a callId (#14240)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", projectId: "p", tool: "terminal.list", newCallId: "mine-1" };

    await runHostControlTool("host.call", args, access, { tier: "core" });
    const both = await runHostControlTool("host.call", { ...args, callId: "mine-1" }, access, {
      tier: "core",
    });
    const empty = await runHostControlTool("host.call", { ...args, newCallId: "" }, access, {
      tier: "core",
    });
    uninstall();
    expect(runtime.call).toHaveBeenCalledTimes(1);
    expect(runtime.call).toHaveBeenCalledWith("hub", args, { tier: "core" });
    expect(both).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(empty).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.ensureProject its parsed arguments, and refuses ones that don't parse", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", worktree: true, accept: ["unpushed"] };

    await runHostControlTool("host.ensureProject", args, access);
    const bad = await runHostControlTool(
      "host.ensureProject",
      { hostId: "h", accept: ["push"] },
      access
    );
    uninstall();
    expect(runtime.ensureProject).toHaveBeenCalledTimes(1);
    expect(runtime.ensureProject).toHaveBeenCalledWith("hub", args);
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.settings only the arguments its operation takes (#14167)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const preview = { operation: "preview", hostIds: ["h"], patch: { canopyMode: "on" } };

    await runHostControlTool("host.settings", preview, access);
    await runHostControlTool("host.settings", { operation: "apply", ticket: "t" }, access);
    const refused = await Promise.all(
      [
        // An apply carries its ticket and nothing it could swap in for what was approved.
        { operation: "apply", ticket: "t", patch: { canopyMode: "on" } },
        { operation: "apply", ticket: "t", hostIds: ["other"] },
        { operation: "apply" },
        { operation: "preview", hostIds: ["h"], patch: {} },
        { operation: "preview", hostIds: ["h"], patch: { appTheme: "x" } },
        { operation: "read", hostIds: ["h"], ticket: "t" },
        { operation: "read" },
        { operation: "read", hostIds: ["h"], keys: [] },
      ].map((args) => runHostControlTool("host.settings", args, access))
    );
    uninstall();
    expect(runtime.settings).toHaveBeenCalledTimes(2);
    expect(runtime.settings).toHaveBeenCalledWith("hub", preview);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.bringBack a host and nothing else (#16170)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    await runHostControlTool("host.bringBack", { hostId: "studio" }, access);
    expect(runtime.bringBack).toHaveBeenCalledWith("hub", { hostId: "studio" });
    for (const args of [{}, { hostId: "" }, { hostId: 7 }]) {
      expect(await runHostControlTool("host.bringBack", args, access)).toMatchObject({
        ok: false,
        code: "INVALID_ARGS",
      });
    }
    expect(runtime.bringBack).toHaveBeenCalledTimes(1);
    // No assistant session, no attempt.
    expect(
      await runHostControlTool("host.bringBack", { hostId: "studio" }, undefined)
    ).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    uninstall();
  });

  it("hands host.status its targets with the calling session's tier, and never without one (#16191)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = {
      targets: [
        { hostId: "local", projectId: "p1" },
        { hostId: "studio", projectId: "p2", terminalIds: ["t-1"] },
      ],
      includeOutput: true,
    };

    await runHostControlTool("host.status", args, access, { tier: "core" });
    const untiered = await runHostControlTool("host.status", args, access);
    const refused = await Promise.all(
      [
        { targets: [] },
        { targets: [{ hostId: "studio" }] },
        { targets: [{ hostId: "studio", projectId: "p2", terminalIds: [] }] },
        // One read per project: naming it twice is refused, not merged.
        {
          targets: [
            { hostId: "studio", projectId: "p2" },
            { hostId: "studio", projectId: "p2", terminalIds: ["t-1"] },
          ],
        },
        { targets: [{ hostId: "studio", projectId: "p2" }], includeOutput: { lines: 51 } },
        // As the answer writes them: a control character takes six bytes there.
        {
          targets: Array.from({ length: 64 }, (_, index) => ({
            hostId: "studio",
            projectId: `${index}`.padStart(2, "0") + "\u0001".repeat(120),
          })),
        },
        // Every id is echoed back with its outcome, so together they are bounded.
        {
          targets: Array.from({ length: 40 }, (_, index) => ({
            hostId: "studio",
            projectId: `${index}-${"p".repeat(250)}`,
          })),
        },
      ].map((bad) => runHostControlTool("host.status", bad, access, { tier: "core" }))
    );
    // The same project on two hosts is two projects.
    await runHostControlTool(
      "host.status",
      {
        targets: [
          { hostId: "studio", projectId: "p2" },
          { hostId: "mini", projectId: "p2" },
        ],
        includeOutput: { lines: 5 },
      },
      access,
      { tier: "full" }
    );
    uninstall();
    expect(runtime.status).toHaveBeenCalledTimes(2);
    expect(runtime.status).toHaveBeenNthCalledWith(1, "hub", args, { tier: "core" });
    expect(runtime.status).toHaveBeenNthCalledWith(
      2,
      "hub",
      {
        targets: [
          { hostId: "studio", projectId: "p2" },
          { hostId: "mini", projectId: "p2" },
        ],
        includeOutput: { lines: 5, stripAnsi: true },
      },
      { tier: "full" }
    );
    expect(untiered).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.watch one kind of condition to arm, and each operation only its own arguments (#14463)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const accepted = [
      { operation: "arm", hostId: "h", connection: "connected", note: "go", expiresInSeconds: 600 },
      {
        operation: "arm",
        hostId: "h",
        memoryAvailableBytesAtLeast: 1,
        memoryPressureAtMost: "warn",
      },
      { operation: "cancel", watchId: "hw-1" },
      { operation: "list" },
      { operation: "list", hostId: "h" },
    ];
    for (const args of accepted) await runHostControlTool("host.watch", args, access);
    const refused = await Promise.all(
      [
        { operation: "arm", connection: "connected" },
        { operation: "arm", hostId: "h" },
        // A link watch and a capacity watch are two watches.
        { operation: "arm", hostId: "h", connection: "connected", cpuIdleCoresAtLeast: 2 },
        { operation: "arm", hostId: "h", connection: "connected", watchId: "hw-1" },
        { operation: "arm", hostId: "h", connection: "connected", expiresInSeconds: 30 },
        { operation: "arm", hostId: "h", memoryAvailableBytesAtLeast: -1 },
        { operation: "cancel" },
        { operation: "cancel", watchId: "hw-1", hostId: "h" },
        { operation: "cancel", watchId: "hw-1", connection: "connected" },
        { operation: "list", watchId: "hw-1" },
        { operation: "list", note: "x" },
      ].map((args) => runHostControlTool("host.watch", args, access))
    );
    uninstall();
    expect(runtime.watch).toHaveBeenCalledTimes(accepted.length);
    expect(runtime.watch).toHaveBeenCalledWith("hub", accepted[0]);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("arms an agent watch on every host or one, and keeps its filters to it (#16188)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const accepted = [
      { operation: "arm", agentsWaiting: true },
      { operation: "arm", agentsWaiting: true, hostId: "local", waitingReasons: ["any"] },
      {
        operation: "arm",
        agentsWaiting: true,
        hostId: "h",
        projectId: "p1",
        waitingReasons: ["approval", "error"],
        expiresInSeconds: 600,
        note: "cover it",
      },
    ];
    for (const args of accepted) await runHostControlTool("host.watch", args, access);
    const refused = await Promise.all(
      [
        // One watch is one kind of condition.
        { operation: "arm", agentsWaiting: true, connection: "connected", hostId: "h" },
        { operation: "arm", agentsWaiting: true, cpuIdleCoresAtLeast: 2 },
        // Its filters belong to it alone.
        { operation: "arm", hostId: "h", connection: "connected", waitingReasons: ["approval"] },
        { operation: "arm", hostId: "h", connection: "connected", projectId: "p1" },
        { operation: "arm", waitingReasons: ["approval"] },
        { operation: "arm", agentsWaiting: true, waitingReasons: [] },
        { operation: "arm", agentsWaiting: true, waitingReasons: ["maybe"] },
        { operation: "arm", agentsWaiting: false },
        { operation: "cancel", watchId: "hw-1", agentsWaiting: true },
        { operation: "list", projectId: "p1" },
      ].map((args) => runHostControlTool("host.watch", args, access))
    );
    uninstall();
    expect(runtime.watch).toHaveBeenCalledTimes(accepted.length);
    expect(runtime.watch).toHaveBeenCalledWith("hub", accepted[2]);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("arms a plugin notification watch on this machine, and reads one only by its id (#18154)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const id = "0b7a0000-0000-4000-8000-000000000001";
    const accepted = [
      { operation: "arm", pluginNotifications: true },
      {
        operation: "arm",
        pluginNotifications: true,
        projectId: "p1",
        pluginId: "acme.stages",
        expiresInSeconds: 600,
        note: "gates",
      },
      { operation: "read", notificationId: id },
    ];
    for (const args of accepted) await runHostControlTool("host.watch", args, access);
    const refused = await Promise.all(
      [
        // Plugins' notifications are this machine's: no host, and one kind of condition.
        { operation: "arm", pluginNotifications: true, hostId: "h" },
        { operation: "arm", pluginNotifications: true, agentsWaiting: true },
        { operation: "arm", pluginNotifications: true, waitingReasons: ["approval"] },
        { operation: "arm", pluginNotifications: true, connection: "connected" },
        { operation: "arm", pluginNotifications: true, cpuIdleCoresAtLeast: 2 },
        { operation: "arm", pluginNotifications: true, notificationId: id },
        // Its plugin filter belongs to it alone.
        { operation: "arm", agentsWaiting: true, pluginId: "acme.stages" },
        { operation: "arm", hostId: "h", connection: "connected", pluginId: "acme.stages" },
        { operation: "list", pluginId: "acme.stages" },
        { operation: "cancel", watchId: "hw-1", notificationId: id },
        // A read takes its id and nothing else.
        { operation: "read" },
        { operation: "read", notificationId: id, watchId: "hw-1" },
        { operation: "read", notificationId: id, hostId: "h" },
        { operation: "read", notificationId: id, pluginNotifications: true },
        { operation: "read", notificationId: id, projectId: "p1" },
      ].map((args) => runHostControlTool("host.watch", args, access))
    );
    uninstall();
    expect(runtime.watch).toHaveBeenCalledTimes(accepted.length);
    expect(runtime.watch).toHaveBeenCalledWith("hub", accepted[2]);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("refuses with no access at all", async () => {
    await expect(runHostControlTool("host.list", {}, undefined)).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });
});

describe("readHostInventory (#14547)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  function install(runtime: object): void {
    uninstall = setHostControlRuntime(runtime as unknown as HostControlRuntimeHandle);
  }

  it("asks the installed runtime as itself", async () => {
    const snapshot = { takenAt: 1, hosts: [] };
    install({
      snapshot,
      inventory(this: { snapshot: unknown }) {
        return Promise.resolve(this.snapshot);
      },
    });
    await expect(readHostInventory()).resolves.toBe(snapshot);
  });

  it("is null with no runtime, a runtime that can't take one, or one that fails", async () => {
    await expect(readHostInventory()).resolves.toBeNull();
    install({});
    await expect(readHostInventory()).resolves.toBeNull();
    uninstall?.();
    install({ inventory: () => Promise.reject(new Error("boom")) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readHostInventory()).resolves.toBeNull();
    uninstall?.();
    install({
      inventory: () => {
        throw new Error("sync boom");
      },
    });
    await expect(readHostInventory()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
