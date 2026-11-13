import { describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, validateDisplayImageUrl } from "../sessionServer.js";
import type { TerminalNotifyHandlers } from "../terminalNotify.js";
import type { SessionServerDeps } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import type { McpSessionOrigin } from "../../../../shared/types/ipc/mcpServer.js";
import {
  AgentReadQuotaResultSchema,
  AssistantStartResultSchema,
} from "../../../../shared/types/assistantControl.js";
import {
  AssistantTargetError,
  type AssistantCaller,
  type AssistantTarget,
} from "../../assistants/AssistantTerminalControl.js";
import { TIER_NOT_PERMITTED_CODE } from "../shared.js";
import {
  callHandler,
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  getPrompt,
  callTool,
  listTools,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

describe("skills.search / skills.load short-circuit (#10892)", () => {
  it("dispatches skills.search to the injected handler, not renderer dispatch", async () => {
    const handleSkillsSearch = vi.fn(() => ({
      skills: [
        { id: "acme.plugin.tdd", name: "TDD", description: "Test-driven.", triggers: ["tdd"] },
      ],
    }));
    const dispatchAction = vi.fn();
    // Skills are in the full tool set.
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleSkillsSearch,
      dispatchAction,
    });
    const server = createSessionServer("session-skill-search", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "skills.search", arguments: { query: "tdd" } });

    expect(handleSkillsSearch).toHaveBeenCalledWith({ query: "tdd" });
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      skills: [
        { id: "acme.plugin.tdd", name: "TDD", description: "Test-driven.", triggers: ["tdd"] },
      ],
    });
  });

  it("dispatches skills.load to the injected handler and returns the body", async () => {
    const handleSkillsLoad = vi.fn(() => ({
      id: "acme.plugin.tdd",
      name: "TDD",
      description: "Test-driven.",
      body: "# TDD\n\nRed, green, refactor.",
    }));
    const dispatchAction = vi.fn();
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleSkillsLoad,
      dispatchAction,
    });
    const server = createSessionServer("session-skill-load", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "skills.load",
      arguments: { id: "acme.plugin.tdd" },
    });

    expect(handleSkillsLoad).toHaveBeenCalledWith({ id: "acme.plugin.tdd" });
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { body: string }).body).toContain("Red, green, refactor.");
  });

  it("surfaces a handler McpError as a tool error", async () => {
    const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
    const handleSkillsLoad = vi.fn(() => {
      throw new McpError(ErrorCode.InvalidParams, 'No skill found with id "x".');
    });
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), handleSkillsLoad });
    const server = createSessionServer("session-skill-missing", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: "skills.load", arguments: { id: "x" } })).rejects.toThrow(
      /No skill found/
    );
  });
});

describe("project.runCheck short-circuit (#11548)", () => {
  const passingResult = {
    projectId: "proj-1",
    cwd: "/repo",
    runnerId: "npm-test",
    runnerName: "test",
    command: "npm run test",
    passed: true,
    exitCode: 0,
    signalName: null,
    durationMs: 4200,
    timedOut: false,
    aborted: false,
    output: "42 passing\n",
    outputTruncated: false,
  };

  it("runs in main and never reaches renderer dispatch", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const dispatchAction = vi.fn();
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleProjectRunCheck,
      dispatchAction,
    });
    const server = createSessionServer("session-run-check", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    // The 30s renderer-dispatch wall is exactly what this branch exists to
    // avoid, so reaching dispatchAction at all would defeat the feature.
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(handleProjectRunCheck.mock.calls[0]?.[0]).toEqual({
      projectId: "proj-1",
      runnerId: "npm-test",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(passingResult);
  });

  it("forwards the MCP abort signal so a runaway check can be cancelled", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-signal", deps);
    await server.connect(makeMockTransport());

    await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    const signal = handleProjectRunCheck.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a failing check as a normal result, not a tool error", async () => {
    const failing = { ...passingResult, passed: false, exitCode: 1, output: "1 failing\n" };
    const handleProjectRunCheck = vi.fn().mockResolvedValue(failing);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-fail", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    // "The check failed" and "the check could not run" must stay
    // distinguishable — conflating them makes an agent retry the wrong thing.
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { passed: boolean }).passed).toBe(false);
  });

  it("surfaces an inability to run as a tool error", async () => {
    const handleProjectRunCheck = vi
      .fn()
      .mockRejectedValue(new Error('No runner "nope" detected in /repo.'));
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-unknown", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No runner");
  });

  it("denies a core session — running a project check is in the full tool set only", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("core"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-core", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    expect(result.isError).toBe(true);
    expect(handleProjectRunCheck).not.toHaveBeenCalled();
  });
});

