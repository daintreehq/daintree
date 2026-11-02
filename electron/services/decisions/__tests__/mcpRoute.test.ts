import fs from "node:fs/promises";
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKeyStore,
  MemoryLocalStore,
  loadIdentity,
  type DecisionsBridge,
  type Identity,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

// `/mcp/decisions` as an agent's CLI reaches it (#16011): the real listener,
// its hold, the library's handler and a real store. Raw requests, so Host and
// Origin can be set as a rebinding page would.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-decisions-route-${Math.random().toString(36).slice(2)}`
);

const storeState = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = { ...actual, homedir: () => testHomeDir };
  return { ...mocked, default: mocked };
});

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  webContents: { fromId: vi.fn(() => undefined), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class BrowserWindow {},
  app: { getVersion: () => "0.0.0-test", getPath: () => testHomeDir },
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  safeStorage: {},
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      storeState.values.set(key, value);
    }),
  },
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock("../../persistence/auditRingStore.js", () => ({
  auditRingStore: { readAll: () => [], writeAll: vi.fn() },
}));

vi.mock("../../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { isValidPaneToken: () => false, getTierForToken: () => undefined },
}));

vi.mock("../../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => 0),
    onWake: vi.fn(() => () => {}),
  })),
}));

vi.mock("../../PluginService.js", () => ({
  pluginService: {
    hasPlugin: () => true,
    activatePlugin: vi.fn(async () => {}),
    findAgentMcpServerSource: () => undefined,
  },
}));

import { McpServerService } from "../../McpServerService.js";
import {
  DECISIONS_MCP_PATH,
  DecisionsMcpRoute,
  openDecisionsMcpRoute,
  type DecisionsListenerHold,
  type DecisionsQuestions,
} from "../mcpRoute.js";
import type { ListenerRoute } from "../../mcp-server/listenerHold.js";
import type { PaneBearer, PaneTerminalInfo, PaneTerminalReader } from "../paneAccess.js";
import type { QuestionSource } from "../relayConnection.js";
import { DecisionsAttachments, type QuestionAttachments } from "../attachmentSpool.js";
import { DESIGN_REVIEW_FINAL_GATE_ID, createTrustedPolicy } from "../workflowGates.js";

const API_KEY = "orchestration-api-key";
const HELP_TOKEN = "help-session-token";
const HOST_ID = "host_decisions_test";

const emptyRegistry = {
  all: () => [],
  focusOrder: () => [],
  getPrimary: () => null,
  getByWindowId: () => null,
  getByWebContentsId: () => null,
  size: 0,
};

interface Answer {
  status: number;
  body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Connection: "close", ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error(`${path} didn't answer`)));
    req.on("error", reject);
    req.end(options.body);
  });
}

let nextId = 1;

