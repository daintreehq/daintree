// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginFileEditorCandidate } from "@/registry/fileEditorRegistry";

const { notifyDiskChange, retain } = vi.hoisted(() => ({
  notifyDiskChange: vi.fn(() => Promise.resolve()),
  retain: vi.fn(() => () => {}),
}));
vi.mock("@/services/plugin/pluginFileDocument", () => ({
  openPluginFileDocument: () => ({ document: {}, retain, notifyDiskChange }),
}));
vi.mock("@/components/Plugin/PluginHostedView", () => ({
  PluginHostedView: () => <div data-testid="hosted-view" />,
}));

import PluginFileEditorHost from "../PluginFileEditorHost";

const candidate = {
  choiceId: "daintree.csv-viewer/table",
  pluginId: "daintree.csv-viewer",
  pluginName: "CSV viewer",
  builtin: true,
  editor: { id: "table", mode: "view", extensions: ["csv"], paths: [], maxBytes: 2097152 },
  view: {},
} as unknown as PluginFileEditorCandidate;

function host(changeTick: number, refreshEpoch: number) {
  return (
    <PluginFileEditorHost
      panelId="panel-1"
      projectId="project-1"
      filePath="/repo/users.csv"
      fileName="users.csv"
      rootPath="/repo"
      candidate={candidate}
      changeTick={changeTick}
      refreshEpoch={refreshEpoch}
    />
  );
}

afterEach(() => {
  notifyDiskChange.mockClear();
});

describe("PluginFileEditorHost", () => {
  it("re-checks the document on a change or a refresh, never on the values it mounted with", () => {
    const view = render(host(3, 7));
    expect(notifyDiskChange).not.toHaveBeenCalled();

    view.rerender(host(3, 8));
    expect(notifyDiskChange).toHaveBeenCalledTimes(1);

    view.rerender(host(4, 8));
    expect(notifyDiskChange).toHaveBeenCalledTimes(2);

    view.rerender(host(4, 8));
    expect(notifyDiskChange).toHaveBeenCalledTimes(2);

    // A Refresh that moves both in one commit is one re-check.
    view.rerender(host(5, 9));
    expect(notifyDiskChange).toHaveBeenCalledTimes(3);
  });
});