describe("project.runCommand short-circuit (#13495)", () => {
  const ranResult = {
    projectId: "proj-1",
    cwd: "/repo",
    exitCode: 0,
    signalName: null,
    durationMs: 120,
    timedOut: false,
    aborted: false,
    output: "On branch main\n",
    outputTruncated: false,
  };

  function storeWithOrigin(tier: "core" | "full" | "external", origin: McpSessionOrigin) {
    const store = fakeSessionStore(tier);
    (store as unknown as { sessionOriginMap: Map<string, string> }).sessionOriginMap.set(
      "session-run-command",
      origin
    );
    return store;
  }

  async function call(deps: SessionServerDeps) {
    const server = createSessionServer("session-run-command", deps);
    await server.connect(makeMockTransport());
    return callTool(server, {
      name: "project.runCommand",
      arguments: { projectId: "proj-1", command: "git status" },
    });
  }

  it.each(["core", "full"] as const)(
    "runs in main for Daintree's own assistant at the %s tier",
    async (tier) => {
      const handleProjectRunCommand = vi.fn().mockResolvedValue(ranResult);
      const dispatchAction = vi.fn();
      const result = await call(
        fakeDeps({
          sessionStore: storeWithOrigin(tier, "help"),
          handleProjectRunCommand,
          dispatchAction,
        })
      );

      expect(dispatchAction).not.toHaveBeenCalled();
      expect(handleProjectRunCommand.mock.calls[0]?.[0]).toEqual({
        projectId: "proj-1",
        command: "git status",
      });
      expect(handleProjectRunCommand.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(ranResult);
    }
  );

  it("returns a non-zero exit as a result, not a tool error", async () => {
    const handleProjectRunCommand = vi
      .fn()
      .mockResolvedValue({ ...ranResult, exitCode: 128, output: "fatal: not a git repository\n" });
    const result = await call(
      fakeDeps({ sessionStore: storeWithOrigin("full", "help"), handleProjectRunCommand })
    );

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { exitCode: number }).exitCode).toBe(128);
  });

  it("refuses a full-tier session that is not the assistant, such as a worker pane", async () => {
    const handleProjectRunCommand = vi.fn().mockResolvedValue(ranResult);
    const result = await call(
      fakeDeps({ sessionStore: storeWithOrigin("full", "external"), handleProjectRunCommand })
    );

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(handleProjectRunCommand).not.toHaveBeenCalled();
  });

  // A pane's grant is reachable and its tier is an approval line (#12692), so
  // this is the caller a grant or an ask would most plausibly let through.
  it("refuses a worker pane even when a grant admits the call, and never asks", async () => {
    const handleProjectRunCommand = vi.fn().mockResolvedValue(ranResult);
    const requestApproval = vi.fn();
    const sessionStore = storeWithOrigin("core", "external");
    sessionStore.grantCache.issueGrant("session-run-command", "project.runCommand");
    const result = await call(fakeDeps({ sessionStore, handleProjectRunCommand, requestApproval }));

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(handleProjectRunCommand).not.toHaveBeenCalled();
  });

  it("spends no grant's use on a caller it refuses", async () => {
    const handleProjectRunCommand = vi.fn().mockResolvedValue(ranResult);
    const sessionStore = storeWithOrigin("core", "external");
    sessionStore.grantCache.issueGrant("session-run-command", "project.runCommand");
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "session-run-command",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["project.runCommand"],
      maxUses: 1,
    });
    const consume = vi.spyOn(sessionStore.grantCache, "consumeNativeGrantUse");
    const result = await call(fakeDeps({ sessionStore, handleProjectRunCommand }));

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(consume).not.toHaveBeenCalled();
    expect(handleProjectRunCommand).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("surfaces a command that could not start as a tool error", async () => {
    const handleProjectRunCommand = vi
      .fn()
      .mockRejectedValue(new Error("/elsewhere is not the project root or one of its worktrees."));
    const result = await call(
      fakeDeps({ sessionStore: storeWithOrigin("full", "help"), handleProjectRunCommand })
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not the project root");
  });
});

describe("validateDisplayImageUrl (#9828)", () => {
  it("accepts an https://daintree.org apex image URL", () => {
    expect(validateDisplayImageUrl("https://daintree.org/docs/img/panel.png")).toEqual({
      valid: true,
    });
  });

  it("accepts an https subdomain of daintree.org", () => {
    expect(validateDisplayImageUrl("https://docs.daintree.org/img/panel.png")).toEqual({
      valid: true,
    });
  });

  it("rejects data: URIs", () => {
    const result = validateDisplayImageUrl("data:image/png;base64,iVBORw0KGgo=");
    expect(result.valid).toBe(false);
  });

  it("rejects blob: URIs", () => {
    const result = validateDisplayImageUrl("blob:https://daintree.org/abcd");
    expect(result.valid).toBe(false);
  });

  it("rejects http: (non-TLS) URLs", () => {
    const result = validateDisplayImageUrl("http://daintree.org/img.png");
    expect(result.valid).toBe(false);
  });

  it("rejects a look-alike host that merely ends with the brand string", () => {
    // `attackerdaintree.org` does NOT end with `.daintree.org` (no leading
    // dot), so the suffix check correctly refuses it.
    const result = validateDisplayImageUrl("https://attackerdaintree.org/img.png");
    expect(result.valid).toBe(false);
  });

  it("rejects an unrelated host", () => {
    expect(validateDisplayImageUrl("https://evil.example.com/img.png").valid).toBe(false);
  });

  it("rejects a non-standard port (CSP allows the default 443 only)", () => {
    expect(validateDisplayImageUrl("https://daintree.org:8443/img.png").valid).toBe(false);
  });

  it("accepts an explicit default :443 port", () => {
    expect(validateDisplayImageUrl("https://daintree.org:443/img.png")).toEqual({ valid: true });
  });

  it("rejects a malformed URL", () => {
    expect(validateDisplayImageUrl("not a url").valid).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(validateDisplayImageUrl("https://DainTree.ORG/img.png")).toEqual({ valid: true });
  });
});

describe("help.displayImage short-circuit (#9828)", () => {
  function helpSessionStore(sessionId: string, helpSessionId: string | null): SessionStore {
    const store = fakeSessionStore("core");
    const mutable = store as unknown as {
      sessionHelpIdMap: Map<string, string>;
      figureCounters: Map<string, number>;
      nextFigureNumber: (id: string) => number;
    };
    mutable.sessionHelpIdMap = new Map(helpSessionId !== null ? [[sessionId, helpSessionId]] : []);
    mutable.figureCounters = new Map();
    mutable.nextFigureNumber = (id: string) => {
      const next = (mutable.figureCounters.get(id) ?? 0) + 1;
      mutable.figureCounters.set(id, next);
      return next;
    };
    return store;
  }

  function parseStructured(result: unknown): Record<string, unknown> | undefined {
    return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  }

  it("assigns a sequential figure number and pushes the figure to the renderer", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-1", "help-1"),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-1", deps);
    await server.connect(makeMockTransport());

    const first = await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/a.png", caption: "First" },
    });
    const second = await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/b.png" },
    });

    expect(parseStructured(first)).toMatchObject({ figureNumber: 1, figureLabel: "image #1" });
    expect(parseStructured(second)).toMatchObject({ figureNumber: 2, figureLabel: "image #2" });
    expect(notifyDisplayImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        figureNumber: 1,
        url: "https://daintree.org/a.png",
        caption: "First",
      })
    );
    // The imageId is a freshly minted UUID, distinct per call.
    const id1 = parseStructured(first)?.imageId;
    const id2 = parseStructured(second)?.imageId;
    expect(typeof id1).toBe("string");
    expect(id1).not.toBe(id2);
  });

  it("refuses with no view to show the figure, spending no figure number (#13511)", async () => {
    const notifyDisplayImage = vi.fn();
    const store = helpSessionStore("sess-nv", "help-nv");
    store.sessionViewlessHelpMap.set("sess-nv", "proj-1");
    const deps = fakeDeps({ sessionStore: store, notifyDisplayImage });
    const server = createSessionServer("sess-nv", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/a.png" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("NO_FRONTEND_ATTACHED");
    expect(notifyDisplayImage).not.toHaveBeenCalled();
    expect(store.nextFigureNumber("help-nv")).toBe(1);
  });

  it("refuses the global assistant every tool but its root ones, whichever handler would answer (#14159)", async () => {
    const dispatchAction = vi.fn();
    const store = helpSessionStore("sess-global", "help-global");
    store.sessionViewlessHelpMap.set("sess-global", GLOBAL_ASSISTANT_ID);
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("sess-global", deps);
    await server.connect(makeMockTransport());

    for (const name of ["terminal.waitUntilIdle", "assistant.list", "agent.readQuota"]) {
      const result = (await callTool(server, { name, arguments: {} })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe("NO_FRONTEND_ATTACHED");
    }
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("rejects a non-daintree URL with INVALID_URL and does not notify", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-2", "help-2"),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-2", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "data:image/png;base64,AAAA" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("INVALID_URL");
    expect(notifyDisplayImage).not.toHaveBeenCalled();
  });

  it("rejects a session with no help-session id (e.g. pane token) as not permitted", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-3", null),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-3", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/a.png" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("TIER_NOT_PERMITTED");
    expect(notifyDisplayImage).not.toHaveBeenCalled();
  });
});

