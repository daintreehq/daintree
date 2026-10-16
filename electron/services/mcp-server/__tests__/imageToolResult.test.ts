import { describe, expect, it } from "vitest";
import { buildImageToolCallResult, isImageResultTool } from "../imageToolResult.js";
import { PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES } from "../../../../shared/types/pluginPanelCapture.js";

const PNG = Buffer.from("not really a png, but bytes").toString("base64");

function capture(data = PNG) {
  return {
    panelId: "p1",
    pluginId: "acme.dashboard",
    image: { mimeType: "image/png", data, width: 300, height: 200 },
    consoleScope: "plugin",
    consoleMessages: [{ level: "error", message: "boom" }],
  };
}

describe("buildImageToolCallResult", () => {
  it("is used for the panel capture only", () => {
    expect(isImageResultTool("plugin.capturePanel")).toBe(true);
    expect(isImageResultTool("browser.captureScreenshot")).toBe(false);
  });

  it("sends the pixels as an image block and the rest as text without them", () => {
    const result = buildImageToolCallResult(capture());

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    const text = result.content[1];
    expect(text?.type).toBe("text");
    const body = (text as { text: string }).text;
    expect(body).not.toContain(PNG);
    expect(JSON.parse(body)).toEqual({
      ...capture(),
      image: {
        mimeType: "image/png",
        width: 300,
        height: 200,
        bytes: Buffer.byteLength(PNG, "base64"),
      },
    });
  });

  it("returns an error, never a cut-down image, past the size cap", () => {
    const oversized = "A".repeat(Math.ceil(PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES / 3) * 4 + 4);
    const result = buildImageToolCallResult(capture(oversized));

    expect(result.isError).toBe(true);
    expect(result.content.every((block) => block.type === "text")).toBe(true);
  });

  it("falls back to the text path for anything not shaped like an image result", () => {
    const result = buildImageToolCallResult({ panelId: "p1" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });
});
