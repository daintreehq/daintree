import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStore = vi.hoisted(() => {
  let data: Record<string, unknown> = {};
  return {
    reset(initial: Record<string, unknown>) {
      data = structuredClone(initial);
    },
    dump: () => data,
    get: vi.fn((key: string) => (data[key] === undefined ? undefined : structuredClone(data[key]))),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = structuredClone(value);
    }),
  };
});

vi.mock("../../store.js", () => ({ store: fakeStore }));

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));

import {
  _resetAgentToolbarPinsRevisionForTests,
  readAgentToolbarPins,
  readAgentToolbarPinsSnapshot,
  seedAgentToolbarPinsIfUnset,
  setAgentToolbarPin,
} from "../agentToolbarPins.js";
import { CHANNELS } from "../../ipc/channels.js";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds.js";
import type { CliAvailability } from "../../../shared/types/ipc/system.js";

function availability(installed: readonly string[]): CliAvailability {
  return Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => [id, installed.includes(id) ? "ready" : "missing"])
  ) as CliAvailability;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeStore.reset({});
  _resetAgentToolbarPinsRevisionForTests();
});

describe("agentToolbarPins (#14702)", () => {
  describe("readAgentToolbarPins", () => {
    it("reads nothing as no intent for any agent", () => {
      expect(readAgentToolbarPins()).toEqual({});
    });

    it("drops anything that isn't a boolean pin on a storable id", () => {
      fakeStore.reset({
        agentToolbarPins: {
          claude: true,
          gemini: "yes",
          "": true,
          constructor: false,
          codex: false,
        },
      });
      expect(readAgentToolbarPins()).toEqual({ claude: true, codex: false });
    });
  });

  describe("setAgentToolbarPin", () => {
    it("patches one agent against the stored map, so a stale view can't undo another's change", () => {
      fakeStore.reset({ agentToolbarPins: { claude: true } });
      // A second view, holding an older copy without gemini's pin, pins codex.
      setAgentToolbarPin("gemini", true);
      setAgentToolbarPin("codex", false);

      expect(fakeStore.dump().agentToolbarPins).toEqual({
        claude: true,
        gemini: true,
        codex: false,
      });
    });

    it("publishes each landed change to every window with a rising revision", () => {
      const first = setAgentToolbarPin("claude", true);
      const second = setAgentToolbarPin("claude", false);

      expect(second.revision).toBeGreaterThan(first.revision);
      expect(broadcastMock).toHaveBeenNthCalledWith(1, CHANNELS.AGENT_TOOLBAR_PINS_CHANGED, first);
      expect(broadcastMock).toHaveBeenNthCalledWith(2, CHANNELS.AGENT_TOOLBAR_PINS_CHANGED, second);
      expect(readAgentToolbarPinsSnapshot()).toEqual(second);
    });

    it("writes and publishes nothing when the pin already holds that value", () => {
      fakeStore.reset({ agentToolbarPins: { claude: true } });
      const before = readAgentToolbarPinsSnapshot();

      expect(setAgentToolbarPin("claude", true)).toEqual(before);
      expect(fakeStore.set).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("keeps a dotted agent id as one key", () => {
      setAgentToolbarPin("acme.helper", true);
      expect(fakeStore.dump().agentToolbarPins).toEqual({ "acme.helper": true });
    });

    it.each([["__proto__"], ["constructor"], [""], ["has space"], [42]])(
      "refuses %j as an agent id",
      (agentId) => {
        expect(() => setAgentToolbarPin(agentId as string, true)).toThrow("Invalid agentId");
        expect(fakeStore.set).not.toHaveBeenCalled();
      }
    );

    it("refuses a pin that isn't a boolean", () => {
      expect(() => setAgentToolbarPin("claude", "yes" as unknown as boolean)).toThrow(
        "Invalid pinned value"
      );
      expect(fakeStore.set).not.toHaveBeenCalled();
    });
  });

  describe("seedAgentToolbarPinsIfUnset", () => {
    it("pins the first five installed built-ins on a fresh install and unpins the rest", () => {
      // Every other agent, so the five picked reach past the registry's first five.
      const installed = BUILT_IN_AGENT_IDS.filter((_, index) => index % 2 === 1);
      expect(installed.length).toBeGreaterThan(5);

      expect(seedAgentToolbarPinsIfUnset(availability(installed))).toBe(true);

      const pins = fakeStore.dump().agentToolbarPins as Record<string, boolean>;
      const pinned = BUILT_IN_AGENT_IDS.filter((id) => pins[id]);
      expect(pinned).toEqual(installed.slice(0, 5));
      expect(Object.keys(pins).sort()).toEqual([...BUILT_IN_AGENT_IDS].sort());
      expect(broadcastMock).toHaveBeenCalledTimes(1);
    });

    it("seeds only once", () => {
      seedAgentToolbarPinsIfUnset(availability([BUILT_IN_AGENT_IDS[0]!]));
      const seeded = structuredClone(fakeStore.dump().agentToolbarPins);

      expect(seedAgentToolbarPinsIfUnset(availability(BUILT_IN_AGENT_IDS))).toBe(false);
      expect(fakeStore.dump().agentToolbarPins).toEqual(seeded);
    });

    it("never seeds over an upgraded profile, even one whose pins are all unset", () => {
      // Migration 038 leaves the key on every existing profile.
      fakeStore.reset({ agentToolbarPins: {} });

      expect(seedAgentToolbarPinsIfUnset(availability(BUILT_IN_AGENT_IDS))).toBe(false);
      expect(fakeStore.dump().agentToolbarPins).toEqual({});
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("lets a pin the person made first win over the first check", () => {
      setAgentToolbarPin("gemini", false);

      expect(seedAgentToolbarPinsIfUnset(availability(BUILT_IN_AGENT_IDS))).toBe(false);
      expect(fakeStore.dump().agentToolbarPins).toEqual({ gemini: false });
    });
  });
});
