import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

// ActionService pulls in the shortcut-hint store, keybinding service, and notify
// at module load / dispatch time. Registration only needs the module to import
// cleanly, so stub them out.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

// terminalQueryActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds: new Set<string>() }) },
}));
vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn() } }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { ActionService } from "../../../ActionService";
import { registerTerminalQueryActions } from "../terminalQueryActions";
import { TerminalStatusResultSchema } from "../schemas";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { readClaudeLastMessage } from "../../../../../electron/services/claude/ClaudeSessionReader";
import { buildToolCallResult } from "../../../../../electron/services/mcp-server/toolCallResult";

function registerDefinitions(): ActionRegistry {
  const registry: ActionRegistry = new Map();
  registerTerminalQueryActions(registry, {} as ActionCallbacks);
  return registry;
}

function registerAll(): ActionService {
  const registry = registerDefinitions();
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

type TerminalListItem = {
  id: string;
  isFocused: boolean;
  agentId: string | null;
  location: string;
};

async function runList(actions: ActionRegistry, args?: unknown): Promise<unknown> {
  const factory = actions.get("terminal.list");
  if (!factory) throw new Error("missing terminal.list");
  const def = factory() as AnyActionDefinition;
  return def.run(args, {} as never);
}

async function callList(actions: ActionRegistry, args?: unknown): Promise<TerminalListItem[]> {
  return ((await runList(actions, args)) as { terminals: TerminalListItem[] }).terminals;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// #10676 — the three high-value query actions opt into MCP structuredContent by
// carrying `mcpOutputSchema: true` alongside a top-level object resultSchema.
// Registering through the real ActionService exercises the Zod -> JSON Schema
// conversion, so these assert the *generated* schema, not the literal flag.
describe("terminal query actions emit a manifest outputSchema (#10676)", () => {
  const HIGH_VALUE = ["terminal.list", "terminal.getStatus", "terminal.getOutput"];

  it.each(HIGH_VALUE)("%s generates an object-typed outputSchema", (id) => {
    const schema = outputSchema(registerAll(), id);
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
    // buildToolOutputSchema (tierAuth) only forwards object-typed schemas, and
    // buildStructuredContent only attaches it when the schema is present — so a
    // missing or non-object schema would silently drop structuredContent.
    expect(schema!.properties).toBeDefined();
  });

  it("terminal.list / terminal.getStatus expose the `terminals` array property", () => {
    const service = registerAll();
    for (const id of ["terminal.list", "terminal.getStatus"]) {
      const props = (outputSchema(service, id)!.properties as Record<string, unknown>) ?? {};
      expect(props.terminals).toBeDefined();
    }
  });

  it("terminal.getStatus advertises the `armed` flag in its per-entry schema (#10695)", () => {
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const props = (items?.properties as Record<string, unknown>) ?? {};
    // An MCP client introspecting structuredContent must see `armed` so the
    // read path stays discoverable if the schema field is ever dropped.
    expect(props.armed).toBeDefined();
  });

  it("terminal.getStatus advertises hasPty as an optional plain boolean (#12336)", () => {
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const props = (items?.properties as Record<string, { type?: unknown }>) ?? {};

    // Advertised, or an introspecting client never learns the read exists.
    expect(props.hasPty).toBeDefined();
    // A plain boolean, not an anyOf/null union: the renderer answer omits the
    // key entirely rather than sending `null`, and a third representation
    // would give a poller a state neither builder ever produces.
    expect(props.hasPty?.type).toBe("boolean");
    // Optional, because the surface that cannot observe it sends no key. A
    // required field would make every renderer-sourced answer fail a strict
    // client's structuredContent validation.
    const required = (items?.required as string[] | undefined) ?? [];
    expect(required).not.toContain("hasPty");
  });

  it("terminal.getStatus admits hasPty in its unavailableFields enum (#12336)", () => {
    // The renderer path answers `unavailableFields: ["hasPty"]`. Entry schema
    // and envelope have to land together — widening only the entry ships a
    // manifest whose own envelope rejects the answer the action returns.
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const unavailable = (
      schema.properties as { unavailableFields: { items?: { enum?: string[] } } }
    ).unavailableFields.items;
    expect(unavailable?.enum).toContain("hasPty");
  });

  it("terminal.getStatus advertises recentOutputTruncated and its result schema keeps it (#12450)", () => {
    const EntrySchemaShape = z.object({
      properties: z.object({
        terminals: z.object({
          items: z.object({
            properties: z.record(z.string(), z.object({ type: z.unknown().optional() })),
            required: z.array(z.string()).optional(),
          }),
        }),
      }),
    });
    const { items } = EntrySchemaShape.parse(outputSchema(registerAll(), "terminal.getStatus"))
      .properties.terminals;
    expect(items.properties.recentOutputTruncated?.type).toBe("boolean");
    expect(items.required ?? []).not.toContain("recentOutputTruncated");

    // Dispatch parses results through this schema and strips undeclared keys,
    // so an unlisted flag would never reach a caller.
    const parsed = TerminalStatusResultSchema.parse({
      terminals: [
        {
          terminalId: "t1",
          agentId: null,
          agentState: null,
          recentOutput: "tail",
          recentOutputTruncated: true,
        },
      ],
      source: "renderer",
      unavailableFields: ["hasPty"],
    });
    expect(parsed.terminals[0]?.recentOutputTruncated).toBe(true);
  });

  it("terminal.getOutput exposes content/lineCount/truncated properties", () => {
    const props =
      (outputSchema(registerAll(), "terminal.getOutput")!.properties as Record<string, unknown>) ??
      {};
    expect(props.content).toBeDefined();
    expect(props.lineCount).toBeDefined();
    expect(props.truncated).toBeDefined();
  });

  it("does not mark terminal.list's `type` as required (runtime emits it undefined)", () => {
    // terminal.list returns `type: undefined`, which drops on JSON serialization,
    // so the advertised schema must not require the key — otherwise a strict MCP
    // client validating structuredContent against outputSchema would reject it.
    const schema = outputSchema(registerAll(), "terminal.list")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const required = (items?.required as string[] | undefined) ?? [];
    expect(required).not.toContain("type");
  });

  // The watchout from #10676 still stands: do not flip the flag on a neighbour
  // that has no resultSchema. sendCommand gained one deliberately in #12337:
  // the token it returns is the whole contract of that issue, so it has to
  // reach validated `structuredContent` rather than only the text body a
  // client would otherwise have to scrape.
  it("advertises terminal.sendCommand's submission token in an object-rooted schema", () => {
    const service = registerAll();
    const schema = outputSchema(service, "terminal.sendCommand");
    expect(schema).toBeDefined();
    // A non-object root is silently dropped by `buildToolOutputSchema`, which
    // would advertise nothing while every flag still looked correct.
    expect(schema?.type).toBe("object");
    const required = (schema?.required as string[] | undefined) ?? [];
    expect(required).toContain("submissionToken");
  });
});

// #12407 — the session-scoped submission delegates to `terminal.sendCommand` in
// main, so the receipt a client validates has to be the delegate's exactly.
describe("terminal.sendCommandOwned (#12407)", () => {
  function definition(): AnyActionDefinition {
    const factory = registerDefinitions().get("terminal.sendCommandOwned");
    if (!factory) throw new Error("terminal.sendCommandOwned not registered");
    return factory();
  }

  it("advertises the same output schema as the submission it delegates to", () => {
    const service = registerAll();
    const owned = outputSchema(service, "terminal.sendCommandOwned");
    expect(owned?.type).toBe("object");
    expect(owned).toEqual(outputSchema(service, "terminal.sendCommand"));
  });

  it("requires both the target and the text", () => {
    const schema = definition().argsSchema!;
    expect(schema.safeParse({ command: "ls" }).success).toBe(false);
    expect(schema.safeParse({ terminalId: "t-1" }).success).toBe(false);
    expect(schema.safeParse({ terminalId: "t-1", command: "" }).success).toBe(false);
    expect(schema.safeParse({ terminalId: "t-1", command: "ls" }).success).toBe(true);
  });

  it("refuses renderer dispatch — ownership is checked in main", async () => {
    await expect(definition().run({ terminalId: "t-1", command: "ls" }, {})).rejects.toThrow(
      /main-process path/
    );
  });
});

// #12339 — both wait tools carry a hand-written rawOutputSchema but never set
// `mcpOutputSchema`, so `computeSchemas` left `outputSchema` undefined and
// tools/list advertised nothing — while the main-process path was already
// attaching `structuredContent` with no schema to validate it against.
describe("wait tools advertise their output schema (#12339)", () => {
  const WAIT_TOOLS = ["terminal.waitUntilIdle", "terminal.waitUntilIdleBatch"];

  it.each(WAIT_TOOLS)("%s generates an object-typed outputSchema", (id) => {
    const schema = outputSchema(registerAll(), id);
    expect(schema).toBeDefined();
    // buildToolOutputSchema (tierAuth) drops anything that is not a top-level
    // object, which would silently re-disarm the advertisement.
    expect(schema!.type).toBe("object");
    expect(schema!.properties).toBeDefined();
  });

  it("terminal.waitUntilIdle advertises trackingState as a required enum", () => {
    const schema = outputSchema(registerAll(), "terminal.waitUntilIdle")!;
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.trackingState?.enum).toEqual(["tracked", "closed", "unknown"]);
    // Required so a reconciler can rely on it being present on every result
    // rather than treating its absence as tracked.
    expect(schema.required as string[]).toContain("trackingState");
  });

  it("terminal.waitUntilIdleBatch advertises trackingState on every row", () => {
    const schema = outputSchema(registerAll(), "terminal.waitUntilIdleBatch")!;
    const items = (schema.properties as { results: { items?: Record<string, unknown> } }).results
      .items!;
    const props = items.properties as Record<string, { enum?: string[] }>;
    expect(props.trackingState?.enum).toEqual(["tracked", "closed", "unknown"]);
    expect(items.required as string[]).toContain("trackingState");
  });
});

// #12308 — `owned` is advertised on the tool but answered in main, against the
// MCP session's ownership ledger. These go through the real ActionService so
// they exercise the published input schema and the dispatch path a caller that
// bypasses main would actually take.
describe("terminal.list owned input contract (#12308)", () => {
  function listEntry(service: ActionService) {
    return service.get("terminal.list" as ActionId);
  }

  it("advertises owned as an optional boolean with its own description", () => {
    const schema = listEntry(registerAll())?.inputSchema;

    expect(schema).toMatchObject({
      // The tool description has no room for the field's semantics, so an
      // empty `.describe()` would ship the argument undocumented.
      properties: { owned: { type: "boolean", description: expect.stringMatching(/\S/) } },
    });
    // Optional in the published contract: a client holding a cached tools/list
    // that never sends the field must keep getting today's behaviour.
    expect(schema?.required ?? []).not.toContain("owned");
  });

  it("refuses a real dispatch rather than answering it with the full list", async () => {
    // Every non-MCP caller — the in-app assistant, a keybinding, a plugin, a
    // test — converges on this method, and `run()` cannot tell them apart. An
    // unfiltered list here would be a wrong answer, not a missing feature.
    for (const source of ["agent", "user", "plugin"] as const) {
      const result = await registerAll().dispatch(
        "terminal.list" as ActionId,
        { owned: true },
        { source }
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toMatch(/owned/);
    }
  });

  it("rejects a non-boolean owned at schema validation", async () => {
    // Main forwards a non-boolean untouched precisely so this gate sees it,
    // instead of a strip laundering it into a legal request.
    const result = await registerAll().dispatch("terminal.list" as ActionId, { owned: "yes" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("terminal.readLastMessageOwned (#12479)", () => {
  const ID = "terminal.readLastMessageOwned";

  const OK_WITH_MESSAGE = {
    status: "ok",
    provider: "claude",
    message: {
      id: "msg_1",
      text: "Verdict: ship it.",
      truncated: false,
      recordedAt: 1_767_225_600_000,
      stopReason: "end_turn",
      nextCursor: null,
    },
    unansweredToolUses: [{ id: "toolu_b", name: "Bash" }],
    newerRecordsFollow: false,
    fileUpdatedAt: 1_767_225_600_000,
  };

  const OK_QUESTION_ONLY = {
    status: "ok",
    provider: "claude",
    message: null,
    unansweredToolUses: [
      {
        id: "toolu_q",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }] },
      },
    ],
    newerRecordsFollow: true,
    fileUpdatedAt: 1,
  };

  function validator() {
    const schema = outputSchema(registerAll(), ID);
    if (!schema) throw new Error("no output schema was generated");
    return new Ajv2020({ strict: false }).compile(schema);
  }

  // Execution belongs to main, which holds the ownership ledger and can open
  // the transcript; a renderer dispatch reaching `run()` is a routing bug.
  it("refuses a renderer dispatch, and requires a panel id before that", async () => {
    const service = registerAll();

    const missing = await service.dispatch(ID as ActionId, {}, { source: "agent" });
    expect(missing.ok === false && missing.error.code).toBe("VALIDATION_ERROR");

    const routed = await service.dispatch(
      ID as ActionId,
      { terminalId: "t-1" },
      { source: "agent" }
    );
    expect(routed.ok).toBe(false);
    expect(routed.ok === false && routed.error.message).toMatch(/main-process path/);
  });

  // A root union emits `oneOf` with no type, and the output gate forwards only
  // an object-rooted schema — so without the root type the tool would
  // advertise nothing and attach no structured content, silently.
  it("advertises an object-rooted output schema with one closed arm per status", () => {
    const schema = z
      .object({
        type: z.literal("object"),
        oneOf: z.array(z.object({ additionalProperties: z.literal(false) })).length(2),
      })
      .safeParse(outputSchema(registerAll(), ID));

    expect(schema.success).toBe(true);
  });

  // Main builds this result by hand and nothing on the way validates it, so a
  // strict client's check against the advertised schema is the whole contract.
  it("accepts every shape the reader returns", () => {
    const validate = validator();

    for (const payload of [
      OK_WITH_MESSAGE,
      OK_QUESTION_ONLY,
      { status: "unavailable", reason: "store-unknown" },
      { status: "unavailable", reason: "search-cap-reached" },
      { status: "unavailable", reason: "message-not-found" },
      {
        ...OK_WITH_MESSAGE,
        message: { ...OK_WITH_MESSAGE.message, truncated: true, nextCursor: "eyJ2IjoxfQ" },
      },
    ]) {
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  // The payloads above pin the schema; this pins the reader to it. What the
  // reader really returns goes through the builder a client's response comes
  // from, and has to arrive structured and valid — including the cases that
  // trim, omit or escape.
  it("validates what the real reader returns, after the response builder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "last-message-schema-"));
    try {
      const sessionId = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
      const cwd = "/work/app";
      const projectsRoot = path.join(root, "projects");
      const dir = path.join(projectsRoot, cwd.replace(/\//g, "-"));
      await mkdir(dir, { recursive: true });
      const record = (id: string, content: unknown[]) =>
        JSON.stringify({
          type: "assistant",
          message: { id, content, stop_reason: "end_turn" },
          timestamp: "2026-09-18T10:00:00.000Z",
        });
      const question = (input: unknown) => ({
        type: "tool_use",
        id: "toolu_q",
        name: "AskUserQuestion",
        input,
      });
      const transcripts = [
        [
          record("m", [{ type: "text", text: "Verdict: \u001b[1mship\u001b[0m it." }]),
          record("m", [question(OK_QUESTION_ONLY.unansweredToolUses[0]!.input)]),
        ],
        [record("m", [question({ questions: [{ question: "x".repeat(9_000) }] })])],
        [
          record("m", [{ type: "text", text: "\u0001".repeat(60_000) }]),
          record("m", [
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls" } },
          ]),
        ],
      ];
      const read = () => readClaudeLastMessage({ projectsRoot, cwd, sessionId });

      const results = [await read()];
      for (const lines of transcripts) {
        await writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
        results.push(await read());
      }
      // The widest page a caller may ask for, the page before it by cursor, and
      // an earlier message that is not there (#12496).
      const location = { projectsRoot, cwd, sessionId };
      const widest = await readClaudeLastMessage(location, { maxBytes: 49152 });
      const cursor = widest.status === "ok" ? widest.message?.nextCursor : null;
      if (!cursor) throw new Error("expected the widest page to leave text before it");
      results.push(
        widest,
        await readClaudeLastMessage(location, { cursor }),
        await readClaudeLastMessage(location, { messageIndex: 1 })
      );

      expect(results.map((result) => result.status)).toEqual([
        "unavailable",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "unavailable",
      ]);
      const validate = validator();
      for (const result of results) {
        const response = buildToolCallResult(result, { structuredContent: { ...result } });
        expect(response.isError).toBeUndefined();
        expect(validate(response.structuredContent), JSON.stringify(validate.errors)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the contradictions a flat schema would have let through", () => {
    const validate = validator();

    for (const payload of [
      { status: "ok" },
      { status: "unavailable", reason: "store-unknown", message: null },
      { status: "unavailable", reason: "subagent-not-found" },
      { ...OK_WITH_MESSAGE, extra: true },
      { ...OK_WITH_MESSAGE, message: { ...OK_WITH_MESSAGE.message, text: undefined } },
      { ...OK_WITH_MESSAGE, message: { ...OK_WITH_MESSAGE.message, nextCursor: undefined } },
    ]) {
      expect(validate(payload)).toBe(false);
    }
  });
});

describe("terminal.list isFocused field", () => {
  it("flags exactly one item when a panel matches focusedId", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "term-b",
      panelIds: ["term-a", "term-b", "term-c"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "agent", location: "grid" },
        "term-c": { id: "term-c", kind: "terminal", location: "dock" },
      },
    });

    const items = await callList(registerDefinitions());
    const focusedIds = items.filter((t) => t.isFocused).map((t) => t.id);
    expect(focusedIds).toEqual(["term-b"]);
  });

  it("returns isFocused:false for every item when focusedId is null", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "terminal", location: "grid" },
      },
    });

    const items = await callList(registerDefinitions());
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.isFocused === false)).toBe(true);
  });

  it("reports runtime-detected agents as agent terminals", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-runtime"],
      panelsById: {
        "term-runtime": {
          id: "term-runtime",
          kind: "terminal",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      },
    });

    const items = await callList(registerDefinitions());
    expect(items).toHaveLength(1);
    expect(items[0]?.agentId).toBe("claude");
  });
});

