import { describe, it, expect, vi } from "vitest";

const hintMocks = vi.hoisted(() => ({
  getState: vi.fn(() => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  getEffectiveCombo: vi.fn((_actionId: string): string | null => null),
  getDisplayCombo: vi.fn((_actionId: string): string => ""),
}));

vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("../../../store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.getEffectiveCombo,
    getDisplayCombo: hintMocks.getDisplayCombo,
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import type { ActionId } from "@shared/types/actions";
import { VIEWLESS_ACTIONS } from "../../../../electron/services/viewless/viewlessActionCatalog";
import { createActionRegistry } from "./helpers/wireSurface";

/**
 * The host runs these actions itself when no frontend is attached (#13495),
 * admitting each against the danger its catalog restates. A definition that
 * gains a confirmation would otherwise run there unattended.
 */
describe("viewless action catalog", () => {
  it.each(Object.entries(VIEWLESS_ACTIONS))(
    "declares %s with its renderer definition's danger",
    async (id, entry) => {
      const registry = await createActionRegistry();
      const definition = registry.get(id as ActionId)?.();

      expect(definition, `${id} is not a registered action`).toBeDefined();
      expect(entry.danger).toBe(definition?.danger);
    }
  );
});
