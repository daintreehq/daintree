import { describe, expect, it, vi } from "vitest";

const { mockOpenTour } = vi.hoisted(() => ({ mockOpenTour: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), getContext: vi.fn(() => ({})) },
}));

vi.mock("@/components/Tour/tourEvents", () => ({ openTour: mockOpenTour }));

import { makePluginTourId } from "@shared/utils/tourIds";
import { registerHelpActions } from "../helpActions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

function helpTourShow(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  // help.tour.show reaches no callback; every one is a stub.
  const callbacks: ActionCallbacks = new Proxy(Object.create(null), { get: () => vi.fn() });
  registerHelpActions(registry, callbacks);
  return registry.get("help.tour.show")!();
}

describe("help.tour.show", () => {
  it("still needs no arguments, so every existing caller keeps working", () => {
    const schema = helpTourShow().argsSchema!;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts any tour id as a string and nothing else", () => {
    const schema = helpTourShow().argsSchema!;
    // Whether a tour is registered under it is the host's call, not validation's.
    expect(schema.safeParse({ tourId: "plugin:missing/tour" }).success).toBe(true);
    expect(schema.safeParse({ tourId: 7 }).success).toBe(false);
  });

  it("opens the Daintree tour without arguments and the named tour with one", async () => {
    const action = helpTourShow();
    await action.run(undefined, {});
    await action.run({}, {});
    const acme = makePluginTourId("acme.tools", "welcome");
    await action.run({ tourId: acme }, {});
    expect(mockOpenTour.mock.calls).toEqual([[undefined], [undefined], [acme]]);
  });
});
