import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() }),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: () => null,
    getDisplayCombo: () => "",
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { actionService } from "@/services/ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import { resolveInteractiveActionId } from "../resolveInteractiveActionId";

const base = {
  description:
    "A test action for checking which action a keyboard shortcut or command HUD row ends up running.",
  category: "test",
  kind: "command",
  danger: "safe",
  scope: "renderer",
} as const;

const SOURCE = "git.commit" as ActionId;
const TARGET = "worktree.openReviewHub" as ActionId;
const PLAIN = "git.push" as ActionId;
const openTarget = vi.fn(async () => undefined);

beforeAll(() => {
  actionService.register({
    ...base,
    id: SOURCE,
    title: "Commit",
    palette: { mode: "redirect", to: TARGET },
    argsSchema: z.object({ message: z.string().min(1) }),
    run: vi.fn(async () => undefined),
  } as ActionDefinition);
  actionService.register({
    ...base,
    id: TARGET,
    title: "Open Review Hub",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: openTarget,
  } as ActionDefinition);
  actionService.register({
    ...base,
    id: PLAIN,
    title: "Push",
    run: vi.fn(async () => undefined),
  } as ActionDefinition);
});

describe("resolveInteractiveActionId", () => {
  it("turns an arg-requiring redirect source that a shortcut can't run into one it can", async () => {
    const raw = await actionService.dispatch(SOURCE, undefined, { source: "keybinding" });
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.error.code).toBe("VALIDATION_ERROR");

    const resolved = resolveInteractiveActionId(SOURCE);
    expect(resolved).toBe(TARGET);
    const result = await actionService.dispatch(resolved, undefined, { source: "keybinding" });
    expect(result.ok).toBe(true);
    expect(openTarget).toHaveBeenCalledTimes(1);
  });

  it("leaves an action with no redirect, and an unregistered id, as they are", () => {
    expect(resolveInteractiveActionId(PLAIN)).toBe(PLAIN);
    expect(resolveInteractiveActionId("never.registered" as ActionId)).toBe("never.registered");
  });
});
