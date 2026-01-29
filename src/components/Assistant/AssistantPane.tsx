import { ContentPanel, type BasePanelProps } from "@/components/Panel";

export type AssistantPaneProps = BasePanelProps;

export function AssistantPane({
  id,
  title,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  isTrashing = false,
  gridPanelCount,
}: AssistantPaneProps) {
  return (
    <ContentPanel
      id={id}
      title={title}
      kind="assistant"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
    >
      <div className="flex flex-col h-full bg-canopy-bg">
        <div className="flex-1 overflow-auto p-4">
          <p className="text-muted-foreground">Assistant ready</p>
        </div>
        <div className="border-t border-divider p-2">
          <input
            type="text"
            placeholder="Ask the assistant..."
            className="w-full bg-canopy-sidebar text-canopy-text px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-canopy-accent"
          />
        </div>
      </div>
    </ContentPanel>
  );
}
