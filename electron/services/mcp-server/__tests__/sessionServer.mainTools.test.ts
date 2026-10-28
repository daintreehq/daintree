import { describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, validateDisplayImageUrl } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import type { McpSessionOrigin } from "../../../../shared/types/ipc/mcpServer.js";
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
    projectId: "proj-1",
    slot: 1,
    sessionId: "session-1",
    terminalId: ASSISTANT_TERMINAL,
    attached: true,
  };
  const LISTED = { projectId: "proj-1", assistants: [], vacantSlots: [2, 3] };
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
      isAssistantTerminal: vi.fn((terminalId: string) => terminalId === ASSISTANT_TERMINAL),
      resolve: vi.fn((_caller: AssistantCaller, terminalId: string) =>
        terminalId === ASSISTANT_TERMINAL ? TARGET : null
      ),
      list: vi.fn(async () => LISTED),
      start: vi.fn(async () => ({ assistant: {}, ready: true, notReadyReason: null })),
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
            "agent.readQuota",
            "terminal.sendCommand",
            "terminal.sendCommandOwned",
            "terminal.closeOwned",
            "terminal.close",
            "terminal.closeMany",
            "terminal.interruptOwned",
            "terminal.readLastMessageOwned",
            "terminal.getStatus",
            "terminal.getOutput",
            "terminal.waitUntilIdle",
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
      expect.arrayContaining(["assistant.list", "assistant.start", "agent.readQuota"])
    );

    const pane = await serve(
      assistantDeps({ caller: null, origin: "external", tier: "full" }).deps
    );
    const names = (await listTools(pane)).tools.map((t) => t.name);
    expect(names).not.toContain("assistant.list");
    expect(names).not.toContain("assistant.start");
    expect(names).not.toContain("agent.readQuota");
  });

  it("runs assistant.list and agent.readQuota in main for the caller", async () => {
    const { deps, control } = assistantDeps({ caller: CALLER });
    const server = await serve(deps);

    const listed = await callTool(server, { name: "assistant.list", arguments: {} });
    expect(listed.structuredContent).toEqual(LISTED);
    expect(control.list).toHaveBeenCalledWith(CALLER);

    const quota = await callTool(server, { name: "agent.readQuota", arguments: {} });
    expect(quota.structuredContent).toEqual({
      codex: { status: "unavailable", reason: "cli-missing", fetchedAt: 3 },
    });
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses the assistant tools to anyone else, whatever its tier", async () => {
    const { deps, control } = assistantDeps({ caller: null, origin: "external", tier: "full" });
    const server = await serve(deps);
    for (const name of ["assistant.list", "assistant.start", "agent.readQuota"]) {
      const result = await callTool(server, { name, arguments: {} });
      expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    }
    expect(control.list).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
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

    for (const id of ["assistant.list", "assistant.start", "agent.readQuota"]) {
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
      new Set([ASSISTANT_TERMINAL])
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
});
