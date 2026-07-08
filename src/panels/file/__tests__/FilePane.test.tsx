// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// FilePane forwards a fixed prop list to ContentPanel; #10991 was a dropped
// `showRestoreControl`, which hid the inline "Move to grid" button on a docked
// single file panel. Stub ContentPanel to capture what FilePane forwards, and
// mock the heavy store/client/viewer surface so we render only FilePane's own
// wiring — the seam that shipped the bug.
const contentPanelProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: Record<string, unknown>) => {
    contentPanelProps.push(props);
    return null;
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ panelsById: {}, setFileViewMode: vi.fn(), setFilePanelPath: vi.fn() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ markdownWrapLines: false, setMarkdownWrapLines: vi.fn() }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector({ worktrees: new Map() }),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));
vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn().mockResolvedValue({ content: "" }),
    search: vi.fn().mockResolvedValue({ files: [] }),
  },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({ MarkdownViewer: () => null }));
vi.mock("@/components/FileViewer/CodeViewer", () => ({ CodeViewer: () => null }));

import { FilePane } from "../FilePane";

function lastContentPanelProps(): Record<string, unknown> {
  const props = contentPanelProps.at(-1);
  if (!props) throw new Error("ContentPanel was not rendered");
  return props;
}

afterEach(() => {
  contentPanelProps.length = 0;
});

describe("FilePane restore-control wiring", () => {
  it("forwards showRestoreControl so a single docked file panel shows the inline restore button", () => {
    render(
      <FilePane
        id="file-1"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={true}
      />
    );

    const props = lastContentPanelProps();
    expect(props.showRestoreControl).toBe(true);
    expect(props.onRestore).toBeTypeOf("function");
  });

  it("forwards showRestoreControl=false so grouped docked panels keep the inline button hidden", () => {
    render(
      <FilePane
        id="file-2"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={false}
      />
    );

    expect(lastContentPanelProps().showRestoreControl).toBe(false);
  });
});
