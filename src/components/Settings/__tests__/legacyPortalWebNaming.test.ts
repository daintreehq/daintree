import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("legacy Portal to Web naming boundary", () => {
  it("preserves persisted and action identifiers while presenting the settings tab as Web", () => {
    const ids = read("src/components/Settings/settingsTabIds.ts");
    const registry = read("src/components/Settings/settingsTabRegistry.tsx");
    const store = read("src/store/portalStore.ts");
    const actions = read("shared/config/actionIds.ts");

    expect(ids).toContain('"portal"');
    expect(registry).toMatch(/id: "portal",[\s\S]*?label: "Web"/);
    expect(store).toContain('name: "portal-storage"');
    expect(actions).toContain('"portal.toggle"');
  });

  it("keeps legacy command IDs but removes Portal from user-facing action titles", () => {
    const actionSources = [
      "src/services/actions/definitions/portalActions.ts",
      "src/services/actions/definitions/portalTabActions.ts",
      "src/services/actions/definitions/panelCoreActions.ts",
      "src/services/actions/definitions/devPreviewActions.ts",
    ].map(read);

    expect(actionSources.join("\n")).not.toMatch(/title: "[^"]*Portal/);
    expect(actionSources.join("\n")).toContain('id: "portal.toggle"');
    expect(read("shared/config/defaultKeybindings.ts")).toContain('category: "Web"');
  });
});