function rpc(
  port: number,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<Answer> {
  return request(port, DECISIONS_MCP_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
}

async function call(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const answer = await rpc(port, token, "tools/call", { name, arguments: args });
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { result: ToolResult }).result;
}

async function ownerIdentity(): Promise<StoredIdentity> {
  const keys = await generateDeviceKeys(true);
  return {
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

interface Pane {
  token: string;
  bearer: PaneBearer;
  generation: number;
  info: PaneTerminalInfo;
}

function pane(id: string, overrides: Partial<PaneTerminalInfo> = {}): Pane {
  return {
    token: `pane-token-${id}`,
    bearer: { paneId: id, principal: `principal-${id}`, workspaceId: "project-1" },
    generation: 3,
    info: {
      projectId: "project-1",
      worktreeId: "wt-main",
      cwd: "/work/repo",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentIncarnation: 0,
      agentSessionId: "session-1",
      launchGeneration: 3,
      hasPty: true,
      ...overrides,
    },
  };
}

let identity: StoredIdentity;

describe("/mcp/decisions (#16011)", () => {
  let service: McpServerService;
  let store: MemoryLocalStore;
  let loaded: Identity;
  let panes: Map<string, Pane>;
  /** Bearers revoked while their terminals run on. */
  let revoked: Set<string>;
  let fetches: number;
  let questions: DecisionsQuestions | null;

  const ptyClient: PaneTerminalReader = {
    getLiveGeneration: (id) => panes.get(id)?.generation ?? null,
    isLiveGeneration: (id, generation) => panes.get(id)?.generation === generation,
    getTerminalAsync: async (id) => panes.get(id)?.info ?? null,
  };

  function boot(enabled: boolean): Promise<void> {
    storeState.values.set("mcpServer", {
      enabled,
      port: 0,
      apiKey: API_KEY,
      auditEnabled: false,
      auditMaxRecords: 500,
    });
    return service.start(emptyRegistry as never);
  }

  /** The route as the Decisions service opens it, over a connection between attempts. */
  async function openRoute(attachments?: QuestionAttachments): Promise<number> {
    const source: QuestionSource = {
      identity: () => loaded,
      live: () => null,
      store,
      // The policy a lifetime starts with: the trusted gates, no proxy allowlist.
      policy: createTrustedPolicy({ proxyAllowlisted: false }),
      ...(attachments ? { attachments } : {}),
    };
    let held: number | null = null;
    questions = openDecisionsMcpRoute(source, {
      bearerFor: (token) =>
        revoked.has(token)
          ? null
          : ([...panes.values()].find((candidate) => candidate.token === token)?.bearer ?? null),
      principalFor: (paneId) => {
        const held = panes.get(paneId);
        return held && !revoked.has(held.token) ? held.bearer.principal : null;
      },
      hostId: () => HOST_ID,
      getPtyClient: () => ptyClient,
      holdListener: async (id, route) => {
        const hold = await service.holdListener(id, route);
        held = hold.port;
        return hold;
      },
    });
    await vi.waitFor(() => expect(held).not.toBeNull());
    return held!;
  }

  function add(...added: Pane[]): void {
    for (const p of added) panes.set(p.bearer.paneId, p);
  }

  beforeEach(async () => {
    identity ??= await ownerIdentity();
    storeState.values.clear();
    await fs.mkdir(testHomeDir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
    service.setHelpTokenValidator((token) => (token === HELP_TOKEN ? "full" : false));
    store = new MemoryLocalStore();
    const keys = new MemoryKeyStore();
    await keys.save(identity);
    loaded = await loadIdentity(keys);
    panes = new Map();
    revoked = new Set();
    questions = null;
    fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetches += 1;
      throw new Error("no network in this test");
    });
  });

  afterEach(async () => {
    await questions?.close();
    await service.stop();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  it("serves the three tools to a pane bearer with the MCP server off, each described in under 400 bytes", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const init = await rpc(port, "pane-token-pane-a", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe("daintree-decisions");

    const list = await rpc(port, "pane-token-pane-a", "tools/list");
    const tools = (
      JSON.parse(list.body) as { result: { tools: Array<{ name: string; description: string }> } }
    ).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "ask_human",
      "cancel_question",
      "get_decision",
    ]);
    for (const tool of tools) {
      expect(Buffer.byteLength(tool.description, "utf8"), tool.name).toBeLessThan(400);
    }
  });

  it("commits the question with its full origin from the bearer and the pane, before any network I/O", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const result = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Ship the redesign now or after the review?",
    });
    const alias = (await store.listQuestions())[0].alias;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      `Asked as q-${alias}. End your turn now (or continue with unrelated work); the answer will arrive as a message in this terminal.`
    );
    expect(result.structuredContent).toMatchObject({
      status: "queued",
      enforced_requirement: "human-required",
    });

    const [row] = await store.listQuestions();
    expect(row.question_id).toBe(result.structuredContent.question_id);
    expect(row.origin).toEqual({
      host_id: HOST_ID,
      pane_id: "pane-a",
      terminal_generation: 3,
      ownership_principal: "principal-pane-a",
      agent_incarnation: "0",
      agent_kind: "claude",
      agent_session_id: "session-1",
      project_id: "project-1",
      worktree_id: "wt-main",
      worktree_root: "/work/repo",
      workflow_gate_id: null,
    });
    expect(row.local_status).toBe("queued");
    expect((await store.outboxFor(row.question_id)).map((item) => item.kind)).toEqual(["create"]);
    expect(fetches).toBe(0);
  });

  it("attaches images from the pane's own launch directory, and tells the agent what was wrong with the rest", async () => {
    const root = await fs.mkdtemp(`${testHomeDir}/attach-`);
    try {
      const worktree = `${root}/worktree`;
      await fs.mkdir(`${worktree}/shots`, { recursive: true });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      await fs.writeFile(`${worktree}/shots/after.png`, png);
      await fs.writeFile(`${root}/outside.png`, Buffer.concat([png, Buffer.from("SECRET")]));
      await fs.symlink(`${root}/outside.png`, `${worktree}/shots/linked.png`);
      await fs.writeFile(`${worktree}/fake.png`, "SECRET plain text");
      const attachments = new DecisionsAttachments({
        dir: `${root}/spool`,
        referenced: async () =>
          new Set(
            (await store.dueOutbox(Number.MAX_SAFE_INTEGER, 1000)).flatMap((item) =>
              item.kind === "create"
                ? (item.payload as { attachments: { attachment_id: string }[] }).attachments.map(
                    (a) => a.attachment_id
                  )
                : []
            )
          ),
      });
      await boot(false);
      add(pane("pane-a", { cwd: worktree }));
      const port = await openRoute(attachments);
      const ask = (ids: string[]) =>
        call(port, "pane-token-pane-a", "ask_human", {
          question: "Does the redesign look right?",
          attachments: ids.map((id) => ({ local_resource_id: id, role: "after" })),
        });

      const asked = await ask(["shots/after.png"]);
      expect(asked.isError).toBeUndefined();
      const [row] = await store.listQuestions();
      expect(row.attachment_digests).toHaveLength(1);
      expect(await fs.readdir(`${root}/spool`)).toHaveLength(1);

      for (const [id, problem] of [
        ["../outside.png", "is outside this terminal's worktree"],
        ["shots/linked.png", "is outside this terminal's worktree"],
        ["fake.png", "isn't a PNG, JPEG or WebP image"],
        [`${worktree}/shots/after.png`, "must be a path relative to this terminal's worktree"],
      ] as const) {
        const refused = await ask(["shots/after.png", id]);
        expect(refused.isError).toBe(true);
        const text = refused.content[0].text;
        expect(
          text.startsWith(`attachment_error: attachment ${JSON.stringify(id)} ${problem}`)
        ).toBe(true);
        expect(refused.content[0].text).not.toContain("SECRET");
      }
      const nine = await ask(Array.from({ length: 9 }, () => "shots/after.png"));
      expect(nine.isError).toBe(true);
      expect(nine.content[0].text).toMatch(/^validation_error: attachments/);

      // Only the question that was asked holds anything in the spool.
      expect(await store.listQuestions()).toHaveLength(1);
      expect(await fs.readdir(`${root}/spool`)).toHaveLength(1);
      await attachments.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses missing, API-key, help, foreign and revoked tokens, with the MCP server on as well", async () => {
    await boot(true);
    add(pane("pane-a"));
    const port = await openRoute();

    // The control surface takes the API key and the help token...
    for (const token of [API_KEY, HELP_TOKEN]) {
      const controlSurface = await request(port, "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "1.0.0" },
          },
        }),
      });
      expect(controlSurface.status, token).toBe(200);
    }

    // ...and Decisions takes neither.
    for (const token of [null, API_KEY, HELP_TOKEN, "someone-elses-token", "pane-token-pane-b"]) {
      const answer = await rpc(port, token, "tools/list");
      expect(answer.status, String(token)).toBe(401);
    }
    expect((await rpc(port, "pane-token-pane-a", "tools/list")).status).toBe(200);

    // A revoked bearer is refused on its next request: nothing keeps a session for it.
    const askedBefore = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Keep it?",
    });
    // Revoked as `revokePaneConfig` does it: the terminal is still there.
    revoked.add("pane-token-pane-a");
    expect((await rpc(port, "pane-token-pane-a", "tools/list")).status).toBe(401);
    // Its question stays, bound to the run that asked.
    const kept = await store.getQuestion(askedBefore.structuredContent.question_id as string);
    expect(kept?.origin.ownership_principal).toBe("principal-pane-a");
    expect(kept?.local_status).toBe("queued");
  });

  it("refuses a rebinding Host, any Origin and repeated security headers", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const token = "pane-token-pane-a";

    expect(
      (await rpc(port, token, "tools/list", {}, { Host: `evil.example:${port}` })).status
    ).toBe(403);
    expect(
      (await rpc(port, token, "tools/list", {}, { Host: `127.0.0.1:${port + 1}` })).status
    ).toBe(403);
    expect(
      (await rpc(port, token, "tools/list", {}, { Origin: "https://evil.example" })).status
    ).toBe(403);
    // The listener lets a same-origin page through; Decisions takes no browser at all.
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "null"]) {
      const answer = await rpc(port, token, "tools/list", {}, { Origin: origin });
      expect(answer.status, origin).toBe(403);
    }
    const repeated = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: DECISIONS_MCP_PATH, method: "POST", agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.setHeader("Authorization", [`Bearer ${token}`, "Bearer other"]);
      req.end("{}");
    });
    expect(repeated).toBe(400);
    expect((await rpc(port, token, "tools/list", {}, { Host: `localhost:${port}` })).status).toBe(
      200
    );
  });

  it("keeps a question human-required whatever the agent asks for, and takes no origin from it", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const token = "pane-token-pane-a";

    for (const requested of ["proxy-ok", "proxy-first", "human-required"]) {
      const result = await call(port, token, "ask_human", {
        question: `Downgrade to ${requested}?`,
        requested_requirement: requested,
      });
      expect(result.structuredContent.enforced_requirement, requested).toBe("human-required");
    }
    // A gate the agent names that Daintree never registered is no policy at all.
    const invented = await call(port, token, "ask_human", {
      question: "Approve it?",
      workflow_gate_id: "agent-invented/gate",
      requested_requirement: "proxy-ok",
    });
    expect(invented.structuredContent.enforced_requirement).toBe("human-required");
    // A trusted gate applies between attempts too: the final design review binds to its images.
    const unbound = await call(port, token, "ask_human", {
      question: "Approve the final design?",
      workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    expect(unbound.isError).toBe(true);
    // Origin fields among the arguments are dropped, never recorded.
    const forged = await call(port, token, "ask_human", {
      question: "Whose pane is this?",
      pane_id: "pane-b",
      origin: { pane_id: "pane-b", host_id: "elsewhere", ownership_principal: "principal-pane-b" },
    });
    expect(forged.isError).toBeUndefined();

    const rows = await store.listQuestions();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.requirement).toBe("human-required");
      expect(row.origin.pane_id).toBe("pane-a");
      expect(row.origin.host_id).toBe(HOST_ID);
      expect(row.origin.ownership_principal).toBe("principal-pane-a");
      expect(row.origin.workflow_gate_id).toBeNull();
    }
  });

  it("shows and cancels a question only for the pane that asked it", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Which name?" });
    const questionId = asked.structuredContent.question_id as string;

    const own = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(own.isError).toBeUndefined();
    expect(own.structuredContent).toMatchObject({ question_id: questionId, status: "queued" });

    // Another pane's id reads as an unknown one, and its cancel changes nothing.
    const other = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: questionId,
    });
    const unknown = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: "q_doesnotexist",
    });
    expect(other.structuredContent).toEqual({ error: "not_found" });
    expect(other.structuredContent).toEqual(unknown.structuredContent);
    const refused = await call(port, "pane-token-pane-b", "cancel_question", {
      question_id: questionId,
    });
    expect(refused.structuredContent).toEqual({ error: "not_found" });
    expect((await store.getQuestion(questionId))?.local_status).toBe("queued");
    expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual(["create"]);

    // Its own pane cancels it; never published, it is dropped before it is sent.
    const cancelled = await call(port, "pane-token-pane-a", "cancel_question", {
      question_id: questionId,
    });
    expect(cancelled.isError).toBeUndefined();
    expect((await store.getQuestion(questionId))?.local_status).toBe("cancelled");
    expect(await store.outboxFor(questionId)).toEqual([]);
  });

  it.each([
    [
      "a new bearer and principal",
      { token: "pane-token-pane-a-2", principal: "principal-pane-a-2" },
    ],
    ["a new launch generation", { generation: 4 }],
  ] as const)("keeps a question from the same pane relaunched with %s", async (_label, change) => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Mine?" });
    const questionId = asked.structuredContent.question_id as string;

    const before = pane("pane-a");
    const generation = "generation" in change ? change.generation : before.generation;
    const token = "token" in change ? change.token : before.token;
    panes.set("pane-a", {
      token,
      bearer: {
        ...before.bearer,
        ...("principal" in change ? { principal: change.principal } : {}),
      },
      generation,
      info: { ...before.info, launchGeneration: generation },
    });

    const read = await call(port, token, "get_decision", { question_id: questionId });
    expect(read.structuredContent).toEqual({ error: "not_found" });
    const cancel = await call(port, token, "cancel_question", { question_id: questionId });
    expect(cancel.structuredContent).toEqual({ error: "not_found" });
    expect((await store.getQuestion(questionId))?.local_status).toBe("queued");
  });

  it("still shows a question to its run once the run's agent session is learned", async () => {
    await boot(false);
    add(pane("pane-a", { agentSessionId: undefined }));
    const port = await openRoute();
    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Learned?" });
    const questionId = asked.structuredContent.question_id as string;
    expect((await store.getQuestion(questionId))?.origin.agent_session_id).toBeNull();

    panes.get("pane-a")!.info.agentSessionId = "session-learned";
    const read = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ question_id: questionId });
  });

  it("holds a pane to 10 open questions even when it asks them all at once, and the next pane to its own", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        call(port, "pane-token-pane-a", "ask_human", { question: `Question ${n}?` })
      )
    );
    const refused = results.filter((result) => result.isError === true);
    expect(results.length - refused.length).toBe(10);
    expect(refused.map((result) => result.structuredContent.error)).toEqual([
      "too_many_open_questions",
      "too_many_open_questions",
    ]);
    expect(await store.countOpenForPane(HOST_ID, "pane-a")).toBe(10);

    const b = await call(port, "pane-token-pane-b", "ask_human", { question: "Mine?" });
    expect(b.isError).toBeUndefined();
  });

  it("limits each pane's request rate on its own", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const statuses: number[] = [];
    for (let n = 0; n < 61; n++) {
      statuses.push((await rpc(port, "pane-token-pane-a", "ping")).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await rpc(port, "pane-token-pane-b", "ping")).status).toBe(200);
  });

  it("is not there with Decisions off, whatever the credential, and nothing listens with MCP off too", async () => {
    await boot(true);
    add(pane("pane-a"));
    const port = service.currentPort!;
    for (const token of [null, API_KEY, HELP_TOKEN, "pane-token-pane-a"]) {
      expect((await rpc(port, token, "tools/list")).status, String(token)).toBe(404);
      expect(
        (
          await request(port, `${DECISIONS_MCP_PATH}/anything`, {
            method: "POST",
            headers: token === null ? {} : { Authorization: `Bearer ${token}` },
          })
        ).status
      ).toBe(404);
    }
    expect(service.getAuditStats(false).auth401Count).toBe(0);

    // Turned on and off again: the route goes with it.
    const held = await openRoute();
    expect((await rpc(held, "pane-token-pane-a", "tools/list")).status).toBe(200);
    await questions!.close();
    expect((await rpc(held, "pane-token-pane-a", "tools/list")).status).toBe(404);

    await service.stop();
    service = new McpServerService();
    await boot(false);
    await expect(rpc(held, "pane-token-pane-a", "tools/list")).rejects.toThrow();
  });
});

