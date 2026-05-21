import { describe, expect, it } from "vitest";

import type { DevPreviewPanelData } from "@shared/types/panel";

import { serializeDevPreview } from "../serializer";

function basePanel(overrides: Partial<DevPreviewPanelData> = {}): DevPreviewPanelData {
  return {
    id: "dp-1",
    kind: "dev-preview",
    title: "Dev Preview",
    location: "grid",
    cwd: "/tmp/project",
    ...overrides,
  } as DevPreviewPanelData;
}

describe("serializeDevPreview", () => {
  it("omits viewport emulation fields when unset", () => {
    const snapshot = serializeDevPreview(basePanel());
    expect(snapshot).not.toHaveProperty("viewportRotated");
    expect(snapshot).not.toHaveProperty("viewportDpr");
    expect(snapshot).not.toHaveProperty("viewportFit");
  });

  it("round-trips rotation, dpr, and fit when set", () => {
    const snapshot = serializeDevPreview(
      basePanel({
        viewportPreset: "ipad",
        viewportRotated: true,
        viewportDpr: 2,
        viewportFit: true,
      })
    );
    expect(snapshot).toMatchObject({
      viewportPreset: "ipad",
      viewportRotated: true,
      viewportDpr: 2,
      viewportFit: true,
    });
  });

  it("persists explicit falsey defaults so a restored panel is not ambiguous", () => {
    const snapshot = serializeDevPreview(
      basePanel({ viewportRotated: false, viewportDpr: 1, viewportFit: false })
    );
    expect(snapshot.viewportRotated).toBe(false);
    expect(snapshot.viewportDpr).toBe(1);
    expect(snapshot.viewportFit).toBe(false);
  });
});
