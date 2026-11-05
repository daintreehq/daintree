import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../WorkspaceHostProcess.js", () => ({ WorkspaceHostProcess: class {} }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock("../events.js", () => ({ events: { emit: vi.fn() } }));
vi.mock("../ProjectStore.js", () => ({
  projectStore: { getProjectSettings: vi.fn(), resolveProjectIdForPath: vi.fn() },
}));
vi.mock("../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { WorkspaceClient } from "../WorkspaceClient.js";
import type { CopyTreeOperationOwner } from "../copyTreeOperationOwner.js";

const OWNER: CopyTreeOperationOwner = { workspaceId: "ws-a", endpointId: "local:1" };

describe("WorkspaceClient CopyTree ownership (#16275)", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    client = new WorkspaceClient({});
  });

  afterEach(() => {
    client.dispose();
  });

  it("hands each run's owner, and a sweep's predicate, to the CopyTree client", async () => {
    const copyTree = client["copyTree"];
    const generate = vi
      .spyOn(copyTree, "generateContext")
      .mockResolvedValue({ content: "", fileCount: 0 });
    const listing = vi.spyOn(copyTree, "getContextFileTree").mockResolvedValue([]);
    const config = vi
      .spyOn(copyTree, "testConfig")
      .mockResolvedValue({ includedFiles: 0, includedSize: 0 });
    const sweep = vi.spyOn(copyTree, "cancelAllContext");
    const matches = (owner: CopyTreeOperationOwner) => owner.workspaceId === "ws-a";

    await client.generateContext("/a", {}, undefined, "/tmp/a.xml", OWNER);
    await client.getContextFileTree("/a", "src", {}, true, OWNER);
    await client.testConfig("/a", {}, OWNER);
    client.cancelAllContext(matches);

    expect(generate).toHaveBeenCalledWith("/a", {}, undefined, "/tmp/a.xml", OWNER);
    expect(listing).toHaveBeenCalledWith("/a", "src", {}, true, OWNER);
    expect(config).toHaveBeenCalledWith("/a", {}, OWNER);
    expect(sweep).toHaveBeenCalledWith(matches);
  });
});
