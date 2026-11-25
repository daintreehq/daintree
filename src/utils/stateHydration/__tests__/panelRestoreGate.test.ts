import { describe, expect, it } from "vitest";
import { arePanelsRestored, beginPanelRestore, settlePanelRestore } from "../panelRestoreGate";

describe("panelRestoreGate", () => {
  it("counts panels as restored only once the latest restore settles", () => {
    expect(arePanelsRestored()).toBe(false);

    const first = beginPanelRestore();
    expect(arePanelsRestored()).toBe(false);
    settlePanelRestore(first);
    expect(arePanelsRestored()).toBe(true);

    // A view dropped and restored again starts over.
    const older = beginPanelRestore();
    const newer = beginPanelRestore();
    settlePanelRestore(older);
    expect(arePanelsRestored()).toBe(false);
    settlePanelRestore(newer);
    expect(arePanelsRestored()).toBe(true);
  });
});