describe("terminal.list panel limit (#13382)", () => {
  it("counts every panel holding a limit slot, whatever the listing is filtered to", async () => {
    usePanelLimitStore.setState({ softWarningLimit: 2, confirmationLimit: 3, hardLimit: 4 });
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["grid-a", "dock-b", "bg-c", "trash-d", "dialog-e", "ephemeral-f"],
      panelsById: {
        "grid-a": { id: "grid-a", kind: "terminal", location: "grid", worktreeId: "wt-1" },
        "dock-b": { id: "dock-b", kind: "browser", location: "dock", worktreeId: "wt-2" },
        "bg-c": { id: "bg-c", kind: "terminal", location: "background", worktreeId: "wt-2" },
        "trash-d": { id: "trash-d", kind: "terminal", location: "trash" },
        "dialog-e": { id: "dialog-e", kind: "file", location: "dialog" },
        "ephemeral-f": {
          id: "ephemeral-f",
          kind: "terminal",
          location: "dock",
          excludeFromPersistence: true,
        },
      },
    });
    const result = z
      .object({ terminals: z.array(z.object({ id: z.string() })), panelLimit: z.unknown() })
      .parse(await runList(registerDefinitions(), { worktreeId: "wt-1" }));

    expect(result.terminals.map((t) => t.id)).toEqual(["grid-a"]);
    // Trash, dialog and non-persisted panels hold no slot; background ones do.
    expect(result.panelLimit).toEqual({
      count: 3,
      softWarningLimit: 2,
      confirmationLimit: 3,
      hardLimit: 4,
      tier: "confirm",
    });
  });

  it("advertises panelLimit as a required object beside the terminals", () => {
    const schema = z
      .object({
        properties: z.object({ panelLimit: z.object({ type: z.unknown() }) }),
        required: z.array(z.string()),
      })
      .parse(outputSchema(registerAll(), "terminal.list"));
    expect(schema.properties.panelLimit.type).toBe("object");
    expect(schema.required).toContain("panelLimit");
  });
});

