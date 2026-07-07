import type { MarkdownPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export function serializeMarkdown(t: MarkdownPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.markdownFilePath != null && { markdownFilePath: t.markdownFilePath }),
    ...(t.markdownViewMode != null && { markdownViewMode: t.markdownViewMode }),
  };
}