describe("host control tools (#13493)", () => {
  const LISTED = { hosts: [] };

  function hubDeps(options: { reachable: boolean; tier?: "core" | "full"; access?: boolean }) {
    const store = fakeSessionStore(options.tier ?? "core");
    const mutable = store as unknown as {
      sessionHelpIdMap: Map<string, string>;
      sessionOriginMap: Map<string, string>;
    };
    mutable.sessionHelpIdMap = new Map([["sess", "hub"]]);
    mutable.sessionOriginMap.set("sess", "help");
    const access = {
      isCallReachable: vi.fn(() => options.reachable),
      run: vi.fn(async () => ({ ok: true as const, value: LISTED })),
    };
    const deps = fakeDeps({
      sessionStore: store,
      requestManifest: vi
        .fn()
        .mockResolvedValue([
          makeManifestEntry("host.list"),
          makeManifestEntry("host.call"),
          makeManifestEntry("terminal.list"),
        ]),
      ...(options.access === false ? {} : { hostControl: access as never }),
    });
    return { deps, access };
  }

  it("lists them to one of this machine's assistants, from the core tier up, and no one else", async () => {
    for (const tier of ["core", "full"] as const) {
      const { deps } = hubDeps({ reachable: true, tier });
      const server = createSessionServer("sess", deps);
      await server.connect(makeMockTransport());
      expect((await listTools(server)).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["host.list", "host.call"])
      );
    }
    const { deps } = hubDeps({ reachable: false, tier: "full" });
    const server = createSessionServer("sess", deps);
    await server.connect(makeMockTransport());
    const names = (await listTools(server)).tools.map((t) => t.name);
    expect(names).toContain("terminal.list");
    expect(names).not.toContain("host.list");
    expect(names).not.toContain("host.call");
  });

  it("runs host.list in main", async () => {
    const { deps, access } = hubDeps({ reachable: true });
    const server = createSessionServer("sess", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "host.list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(LISTED);
    expect(access.run).toHaveBeenCalledWith("host.list", {});
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("lists and runs only host.list and host.call for the global assistant (#14161)", async () => {
    const { deps, access } = hubDeps({ reachable: true, tier: "full" });
    deps.sessionStore.sessionViewlessHelpMap.set("sess", GLOBAL_ASSISTANT_ID);
    vi.mocked(deps.requestManifest).mockResolvedValue([
      makeManifestEntry("host.list"),
      makeManifestEntry("host.call"),
      makeManifestEntry("host.ensureProject"),
      makeManifestEntry("terminal.list"),
      makeManifestEntry("terminal.sendCommandOwned"),
    ]);
    const server = createSessionServer("sess", deps);
    await server.connect(makeMockTransport());

    expect((await listTools(server)).tools.map((t) => t.name).sort()).toEqual([
      "host.call",
      "host.list",
    ]);
    const listed = await callTool(server, { name: "host.list", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(access.run).toHaveBeenCalledWith("host.list", {});
    for (const name of ["host.ensureProject", "terminal.list", "terminal.sendCommandOwned"]) {
      const refused = await callTool(server, { name, arguments: { terminalId: "t-1" } });
      expect(refused.isError).toBe(true);
      expect(toolErrorPayload(refused).code).toBe("NO_FRONTEND_ATTACHED");
    }
    expect(access.run).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses a session with no host access, whatever admitted it", async () => {
    const { deps } = hubDeps({ reachable: true, access: false });
    const server = createSessionServer("sess", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "host.list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe("NOT_ELIGIBLE");
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });
});

describe("one assistant addressing another (#13496)", () => {
  const ASSISTANT_TERMINAL = "terminal-assistant";
  const CALLER: AssistantCaller = {
    kind: "local",
    helpSessionId: "hub",
    projectId: "proj-1",
    machineName: "studio-01",
  };
  const TARGET: AssistantTarget = {
    scope: "project",
    projectId: "proj-1",
    slot: 1,
    sessionId: "session-1",
    terminalId: ASSISTANT_TERMINAL,
    attached: true,
  };
  const GLOBAL_TERMINAL = "terminal-global";
  const GLOBAL_TARGET: AssistantTarget = {
    scope: "global",
    projectId: GLOBAL_ASSISTANT_ID,
    slot: 0,
    sessionId: "global-session",
    terminalId: GLOBAL_TERMINAL,
    attached: false,
  };
  const LISTED = {
    projectId: "proj-1",
    assistants: [],
    vacantSlots: [2, 3],
    keptSlots: [{ slot: 1, agentId: "claude", capturedAt: 1_000 }],
    global: null,
  };
  const RESUMED = {
    assistant: {
      terminalId: "t-resumed",
      generation: 2,
      slot: 2,
      agentId: "claude",
      agentState: "waiting" as const,
      waitingReason: "prompt" as const,
      attached: false,
      startedByYou: true,
    },
    ready: true,
    notReadyReason: null,
  };
  const RECEIPT = {
    terminalId: ASSISTANT_TERMINAL,
    submissionToken: "tok-1",
    command: "Run the suite",
  };

  function assistantDeps(options: {
    caller: AssistantCaller | null;
    origin?: string;
    tier?: "core" | "full" | "external";
    relay?: boolean;
    refuseWrite?: { code: string; message: string } | null;
    requestCloseApproval?: SessionServerDeps["requestCloseApproval"];
  }) {
    const store = fakeSessionStore(options.tier ?? "core");
    const mutable = store as unknown as {
      sessionHelpIdMap: Map<string, string>;
      sessionOriginMap: Map<string, string>;
    };
    mutable.sessionHelpIdMap = new Map([["sess", "hub"]]);
    mutable.sessionOriginMap.set("sess", options.origin ?? "help");
    const control = {
      isAssistantTerminal: vi.fn(
        (terminalId: string) => terminalId === ASSISTANT_TERMINAL || terminalId === GLOBAL_TERMINAL
      ),
      resolve: vi.fn((_caller: AssistantCaller, terminalId: string): AssistantTarget | null =>
        terminalId === ASSISTANT_TERMINAL
          ? TARGET
          : terminalId === GLOBAL_TERMINAL
            ? GLOBAL_TARGET
            : null
      ),
      list: vi.fn(async () => LISTED),
      start: vi.fn(async () => ({ assistant: {}, ready: true, notReadyReason: null })),
      resume: vi.fn(async () => RESUMED),
      submit: vi.fn(async () => RECEIPT),
      sendKeys: vi.fn(async () => ({ terminalId: ASSISTANT_TERMINAL, keys: ["Enter"] })),
      interrupt: vi.fn(async () => ({
        terminalId: ASSISTANT_TERMINAL,
        agentId: "codex",
        agentStateAtDispatch: "working",
        status: "requested" as const,
      })),
      close: vi.fn(async () => ({ closedIds: [ASSISTANT_TERMINAL] })),
      readReply: vi.fn(async () => ({
        status: "observed" as const,
        source: "handback" as const,
        text: "done",
        truncated: false,
      })),
    };
    const deps = fakeDeps({
      sessionStore: store,
      requestManifest: vi
        .fn()
        .mockResolvedValue(
          [
            "assistant.list",
            "assistant.start",
            "assistant.resume",
            "agent.readQuota",
            "terminal.sendCommand",
            "terminal.sendCommandOwned",
            "terminal.sendCommandMany",
            "terminal.sendKeys",
            "terminal.closeOwned",
            "terminal.close",
            "terminal.closeMany",
            "terminal.interruptOwned",
            "terminal.readLastMessageOwned",
            "terminal.getStatus",
            "terminal.getOutput",
            "terminal.waitUntilIdle",
            "terminal.waitUntilIdleBatch",
            "terminal.notifyWhenIdle",
            "terminal.list",
          ].map(makeManifestEntry)
        ),
      ...(options.requestCloseApproval !== undefined
        ? { requestCloseApproval: options.requestCloseApproval }
        : {}),
      assistantControl: control as never,
      assistantCaller: () => options.caller,
      readCodexQuota: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "cli-missing" as const,
        fetchedAt: 3,
      })),
      ...(options.relay
        ? {
            relay: {
              shellName: "studio-01",
              refuseWrite: vi.fn(() => options.refuseWrite ?? null),
            },
          }
        : {}),
    });
    return { deps, control };
  }

  async function serve(deps: SessionServerDeps) {
    const server = createSessionServer("sess", deps);
    await server.connect(makeMockTransport());
    return server;
  }

  it("lists the assistant tools only to an assistant caller", async () => {
    const assistant = await serve(assistantDeps({ caller: CALLER }).deps);
    expect((await listTools(assistant)).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "assistant.list",
        "assistant.start",
        "assistant.resume",
        "agent.readQuota",
      ])
    );

    const pane = await serve(
      assistantDeps({ caller: null, origin: "external", tier: "full" }).deps
    );
    const names = (await listTools(pane)).tools.map((t) => t.name);
    expect(names).not.toContain("assistant.list");
    expect(names).not.toContain("assistant.start");
    expect(names).not.toContain("assistant.resume");
    expect(names).not.toContain("agent.readQuota");
  });

  it("runs assistant.list and agent.readQuota in main for the caller", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);

    const listed = await callTool(server, { name: "assistant.list", arguments: {} });
    expect(listed.structuredContent).toEqual(LISTED);
    expect(control.list).toHaveBeenCalledWith(CALLER);

    const quota = await callTool(server, { name: "agent.readQuota", arguments: {} });
    // No pane has shown a Claude usage message, and the answer says so.
    expect(quota.structuredContent).toEqual({
      claude: { source: "seen-in-panes", readings: [] },
      codex: { status: "unavailable", reason: "cli-missing", fetchedAt: 3 },
    });
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("resumes a kept slot in main for the caller, refusing a call that names none (#16763)", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);

    const resumed = await callTool(server, { name: "assistant.resume", arguments: { slot: 2 } });
    expect(resumed.isError).toBeFalsy();
    expect(resumed.structuredContent).toEqual(RESUMED);
    expect(AssistantStartResultSchema.safeParse(resumed.structuredContent).success).toBe(true);
    expect(control.resume).toHaveBeenCalledExactlyOnceWith(CALLER, { slot: 2 });

    for (const args of [{}, { slot: 99 }, { slot: "2" }]) {
      const refused = await callTool(server, { name: "assistant.resume", arguments: args });
      expect(toolErrorPayload(refused).code).toBe("VALIDATION_ERROR");
    }
    expect(control.resume).toHaveBeenCalledTimes(1);

    control.resume.mockRejectedValueOnce(
      new AssistantTargetError("ASSISTANT_RESUME_REFUSED", "Slot 3 keeps no conversation.")
    );
    const none = await callTool(server, { name: "assistant.resume", arguments: { slot: 3 } });
    expect(toolErrorPayload(none).code).toBe("ASSISTANT_RESUME_REFUSED");
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("answers agent.readQuota with the Claude usage messages this machine's panes showed (#15727)", async () => {
    const { deps } = assistantDeps({ caller: CALLER });
    const readings = [
      {
        window: "weekly limit" as const,
        statement: "used" as const,
        usedPercent: 87,
        resetsAt: 1_793_602_800_000,
        terminalId: "t-worker",
        observedAt: 1_793_574_000_000,
      },
    ];
    deps.readClaudeUsage = vi.fn(() => readings);
    const server = await serve(deps);

    const quota = await callTool(server, { name: "agent.readQuota", arguments: {} });
    expect(quota.structuredContent).toEqual({
      claude: { source: "seen-in-panes", readings },
      codex: { status: "unavailable", reason: "cli-missing", fetchedAt: 3 },
    });
    expect(AgentReadQuotaResultSchema.safeParse(quota.structuredContent).success).toBe(true);
  });

  it("refuses the assistant tools to anyone else, whatever its tier", async () => {
    const { deps, control } = assistantDeps({ caller: null, origin: "external", tier: "full" });
    const server = await serve(deps);
    for (const name of [
      "assistant.list",
      "assistant.start",
      "assistant.resume",
      "agent.readQuota",
    ]) {
      const result = await callTool(server, {
        name,
        arguments: name === "assistant.resume" ? { slot: 0 } : {},
      });
      expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    }
    expect(control.list).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
  });

  it("describes the assistant tools to a relayed assistant's schema read, and withholds what it can't call", async () => {
    const { deps } = assistantDeps({
      caller: { ...CALLER, kind: "relay", senderId: "s", linkSessionId: "l" } as AssistantCaller,
      origin: "external",
      tier: "full",
      relay: true,
    });
    const listed = (await deps.requestManifest()) as ActionManifestEntry[];
    deps.requestManifest = vi
      .fn()
      .mockResolvedValue([...listed, makeManifestEntry("actions.getSchema")]);
    deps.dispatchAction = vi.fn(async (_actionId: string, args: unknown) => ({
      result: {
        ok: true,
        result: {
          ok: true,
          entry: makeManifestEntry((args as { actionId: string }).actionId),
          policy: null,
          error: null,
        },
      },
    })) as unknown as SessionServerDeps["dispatchAction"];
    const server = await serve(deps);
    const schemaOf = async (actionId: string) => {
      const res = await callTool(server, { name: "actions.getSchema", arguments: { actionId } });
      const [first] = res.content as Array<{ text: string }>;
      return JSON.parse(first!.text) as {
        ok: boolean;
        entry: unknown;
        policy: { callable: boolean; minimumTier: string } | null;
        error: { code: string; message: string } | null;
      };
    };

    for (const id of ["assistant.list", "assistant.start", "assistant.resume", "agent.readQuota"]) {
      expect(await schemaOf(id), id).toMatchObject({
        ok: true,
        policy: { callable: true, minimumTier: "core" },
      });
    }
    // The unscoped send is withheld from a relay: never described, whoever
    // answers, but the miss names the owned form it may call instead.
    const withheld = await schemaOf("terminal.sendCommand");
    expect(withheld).toMatchObject({
      ok: false,
      entry: null,
      policy: null,
      error: { code: "NOT_FOUND" },
    });
    expect(withheld.error?.message).toContain('"terminal.sendCommandOwned"');
  });

  it("refuses a relayed start the drive rule refuses, starting nothing", async () => {
    const { deps, control } = assistantDeps({
      caller: { ...CALLER, kind: "relay", senderId: "s", linkSessionId: "l" } as AssistantCaller,
      origin: "external",
      relay: true,
      refuseWrite: { code: "DRIVEN_ELSEWHERE", message: "Another machine drives it." },
    });
    const server = await serve(deps);
    const result = await callTool(server, { name: "assistant.start", arguments: {} });
    expect(toolErrorPayload(result).code).toBe("DRIVEN_ELSEWHERE");
    expect(control.start).not.toHaveBeenCalled();
    const resumed = await callTool(server, { name: "assistant.resume", arguments: { slot: 1 } });
    expect(toolErrorPayload(resumed).code).toBe("DRIVEN_ELSEWHERE");
    expect(control.resume).not.toHaveBeenCalled();
  });

  it("sends to an assistant in main, with the generation and handback it was given", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: {
        terminalId: ASSISTANT_TERMINAL,
        command: "Run the suite",
        handback: true,
        generation: 4,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(control.submit).toHaveBeenCalledWith(CALLER, TARGET, {
      command: "Run the suite",
      generation: 4,
      handback: true,
    });
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("presses keys in an assistant in main, with the generation it was given", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.sendKeys",
      arguments: { terminalId: ASSISTANT_TERMINAL, keys: ["Enter"], generation: 4 },
    });
    expect(result.isError).toBeFalsy();
    expect(control.sendKeys).toHaveBeenCalledWith(CALLER, TARGET, {
      keys: ["Enter"],
      choose: undefined,
      generation: 4,
    });
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("passes an assistant's refusal on in its own words", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    control.submit.mockRejectedValueOnce(
      new AssistantTargetError("ASSISTANT_BUSY", "The assistant is mid-turn. Nothing was sent.")
    );
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: ASSISTANT_TERMINAL, command: "x", generation: 4 },
    });
    expect(toolErrorPayload(result).code).toBe("ASSISTANT_BUSY");
  });

  describe("a send held for a busy assistant (#16620)", () => {
    const RELAYED = {
      ...CALLER,
      kind: "relay",
      senderId: "s",
      linkSessionId: "l",
    } as AssistantCaller;
    const relayed = (refuseWrite: { code: string; message: string } | null = null) =>
      assistantDeps({ caller: RELAYED, origin: "external", relay: true, refuseWrite });
    const heldBy = (control: ReturnType<typeof assistantDeps>["control"]) =>
      (
        control.submit.mock.calls[0] as unknown as [
          unknown,
          unknown,
          {
            whenBusy?: {
              queue: { ttlSeconds: number };
              authorize(): { code: string; message: string } | null;
            };
          },
        ]
      )[2].whenBusy;

    it("forwards a relayed owned send's `whenBusy` and its time, under the drive rule", async () => {
      const { deps, control } = relayed();
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: ASSISTANT_TERMINAL,
          command: "Run the suite",
          generation: 4,
          whenBusy: "queue",
          queueTtlSeconds: 120,
        },
      });
      expect(result.isError).toBeFalsy();
      const whenBusy = heldBy(control)!;
      expect(whenBusy.queue).toEqual({ ttlSeconds: 120 });
      // Asked again when the held line is written, of the target's project.
      const refuseWrite = deps.relay!.refuseWrite as ReturnType<typeof vi.fn>;
      expect(whenBusy.authorize()).toBeNull();
      const driven = { code: "DRIVEN_ELSEWHERE", message: "Another machine drives it." };
      refuseWrite.mockReturnValue(driven);
      expect(whenBusy.authorize()).toEqual(driven);
      expect(refuseWrite).toHaveBeenLastCalledWith(TARGET.projectId);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("forwards none without `queue`, or on the unowned send", async () => {
      const owned = relayed();
      await callTool(await serve(owned.deps), {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: ASSISTANT_TERMINAL,
          command: "x",
          generation: 4,
          whenBusy: "refuse",
        },
      });
      expect(heldBy(owned.control)).toBeUndefined();

      // A send within the project, or up to the global, stays refuse-only.
      for (const terminalId of [ASSISTANT_TERMINAL, GLOBAL_TERMINAL]) {
        const local = assistantDeps({ caller: CALLER });
        await callTool(await serve(local.deps), {
          name: "terminal.sendCommand",
          arguments: { terminalId, command: "x", generation: 4, whenBusy: "queue" },
        });
        expect(local.control.submit, terminalId).toHaveBeenCalledTimes(1);
        expect(heldBy(local.control), terminalId).toBeUndefined();
      }
    });

    it("refuses what it can't hold, sending nothing", async () => {
      const { deps, control } = relayed();
      const server = await serve(deps);
      for (const [args, pattern] of [
        [{ whenBusy: "queue", waitForReply: true }, /waitForReply/],
        [{ queueTtlSeconds: 600 }, /goes only with/],
        [{ whenBusy: "queue", queueTtlSeconds: 5 }, /from 60 to 3600/],
        [{ whenBusy: "later" }, /`refuse` or `queue`/],
      ] as const) {
        const result = await callTool(server, {
          name: "terminal.sendCommandOwned",
          arguments: { terminalId: ASSISTANT_TERMINAL, command: "x", generation: 4, ...args },
        });
        const payload = toolErrorPayload(result);
        expect(payload.code, JSON.stringify(args)).toBe("VALIDATION_ERROR");
        expect(payload.message).toMatch(pattern);
      }
      expect(control.submit).not.toHaveBeenCalled();
    });

    it("hands the call's notice to the held send, and leaves older ones until it is written", async () => {
      const pending = { complete: vi.fn(), cancel: vi.fn() };
      const handlers = {
        whenIdle: vi.fn(),
        prepareSend: vi.fn().mockResolvedValue(pending),
        prepareLaunch: vi.fn(),
        prepareKeys: vi.fn(),
        forgetTarget: vi.fn(),
        holdTarget: vi.fn(),
        settleTargetHold: vi.fn(),
        supersede: vi.fn(),
        releaseHold: vi.fn(),
      } satisfies TerminalNotifyHandlers;
      const pane = { key: "relay\u0000p", terminalId: "relay\u0000p" };
      const held = {
        sent: false,
        queued: true,
        terminalId: ASSISTANT_TERMINAL,
        command: "x",
        queuedSendToken: "held-1",
        expiresAt: 9_000,
        message: "Held, not sent.",
      };
      const { deps, control } = relayed();
      let taken: unknown;
      control.submit.mockImplementation((async (
        _caller: unknown,
        _target: unknown,
        request: { whenBusy?: { takeNotice?: () => unknown } }
      ) => {
        taken = request.whenBusy?.takeNotice?.();
        return held;
      }) as never);
      const server = await serve({ ...deps, terminalNotify: handlers, resolveOwnPane: () => pane });

      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: ASSISTANT_TERMINAL,
          command: "x",
          generation: 4,
          whenBusy: "queue",
          notify: true,
        },
      });
      expect(result.isError).toBeFalsy();
      // The call ended without settling its notice: the held send has it.
      expect(taken).toBe(pending);
      expect(pending.complete).not.toHaveBeenCalled();
      expect(pending.cancel).not.toHaveBeenCalled();

      // Without a notice, what the pane heard about the assistant goes stale once written, not now.
      control.submit.mockImplementation((async () => held) as never);
      await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: ASSISTANT_TERMINAL,
          command: "y",
          generation: 4,
          whenBusy: "queue",
        },
      });
      expect(handlers.supersede).not.toHaveBeenCalled();
      (
        control.submit.mock.calls[1] as unknown as [
          unknown,
          unknown,
          { whenBusy: { onWritten(): void } },
        ]
      )[2].whenBusy.onWritten();
      expect(handlers.supersede).toHaveBeenCalledWith(pane, ASSISTANT_TERMINAL);
    });

    it("answers with the held receipt", async () => {
      const { deps, control } = relayed();
      control.submit.mockResolvedValueOnce({
        sent: false,
        queued: true,
        terminalId: ASSISTANT_TERMINAL,
        command: "x",
        queuedSendToken: "held-1",
        expiresAt: 9_000,
        message: "Held, not sent.",
      } as never);
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: ASSISTANT_TERMINAL,
          command: "x",
          generation: 4,
          whenBusy: "queue",
        },
      });
      expect(result.isError).toBeFalsy();
      const [first] = result.content as Array<{ text: string }>;
      expect(JSON.parse(first!.text)).toMatchObject({ queued: true, queuedSendToken: "held-1" });
    });
  });

  it("routes a relayed owned close, interrupt and read to the assistant, past the ledger", async () => {
    const { deps, control } = assistantDeps({
      caller: { ...CALLER, kind: "relay", senderId: "s", linkSessionId: "l" } as AssistantCaller,
      origin: "external",
      relay: true,
    });
    const server = await serve(deps);
    const args = { terminalId: ASSISTANT_TERMINAL };
    expect(
      (await callTool(server, { name: "terminal.closeOwned", arguments: args })).isError
    ).toBeFalsy();
    expect(
      (await callTool(server, { name: "terminal.interruptOwned", arguments: args })).isError
    ).toBeFalsy();
    const read = await callTool(server, {
      name: "terminal.readLastMessageOwned",
      arguments: args,
    });
    const [first] = read.content as Array<{ text: string }>;
    expect(JSON.parse(first!.text)).toMatchObject({ status: "observed", text: "done" });
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(control.interrupt).toHaveBeenCalledTimes(1);
    expect(control.readReply).toHaveBeenCalledWith(TARGET, expect.any(Number));
    expect(deps.handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("reads an assistant's status off the pty-host, admitting only what it named", async () => {
    const { deps } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);
    await callTool(server, {
      name: "terminal.getStatus",
      arguments: { terminalIds: [ASSISTANT_TERMINAL, "terminal-pane"] },
    });
    expect(deps.handleTerminalGetStatusViewless).toHaveBeenCalledWith(
      { terminalIds: [ASSISTANT_TERMINAL, "terminal-pane"] },
      "proj-1",
      new Set([ASSISTANT_TERMINAL]),
      undefined
    );
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal.sendCommandOwned", { terminalId: ASSISTANT_TERMINAL, command: "x" }],
    ["terminal.closeOwned", { terminalId: ASSISTANT_TERMINAL }],
    ["terminal.getStatus", { terminalIds: [ASSISTANT_TERMINAL] }],
    ["terminal.waitUntilIdle", { terminalId: ASSISTANT_TERMINAL }],
    // Read off the pty-host by id, past any view's panels.
    ["terminal.getOutput", { terminalId: ASSISTANT_TERMINAL }],
  ])("answers a worker pane naming an assistant in %s as no such terminal", async (name, args) => {
    const { deps, control } = assistantDeps({ caller: null, origin: "external", tier: "full" });
    const server = await serve(deps);
    const result = await callTool(server, { name, arguments: args });
    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe("NOT_FOUND");
    expect(control.submit).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
    expect(deps.handleWaitUntilIdle).not.toHaveBeenCalled();
    expect(deps.handleTerminalGetStatusViewless).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("notes the incarnation an assistant close reached, not one launched while it ran (#15728)", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    let generation = 5;
    deps.terminalGenerationOf = () => generation;
    control.close.mockImplementation(async () => {
      generation = 6;
      return { closedIds: [ASSISTANT_TERMINAL] };
    });
    deps.sessionStore.resourceOwnership.bindPrincipal("sess", "help-hub");
    const server = await serve(deps);

    await callTool(server, {
      name: "terminal.close",
      arguments: { terminalId: ASSISTANT_TERMINAL },
    });

    const owner = deps.sessionStore.resourceOwnership.ownerOf("sess");
    expect(
      deps.sessionStore.resourceOwnership.closedRecord(owner, ASSISTANT_TERMINAL)?.launchGeneration
    ).toBe(5);
  });

  it("closes an assistant in a closeMany without putting it to the person", async () => {
    const requestCloseApproval = vi.fn();
    const { deps, control } = assistantDeps({ caller: CALLER, requestCloseApproval });
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: [ASSISTANT_TERMINAL] },
    });
    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(control.close).toHaveBeenCalledWith(CALLER, TARGET);
    expect(result.structuredContent).toMatchObject({
      results: [{ target: ASSISTANT_TERMINAL, ok: true }],
    });
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("routes an assistant in a closeMany the person was asked about for its other panels", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue({
      result: { ok: true, result: { selectedTargetIds: [] } },
      confirmationDecision: "approved",
    });
    const { deps, control } = assistantDeps({ caller: CALLER, requestCloseApproval });
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: [ASSISTANT_TERMINAL, "t-user"] },
    });
    expect(requestCloseApproval).toHaveBeenCalledWith("terminal.closeMany", {
      terminalIds: ["t-user"],
    });
    expect(control.close).toHaveBeenCalledWith(CALLER, TARGET);
    expect(result.structuredContent).toMatchObject({
      results: [
        { target: ASSISTANT_TERMINAL, ok: true },
        { target: "t-user", ok: false, error: { code: "USER_REJECTED" } },
      ],
    });
  });

  it("keeps an assistant's scrollback and prompt context from anyone else", async () => {
    const { deps } = assistantDeps({ caller: null, origin: "external", tier: "full" });
    const server = await serve(deps);
    await expect(
      callHandler(server, "resources/read", {
        uri: `daintree://terminal/${ASSISTANT_TERMINAL}/scrollback`,
      })
    ).rejects.toThrow(/Unknown resource URI/);

    await getPrompt(server, {
      name: "triage_failed_agent",
      arguments: { terminal_id: ASSISTANT_TERMINAL },
    });
    const dispatched = vi.mocked(deps.dispatchAction).mock.calls.map((call) => call[0]);
    expect(dispatched).not.toContain("terminal.getOutput");
  });

  it("refuses an assistant in another project, or the caller itself, before anything runs", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    control.resolve.mockReturnValue(null as never);
    const server = await serve(deps);
    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: ASSISTANT_TERMINAL, command: "x", generation: 4 },
    });
    expect(toolErrorPayload(result).code).toBe("ASSISTANT_NOT_FOUND");
    expect(control.submit).not.toHaveBeenCalled();
  });
  describe("this machine's global Assistant (#16410)", () => {
    it("sends to it in main, with the generation and handback it was given", async () => {
      const { deps, control } = assistantDeps({ caller: CALLER });
      control.submit.mockResolvedValueOnce({
        terminalId: GLOBAL_TERMINAL,
        submissionToken: "tok-up",
        command: "Raise",
      });
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: GLOBAL_TERMINAL, command: "Raise", generation: 2, handback: true },
      });
      expect(result.isError).toBeFalsy();
      // The token is what its handback is read back by.
      const [first] = result.content as Array<{ text: string }>;
      expect(JSON.parse(first!.text)).toMatchObject({
        terminalId: GLOBAL_TERMINAL,
        submissionToken: "tok-up",
      });
      expect(control.submit).toHaveBeenCalledWith(CALLER, GLOBAL_TARGET, {
        command: "Raise",
        generation: 2,
        handback: true,
      });
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("holds a send up to the drive rule of the caller's own project", async () => {
      const send = async (refuseWrite: SessionServerDeps["refuseWrite"]) => {
        const { deps, control } = assistantDeps({ caller: CALLER });
        deps.refuseWrite = refuseWrite;
        const server = await serve(deps);
        const result = await callTool(server, {
          name: "terminal.sendCommand",
          arguments: { terminalId: GLOBAL_TERMINAL, command: "x", generation: 2 },
        });
        return { result, control };
      };
      const driven = { code: "DRIVEN_ELSEWHERE", message: "Another machine drives it." };

      const refused = await send(vi.fn((projectId) => (projectId === "proj-1" ? driven : null)));
      expect(toolErrorPayload(refused.result).code).toBe("DRIVEN_ELSEWHERE");
      expect(refused.control.submit).not.toHaveBeenCalled();

      // The global's own id names no project, so it is never what is checked.
      const sent = await send(
        vi.fn((projectId) => (projectId === GLOBAL_ASSISTANT_ID ? driven : null))
      );
      expect(sent.result.isError).toBeFalsy();
      expect(sent.control.submit).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["notify", { notify: true }],
      ["waitForReply", { waitForReply: true }],
    ])("refuses a send with %s, sending nothing", async (_name, extra) => {
      const { deps, control } = assistantDeps({ caller: CALLER });
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: GLOBAL_TERMINAL, command: "x", generation: 2, ...extra },
      });
      expect(toolErrorPayload(result).code).toBe("ASSISTANT_GLOBAL_SEND_ONLY");
      expect(control.submit).not.toHaveBeenCalled();
    });

    it.each([
      ["terminal.sendKeys", { terminalId: GLOBAL_TERMINAL, keys: ["Enter"], generation: 2 }],
      ["terminal.interruptOwned", { terminalId: GLOBAL_TERMINAL }],
      ["terminal.close", { terminalId: GLOBAL_TERMINAL }],
      ["terminal.readLastMessageOwned", { terminalId: GLOBAL_TERMINAL }],
      ["terminal.getOutput", { terminalId: GLOBAL_TERMINAL }],
      ["terminal.waitUntilIdle", { terminalId: GLOBAL_TERMINAL }],
      ["terminal.waitUntilIdleBatch", { terminalIds: [ASSISTANT_TERMINAL, GLOBAL_TERMINAL] }],
      ["terminal.notifyWhenIdle", { terminalId: GLOBAL_TERMINAL }],
    ])("refuses %s on it before anything runs", async (name, args) => {
      // Full, so no tier refusal stands in for this one.
      const { deps, control } = assistantDeps({ caller: CALLER, tier: "full" });
      const server = await serve(deps);
      const result = await callTool(server, { name, arguments: args });
      expect(toolErrorPayload(result).code).toBe("ASSISTANT_GLOBAL_SEND_ONLY");
      for (const method of ["sendKeys", "interrupt", "close", "readReply"] as const) {
        expect(control[method]).not.toHaveBeenCalled();
      }
      expect(deps.handleWaitUntilIdle).not.toHaveBeenCalled();
      expect(deps.handleWaitUntilIdleBatch).not.toHaveBeenCalled();
      expect(deps.handleTerminalGetStatusViewless).not.toHaveBeenCalled();
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("reads its status across the workspace line, and never its screen", async () => {
      const { deps } = assistantDeps({ caller: CALLER });
      const server = await serve(deps);
      await callTool(server, {
        name: "terminal.getStatus",
        arguments: { terminalIds: [GLOBAL_TERMINAL] },
      });
      expect(deps.handleTerminalGetStatusViewless).toHaveBeenCalledWith(
        { terminalIds: [GLOBAL_TERMINAL] },
        "proj-1",
        new Set([GLOBAL_TERMINAL]),
        GLOBAL_TERMINAL
      );

      vi.mocked(deps.handleTerminalGetStatusViewless).mockClear();
      for (const includeOutput of [true, { lines: 10 }]) {
        const withOutput = await callTool(server, {
          name: "terminal.getStatus",
          arguments: { terminalIds: [GLOBAL_TERMINAL], includeOutput },
        });
        expect(toolErrorPayload(withOutput).code).toBe("ASSISTANT_GLOBAL_SEND_ONLY");
      }
      expect(deps.handleTerminalGetStatusViewless).not.toHaveBeenCalled();
    });

    it("leaves it out of a batch send, sending the rest", async () => {
      const { deps, control } = assistantDeps({ caller: CALLER });
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: GLOBAL_TERMINAL, command: "x", generation: 2 },
            { terminalId: ASSISTANT_TERMINAL, command: "y", generation: 4 },
          ],
        },
      });
      expect(result.structuredContent).toMatchObject({
        results: [
          { target: GLOBAL_TERMINAL, ok: false, error: { code: "ASSISTANT_GLOBAL_SEND_ONLY" } },
          { target: ASSISTANT_TERMINAL, ok: true },
        ],
      });
      expect(control.submit).toHaveBeenCalledTimes(1);
      expect(control.submit).toHaveBeenCalledWith(CALLER, TARGET, expect.anything());
    });

    it("never waits on it, or on an assistant out of reach, in a batch that waits for replies", async () => {
      const { deps, control } = assistantDeps({ caller: CALLER });
      const wait = vi.fn((options: { terminalId?: string }) => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        // Already ended, as a wait past the outstanding cap is: its read must not go out.
        promise: Promise.resolve({
          terminalId: options.terminalId ?? "",
          outcome: "timeout" as const,
          reply: { text: "the person's conversation", lineCount: 1, truncated: false },
        }),
      }));
      deps.replyWaiter = { wait } as unknown as SessionServerDeps["replyWaiter"];
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: GLOBAL_TERMINAL, command: "x", generation: 2 },
            { terminalId: ASSISTANT_TERMINAL, command: "y", generation: 4 },
          ],
          waitForReply: true,
        },
      });
      const waited = wait.mock.calls.map(([options]) => options.terminalId);
      expect(waited).toEqual([ASSISTANT_TERMINAL]);
      const results = (result.structuredContent as { results: Array<Record<string, unknown>> })
        .results;
      expect(results[0]).toMatchObject({ target: GLOBAL_TERMINAL, ok: false });
      expect(results[0]).not.toHaveProperty("reply");
      expect(results[1]).toMatchObject({ target: ASSISTANT_TERMINAL, ok: true });
      expect(control.submit).toHaveBeenCalledTimes(1);

      // Out of reach reads the same, and is refused before its wait too.
      wait.mockClear();
      control.resolve.mockReturnValue(null);
      const unreachable = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [{ terminalId: GLOBAL_TERMINAL, command: "x", generation: 2 }],
          waitForReply: true,
        },
      });
      expect(wait).not.toHaveBeenCalled();
      expect(unreachable.structuredContent).toMatchObject({
        results: [{ target: GLOBAL_TERMINAL, ok: false, error: { code: "ASSISTANT_NOT_FOUND" } }],
      });
    });

    it("carries no reply on a batch item whose send failed after its wait ended", async () => {
      const { deps, control } = assistantDeps({ caller: CALLER });
      control.submit
        .mockRejectedValueOnce(
          new AssistantTargetError("ASSISTANT_BUSY", "Mid-turn. Nothing was sent.")
        )
        .mockResolvedValueOnce(RECEIPT);
      deps.replyWaiter = {
        wait: vi.fn(() => ({
          bind: vi.fn(),
          cancel: vi.fn(),
          promise: Promise.resolve({
            terminalId: ASSISTANT_TERMINAL,
            outcome: "timeout" as const,
            reply: { text: "captured screen", lineCount: 1, truncated: false },
          }),
        })),
      } as unknown as SessionServerDeps["replyWaiter"];
      const server = await serve(deps);
      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: ASSISTANT_TERMINAL, command: "x", generation: 4 },
            { terminalId: ASSISTANT_TERMINAL, command: "y", generation: 4 },
          ],
          waitForReply: true,
        },
      });
      const results = (result.structuredContent as { results: Array<Record<string, unknown>> })
        .results;
      expect(results[0]).toMatchObject({ ok: false });
      expect(results[0]).not.toHaveProperty("reply");
      expect(results[1]).toMatchObject({
        ok: true,
        reply: { reply: { text: "captured screen" } },
      });
    });

    it("keeps its scrollback and prompt context from a project's assistant", async () => {
      const { deps } = assistantDeps({ caller: CALLER });
      const server = await serve(deps);
      await expect(
        callHandler(server, "resources/read", {
          uri: `daintree://terminal/${GLOBAL_TERMINAL}/scrollback`,
        })
      ).rejects.toThrow(/Unknown resource URI/);
      await getPrompt(server, {
        name: "triage_failed_agent",
        arguments: { terminal_id: GLOBAL_TERMINAL },
      });
      const dispatched = vi.mocked(deps.dispatchAction).mock.calls.map((call) => call[0]);
      expect(dispatched).not.toContain("terminal.getOutput");
    });
  });
});
