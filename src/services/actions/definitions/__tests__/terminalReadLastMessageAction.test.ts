import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds: new Set<string>() }) },
}));
vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn() } }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { ActionService } from "../../../ActionService";
import { registerTerminalQueryActions } from "../terminalQueryActions";

const ID = "terminal.readLastMessageOwned";

function definition(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  registerTerminalQueryActions(registry, {} as ActionCallbacks);
  const factory = registry.get(ID);
  if (!factory) throw new Error(`${ID} is not registered`);
  return factory() as AnyActionDefinition;
}

function advertisedOutputSchema(): Record<string, unknown> {
  const service = new ActionService();
  service.register(definition());
  const schema = service.get(ID as ActionId)?.outputSchema;
  if (!schema) throw new Error("no output schema was generated");
  return schema as Record<string, unknown>;
}

const OK_WITH_MESSAGE = {
  status: "ok",
  provider: "claude",
  message: {
    id: "msg_1",
    text: "Verdict: ship it.",
    truncated: false,
    recordedAt: 1_767_225_600_000,
    stopReason: "end_turn",
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

describe("terminal.readLastMessageOwned (#12479)", () => {
  it("is a hidden, plugin-proof, read-only query", () => {
    const def = definition();

    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.denyPluginDispatch).toBe(true);
    expect(def.palette).toEqual({ mode: "hidden" });
    expect(def.mcpOutputSchema).toBe(true);
  });

  // Execution belongs to main, which holds the ownership ledger and can open
  // the transcript; a renderer dispatch reaching `run()` is a routing bug.
  it("refuses to run in the renderer", async () => {
    await expect(definition().run({ terminalId: "t-1" }, {} as never)).rejects.toThrow(
      /main-process path/
    );
  });

  it("takes a panel id and requires one", () => {
    const args = definition().argsSchema!;

    expect(args.safeParse({ terminalId: "t-1" }).success).toBe(true);
    expect(args.safeParse({}).success).toBe(false);
    expect(args.safeParse({ terminalId: "" }).success).toBe(false);
  });

  // A root union emits `oneOf` with no type, and the output gate forwards only
  // an object-rooted schema — so without the root type the tool would
  // advertise nothing and attach no structured content, silently.
  it("advertises an object-rooted output schema with one closed arm per status", () => {
    const schema = advertisedOutputSchema();

    expect(schema.type).toBe("object");
    const arms = schema.oneOf as Array<{ additionalProperties?: unknown }>;
    expect(arms).toHaveLength(2);
    for (const arm of arms) expect(arm.additionalProperties).toBe(false);
  });

  // Main builds this result by hand and nothing on the way validates it, so a
  // strict client's check against the advertised schema is the whole contract.
  it("accepts every shape the reader returns", () => {
    const validate = new Ajv2020({ strict: false }).compile(advertisedOutputSchema());

    for (const payload of [
      OK_WITH_MESSAGE,
      OK_QUESTION_ONLY,
      { status: "unavailable", reason: "store-unknown" },
      { status: "unavailable", reason: "search-cap-reached" },
    ]) {
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects the contradictions a flat schema would have let through", () => {
    const validate = new Ajv2020({ strict: false }).compile(advertisedOutputSchema());

    for (const payload of [
      { status: "ok" },
      { status: "unavailable", reason: "store-unknown", message: null },
      { status: "unavailable", reason: "subagent-not-found" },
      { ...OK_WITH_MESSAGE, extra: true },
      { ...OK_WITH_MESSAGE, message: { ...OK_WITH_MESSAGE.message, text: undefined } },
    ]) {
      expect(validate(payload)).toBe(false);
    }
  });
});
