import { beforeEach, describe, expect, it, vi } from "vitest";

let gate: typeof import("../panelRestoreGate");

beforeEach(async () => {
  vi.resetModules();
  gate = await import("../panelRestoreGate");
});

describe("panelRestoreGate", () => {
  it("reads nothing as restored until a first restore ends", () => {
    expect(gate.arePanelsRestored()).toBe(false);
    const end = gate.beginPanelRestore();
    expect(gate.arePanelsRestored()).toBe(false);
    end();
    expect(gate.arePanelsRestored()).toBe(true);
  });

  it("stays open while any of several restores is still running", () => {
    gate.beginPanelRestore()();
    const view = gate.beginPanelRestore();
    const host = gate.beginPanelRestore();

    host();
    expect(gate.arePanelsRestored()).toBe(false);
    view();
    expect(gate.arePanelsRestored()).toBe(true);
  });

  it("counts a restore's end once, however often it is called", () => {
    gate.beginPanelRestore()();
    const first = gate.beginPanelRestore();
    const second = gate.beginPanelRestore();

    first();
    first();
    expect(gate.arePanelsRestored()).toBe(false);
    second();
    expect(gate.arePanelsRestored()).toBe(true);
  });

  it("stays open after the store is emptied until a restore next ends", () => {
    gate.beginPanelRestore()();
    gate.markPanelsCleared();
    expect(gate.arePanelsRestored()).toBe(false);

    const end = gate.beginPanelRestore();
    expect(gate.arePanelsRestored()).toBe(false);
    end();
    expect(gate.arePanelsRestored()).toBe(true);
  });
});