describe("terminal.list owned argument (#12308)", () => {
  function seedPanels(): void {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "terminal", location: "grid" },
      },
    });
  }

  it("refuses owned:false too, because it cannot honour the argument either way", async () => {
    seedPanels();

    // A main-side strip that stopped working would otherwise surface as a
    // wrong answer on the `true` path and silence on the `false` one.
    await expect(callList(registerDefinitions(), { owned: false })).rejects.toThrow(/owned/);
  });

  it("lists normally when owned is omitted", async () => {
    seedPanels();

    const items = await callList(registerDefinitions(), { location: "grid" });
    expect(items.map((t) => t.id)).toEqual(["term-a", "term-b"]);
  });
});

/**
 * The read half of the client-metadata capability (#12340).
 *
 * `terminal.list` carries it rather than a second tool, which is what keeps the
 * feature to one external allowlist slot. Two things have to hold for that to
 * be safe: the default listing must stay the cheap inventory its description
 * promises, and the echo must never widen past the one reserved key — the bag
 * it sits in also holds `presetEnv`, a real subprocess environment.
 */
describe("terminal.list client metadata", () => {
  function seedTerminals(panelsById: Record<string, unknown>): void {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: Object.keys(panelsById),
      panelsById,
    });
  }

  it("omits the field entirely unless it is asked for", async () => {
    seedTerminals({
      "term-a": {
        id: "term-a",
        kind: "terminal",
        location: "grid",
        extensionState: { mcp: { session: "gc-1" } },
      },
    });

    const [row] = await callList(registerDefinitions());

    // The default listing is a cheap inventory, and these records are up to 2KB
    // each — an always-on echo would make every discovery call pay for them.
    expect(row).not.toHaveProperty("clientMetadata");
  });

  it("returns only the reserved key, never the bag holding presetEnv", async () => {
    seedTerminals({
      "term-a": {
        id: "term-a",
        kind: "terminal",
        location: "grid",
        extensionState: {
          mcp: { session: "gc-1" },
          presetEnv: { ANTHROPIC_API_KEY: "sk-secret" },
        },
      },
    });

    const [row] = await callList(registerDefinitions(), { includeClientMetadata: true });

    expect(row).toMatchObject({ clientMetadata: { session: "gc-1" } });
    expect(JSON.stringify(row)).not.toContain("sk-secret");
  });

  it("reports null for a terminal carrying no record", async () => {
    seedTerminals({
      "term-a": { id: "term-a", kind: "terminal", location: "grid" },
      "term-b": {
        id: "term-b",
        kind: "terminal",
        location: "grid",
        extensionState: { presetEnv: { TOKEN: "x" } },
      },
    });

    const rows = await callList(registerDefinitions(), { includeClientMetadata: true });

    expect(rows.map((r) => (r as { clientMetadata?: unknown }).clientMetadata)).toEqual([
      null,
      null,
    ]);
  });

  it("never exposes a plugin panel's own extension state", async () => {
    seedTerminals({
      p1: {
        id: "p1",
        kind: "acme.explorer",
        location: "grid",
        pluginId: "acme.explorer-plugin",
        extensionState: { root: "src", expanded: ["src"] },
      },
    });

    const [row] = await callList(registerDefinitions(), { includeClientMetadata: true });

    // The plugin bag is arbitrary view state under keys the plugin chose; only
    // the reserved key is this surface's to read.
    expect(row).toMatchObject({ clientMetadata: null });
    expect(JSON.stringify(row)).not.toContain("expanded");
  });

  it("does not read a plugin's own key that happens to be named 'mcp'", async () => {
    seedTerminals({
      p1: {
        id: "p1",
        kind: "acme.explorer",
        location: "grid",
        pluginId: "acme.explorer-plugin",
        extensionState: { mcp: { serverToken: "plugin-secret" } },
      },
    });

    const [row] = await callList(registerDefinitions(), { includeClientMetadata: true });

    // The reserved key is only reserved on panels the WRITER can reach. A
    // plugin owns its whole bag under keys it chooses, so reading `mcp` off
    // every listed panel would publish plugin state no external caller could
    // have written — and would escape this slice's 2KB and depth bounds too.
    expect(row).toMatchObject({ clientMetadata: null });
    expect(JSON.stringify(row)).not.toContain("plugin-secret");
  });

  it("does not read the key off a non-terminal built-in panel", async () => {
    seedTerminals({
      f1: {
        id: "f1",
        kind: "file",
        location: "grid",
        extensionState: { mcp: { note: "not-writable-here" } },
      },
    });

    const [row] = await callList(registerDefinitions(), { includeClientMetadata: true });

    expect(row).toMatchObject({ clientMetadata: null });
  });

  it("narrows to one terminal by id, and to none when nothing matches", async () => {
    seedTerminals({
      "term-a": { id: "term-a", kind: "terminal", location: "grid" },
      "term-b": { id: "term-b", kind: "terminal", location: "grid" },
    });

    expect(
      (await callList(registerDefinitions(), { terminalId: "term-b" })).map((r) => r.id)
    ).toEqual(["term-b"]);
    // A filter, not a lookup: the same empty answer every other filter gives.
    expect(await callList(registerDefinitions(), { terminalId: "term-zzz" })).toEqual([]);
  });

  it("answers a large metadata read rather than refusing it", async () => {
    const panelsById: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      panelsById[`term-${i}`] = {
        id: `term-${i}`,
        kind: "terminal",
        location: "grid",
        extensionState: { mcp: { blob: "x".repeat(2000) } },
      };
    }
    seedTerminals(panelsById);

    // A byte guard belongs downstream of the ownership filter, not here: main
    // strips `owned` before dispatch and intersects the rows only after this
    // returns, so refusing at renderer scope would fail `{ owned: true }` for a
    // caller whose own share of the fleet is one row, or none. Oversize is left
    // to the transport, which truncates and says so.
    const rows = await callList(registerDefinitions(), { includeClientMetadata: true });
    expect(rows).toHaveLength(40);

    // ...and narrowing still works, which is what the description points at.
    const narrowed = await callList(registerDefinitions(), {
      includeClientMetadata: true,
      terminalId: "term-7",
    });
    expect(narrowed).toHaveLength(1);
  });
});

