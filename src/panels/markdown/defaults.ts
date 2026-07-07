import type { MarkdownPanelData } from "@shared/types/panel";
import type { MarkdownPanelOptions } from "@shared/types/addPanelOptions";

export function createMarkdownDefaults(options: MarkdownPanelOptions): Partial<MarkdownPanelData> {
  return {
    markdownFilePath: options.markdownFilePath,
    markdownViewMode: options.markdownViewMode ?? "rendered",
  };
}
