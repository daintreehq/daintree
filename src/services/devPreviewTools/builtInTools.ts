import {
  getAvailableDevPreviewTool,
  type DevPreviewToolDefinition,
} from "@/registry/devPreviewToolRegistry";
import { elementPickerTool } from "@/panels/dev-preview/element-picker/elementPickerTool";

/**
 * The tools every dev preview has of its own. No plugin owns them, so nothing
 * enables, declares or activates them, and no plugin going away ends them.
 */
export const BUILT_IN_DEV_PREVIEW_TOOLS: readonly DevPreviewToolDefinition[] = [
  // The session type is the tool's own business: the host only ever hands a
  // surface the session that the same tool's `createSession` produced.
  elementPickerTool as unknown as DevPreviewToolDefinition,
];

export function isBuiltInDevPreviewTool(toolId: string): boolean {
  return BUILT_IN_DEV_PREVIEW_TOOLS.some((tool) => tool.id === toolId);
}

/** A tool this preview may run right now: its own, or an enabled plugin's that declares it. */
export function resolveDevPreviewTool(toolId: string): DevPreviewToolDefinition | undefined {
  return (
    BUILT_IN_DEV_PREVIEW_TOOLS.find((tool) => tool.id === toolId) ??
    getAvailableDevPreviewTool(toolId)
  );
}
