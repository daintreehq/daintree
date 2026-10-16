import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES } from "../../../shared/types/pluginPanelCapture.js";
import { buildToolCallResult, buildToolCallTextResult } from "./toolCallResult.js";

/**
 * Tools whose result carries an `image: { mimeType, data, ... }` the agent
 * should see as pixels. The JSON text body is capped far below any real
 * screenshot, so base64 there would only ever arrive truncated (#13384).
 */
const IMAGE_RESULT_TOOLS: ReadonlySet<string> = new Set(["plugin.capturePanel"]);

/** Base64 length of the largest PNG a capture may return. */
const MAX_IMAGE_BASE64_CHARS = Math.ceil(PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES / 3) * 4;

export function isImageResultTool(toolId: string): boolean {
  return IMAGE_RESULT_TOOLS.has(toolId);
}

/**
 * The image as an MCP `image` block, followed by the rest of the result as
 * text with the bytes swapped for their size. Anything not shaped like an
 * image result goes back through the ordinary text path.
 */
export function buildImageToolCallResult(result: unknown): CallToolResult {
  const record =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const image =
    record?.image !== null && typeof record?.image === "object"
      ? (record.image as Record<string, unknown>)
      : null;
  if (!record || !image || image.mimeType !== "image/png" || typeof image.data !== "string") {
    return buildToolCallResult(result);
  }
  const data = image.data;
  if (data.length === 0 || data.length > MAX_IMAGE_BASE64_CHARS) {
    return buildToolCallTextResult("The captured image is empty or too large to return", {
      isError: true,
    });
  }
  const { data: _omitted, ...imageMeta } = image;
  const meta = { ...record, image: { ...imageMeta, bytes: Buffer.byteLength(data, "base64") } };
  const text = buildToolCallResult(meta);
  return {
    ...text,
    content: [{ type: "image", data, mimeType: "image/png" }, ...text.content],
  };
}
