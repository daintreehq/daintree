import { describe, it, expect } from "vitest";
import { createDevPreviewDefaults } from "../defaults";
import type { DevPreviewPanelOptions } from "@shared/types/addPanelOptions";

function options(overrides: Partial<DevPreviewPanelOptions> = {}): DevPreviewPanelOptions {
  return {
    kind: "dev-preview",
    cwd: "/project",
    ...overrides,
  } as DevPreviewPanelOptions;
}

describe("createDevPreviewDefaults", () => {
  it("forwards devPreviewConsoleTab so the persisted tab survives restore", () => {
    expect(createDevPreviewDefaults(options({ devPreviewConsoleTab: "console" }))).toMatchObject({
      devPreviewConsoleTab: "console",
    });
  });

  it("leaves devPreviewConsoleTab undefined when not persisted", () => {
    expect(createDevPreviewDefaults(options()).devPreviewConsoleTab).toBeUndefined();
  });

  it("still forwards devPreviewConsoleOpen alongside the tab field", () => {
    const result = createDevPreviewDefaults(
      options({ devPreviewConsoleOpen: true, devPreviewConsoleTab: "console" })
    );
    expect(result.devPreviewConsoleOpen).toBe(true);
    expect(result.devPreviewConsoleTab).toBe("console");
  });
});
