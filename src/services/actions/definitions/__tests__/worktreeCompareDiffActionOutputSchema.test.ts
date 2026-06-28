import { describe, expect, it, vi } from "vitest";
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

// worktreeContextActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: vi.fn(() => ({ getState: () => ({ worktrees: new Map() }) })),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/store/uiStore", () => ({ useUIStore: { getState: vi.fn(() => ({})) } }));
vi.mock("@/lib/copyTreeFormat", () => ({ DEFAULT_COPYTREE_FORMAT: "xml" }));

import { ActionService } from "../../../ActionService";
import { registerWorktreeContextActions } from "../worktreeContextActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerWorktreeContextActions(registry, { onInject: vi.fn() } as unknown as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

// #10684 — worktree.compareDiff opts into MCP structuredContent by carrying
// `mcpOutputSchema: true` alongside a top-level object resultSchema. Registering
// through the real ActionService exercises the Zod -> JSON Schema conversion, so
// these assert the *generated* schema, not the literal flag.
describe("worktree.compareDiff emits a manifest outputSchema (#10684)", () => {
  it("generates an object-typed outputSchema with branch1/branch2/files", () => {
    const schema = outputSchema(registerAll(), "worktree.compareDiff");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
    const props = (schema!.properties as Record<string, unknown>) ?? {};
    expect(props.branch1).toBeDefined();
    expect(props.branch2).toBeDefined();
    expect(props.files).toBeDefined();
  });

  it("advertises files as an array of file entries", () => {
    const schema = outputSchema(registerAll(), "worktree.compareDiff")!;
    const files = (schema.properties as { files: Record<string, unknown> }).files;
    expect(files.type).toBe("array");
    const itemProps =
      ((files.items as Record<string, unknown>)?.properties as Record<string, unknown>) ?? {};
    expect(itemProps.path).toBeDefined();
    expect(itemProps.status).toBeDefined();
    expect(itemProps.insertions).toBeDefined();
    expect(itemProps.deletions).toBeDefined();
  });

  it("requires the top-level result keys and encodes nullable line counts", () => {
    const schema = outputSchema(registerAll(), "worktree.compareDiff")!;
    const required = (schema.required as string[] | undefined) ?? [];
    expect(required).toEqual(expect.arrayContaining(["branch1", "branch2", "files"]));

    const files = (schema.properties as { files: Record<string, unknown> }).files;
    const items = files.items as Record<string, unknown>;
    const itemRequired = (items.required as string[] | undefined) ?? [];
    expect(itemRequired).toEqual(
      expect.arrayContaining(["path", "status", "insertions", "deletions"])
    );
    // insertions/deletions are `number | null` — the schema must admit null, not
    // just number, or a strict MCP client would reject a binary-file entry.
    const itemProps = items.properties as Record<string, unknown>;
    expect(JSON.stringify(itemProps.insertions)).toContain("null");
  });

  it("marks only compareToWorktreeId as a required input", () => {
    const entry = registerAll().get("worktree.compareDiff" as ActionId);
    const required = ((entry?.inputSchema?.required as string[] | undefined) ?? []).slice();
    expect(required).toEqual(["compareToWorktreeId"]);
  });

  it("classifies the action as a read-only query with read-only annotations", () => {
    const entry = registerAll().get("worktree.compareDiff" as ActionId);
    expect(entry?.kind).toBe("query");
    expect(entry?.danger).toBe("safe");
    expect(entry?.mcpAnnotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });
});
