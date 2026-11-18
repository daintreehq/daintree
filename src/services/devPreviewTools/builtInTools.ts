import type { DevPreviewToolDefinition } from "./types";
import { elementPickerTool } from "@/panels/dev-preview/element-picker/elementPickerTool";

/** The tools every dev preview has of its own. */
export const BUILT_IN_DEV_PREVIEW_TOOLS: readonly DevPreviewToolDefinition[] = [
  // The session type is the tool's own business: the host only ever hands a
  // surface the session that the same tool's `createSession` produced.
  elementPickerTool as unknown as DevPreviewToolDefinition,
];

/**
 * The tools a browser panel hosts while it shows a local page: the picker, and
 * nothing that assumes a dev server the panel itself started.
 */
export const BROWSER_PANEL_TOOLS: readonly DevPreviewToolDefinition[] =
  BUILT_IN_DEV_PREVIEW_TOOLS.filter((tool) => tool.id === elementPickerTool.id);

export function resolveDevPreviewTool(toolId: string): DevPreviewToolDefinition | undefined {
  return BUILT_IN_DEV_PREVIEW_TOOLS.find((tool) => tool.id === toolId);
}