describe("DecisionsMcpRoute", () => {
  const bridge = {} as DecisionsBridge;
  const authenticator = { authenticate: () => null };

  function answerOf(route: ListenerRoute): Promise<number> {
    let status = 0;
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: () => res,
    };
    return route
      .handle({} as never, res as never, new URL("http://127.0.0.1/mcp/decisions"), 1)
      .then(() => status);
  }

  it("refuses at once when closed while its hold is being taken, and lets that hold go once it comes", async () => {
    let route: ListenerRoute | null = null;
    let grant!: (hold: DecisionsListenerHold) => void;
    const release = vi.fn(async () => {});
    const decisions = new DecisionsMcpRoute(bridge, authenticator, (_id, held) => {
      route = held;
      return new Promise((resolve) => {
        grant = resolve;
      });
    });

    const opened = decisions.open();
    await vi.waitFor(() => expect(route).not.toBeNull());
    const closing = decisions.close();
    expect(await answerOf(route!)).toBe(404);
    grant({ port: 4100, release });
    await opened;
    await closing;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes its hold only once the route it replaces has let go, and none when closed before then", async () => {
    let letGo!: () => void;
    const previous = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const holdListener = vi.fn(async () => ({ port: 4100, release: vi.fn(async () => {}) }));
    const next = new DecisionsMcpRoute(bridge, authenticator, holdListener);
    const opened = next.open(previous);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(holdListener).not.toHaveBeenCalled();
    letGo();
    await opened;
    expect(holdListener).toHaveBeenCalledTimes(1);

    let letGoAgain!: () => void;
    const again = new Promise<void>((resolve) => {
      letGoAgain = resolve;
    });
    const unused = vi.fn(async () => ({ port: 4100, release: vi.fn(async () => {}) }));
    const closedFirst = new DecisionsMcpRoute(bridge, authenticator, unused);
    const openedLate = closedFirst.open(again);
    const closing = closedFirst.close();
    letGoAgain();
    await openedLate;
    await closing;
    expect(unused).not.toHaveBeenCalled();
  });

  it("reports where launches reach it: the hold's port, none once closed or when the hold failed", async () => {
    let port: number | null = 4100;
    const route = new DecisionsMcpRoute(bridge, authenticator, async () => ({
      get port() {
        return port;
      },
      release: vi.fn(async () => {}),
    }));
    expect(await new DecisionsMcpRoute(bridge, authenticator, vi.fn()).listenerPort()).toBeNull();
    void route.open();
    await expect(route.listenerPort()).resolves.toBe(4100);
    // The listener moved: the hold's live port, not the one first seen.
    port = 4101;
    await expect(route.listenerPort()).resolves.toBe(4101);
    await route.close();
    await expect(route.listenerPort()).resolves.toBeNull();

    const refused = new DecisionsMcpRoute(bridge, authenticator, async () => {
      throw new Error("no listener");
    });
    await refused.open().catch(() => {});
    await expect(refused.listenerPort()).resolves.toBeNull();

    // Closed while the hold was still being taken: no port, though the hold had one.
    let grant!: (hold: DecisionsListenerHold) => void;
    const racing = new DecisionsMcpRoute(
      bridge,
      authenticator,
      () =>
        new Promise((resolve) => {
          grant = resolve;
        })
    );
    void racing.open();
    const asked = racing.listenerPort();
    await vi.waitFor(() => expect(grant).toBeDefined());
    const closing = racing.close();
    grant({ port: 4100, release: vi.fn(async () => {}) });
    await expect(asked).resolves.toBeNull();
    await closing;
  });
});