describe("terminal.waitUntilIdle action definition", () => {
  it("registers a manifest entry with query/safe/renderer metadata", () => {
    const def = registerDefinitions().get("terminal.waitUntilIdle")?.() as AnyActionDefinition;
    expect(def).toBeDefined();
    expect(def.id).toBe("terminal.waitUntilIdle");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.scope).toBe("renderer");
    expect(def.mcpAnnotations?.readOnlyHint).toBe(true);
    expect(def.mcpAnnotations?.idempotentHint).toBe(false);
    expect(def.mcpAnnotations?.destructiveHint).toBe(false);
    expect(def.rawOutputSchema).toBeDefined();
  });

  it("validates required terminalId via the Zod argsSchema", () => {
    const def = registerDefinitions().get("terminal.waitUntilIdle")?.() as AnyActionDefinition;
    expect(def.argsSchema?.safeParse({ terminalId: "term-1" }).success).toBe(true);
    expect(def.argsSchema?.safeParse({ terminalId: "" }).success).toBe(false);
    expect(def.argsSchema?.safeParse({}).success).toBe(false);
    expect(def.argsSchema?.safeParse({ terminalId: "term-1", timeoutMs: 0 }).success).toBe(true);
    // Negative timeout — rejected by min(0).
    expect(def.argsSchema?.safeParse({ terminalId: "term-1", timeoutMs: -1 }).success).toBe(false);
  });

  it("throws when run() is invoked through renderer dispatch", async () => {
    // Guard for the manifest-only registration: the action exists in the
    // registry purely so `ActionService.list()` advertises it through the
    // standard MCP manifest. Execution must stay in the main process — if
    // the renderer ever dispatches it directly (bypassing the CallTool
    // short-circuit), the throw catches the bug at the callsite rather
    // than silently returning a malformed result.
    const def = registerDefinitions().get("terminal.waitUntilIdle")?.() as AnyActionDefinition;
    await expect(def.run({ terminalId: "term-1" }, {} as never)).rejects.toThrow(
      /must be invoked through the MCP main-process path/
    );
  });
});
