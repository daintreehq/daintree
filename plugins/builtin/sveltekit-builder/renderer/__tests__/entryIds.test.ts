import { describe, expect, it, vi } from "vitest";

vi.mock("@/registry/devPreviewToolRegistry", () => ({ registerDevPreviewTool: vi.fn() }));

import { ENTRY_PLUGIN_ID, ENTRY_TOOL_ID } from "../index.js";
import { BUTTON_PLUGIN_ID, DETECT_APPS_CHANNEL } from "../SiteBuilderButton.js";
import { BUILDER_TOOL_ID, CHANNELS, PLUGIN_ID } from "../../shared/protocol.js";

// The eager renderer entry repeats these ids as literals to keep zod out of the
// first-render bundle; a rename on one side must not silently orphan the other.
describe("eager entry ids", () => {
  it("match the protocol", () => {
    expect(ENTRY_PLUGIN_ID).toBe(PLUGIN_ID);
    expect(ENTRY_TOOL_ID).toBe(BUILDER_TOOL_ID);
    expect(BUTTON_PLUGIN_ID).toBe(PLUGIN_ID);
    expect(DETECT_APPS_CHANNEL).toBe(CHANNELS.detectApps);
  });
});
