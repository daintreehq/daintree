import { beforeEach, describe, expect, it } from "vitest";
import { setPanelStoreAccessor } from "../storeAccessors";
import {
  claimComposerSendSeq,
  getLastComposerSend,
  noteLastComposerSend,
  useLastComposerSendStore,
} from "../lastComposerSendStore";

let panelIds: string[] = ["t1", "t2"];

beforeEach(() => {
  useLastComposerSendStore.setState({ sends: {} });
  panelIds = ["t1", "t2"];
  setPanelStoreAccessor(() => ({
    panelsById: Object.fromEntries(panelIds.map((id) => [id, { id, kind: "terminal" }])) as never,
    panelIds,
    tabGroups: new Map(),
  }));
});

describe("lastComposerSendStore (#16746)", () => {
  it("keeps each pane's last message whole, images and all", () => {
    const long = "x".repeat(20_000);
    noteLastComposerSend("t1", long, ["/a.png", "/b.png"], claimComposerSendSeq());
    noteLastComposerSend("t2", "other", [], claimComposerSendSeq());

    expect(getLastComposerSend("t1")).toMatchObject({ text: long, imagePaths: ["/a.png", "/b.png"] });
    expect(getLastComposerSend("t2")).toMatchObject({ text: "other", imagePaths: [] });
  });

  it("keeps its own copy of the images", () => {
    const images = ["/a.png"];
    noteLastComposerSend("t1", "look", images, claimComposerSendSeq());
    images.push("/b.png");

    expect(getLastComposerSend("t1")?.imagePaths).toEqual(["/a.png"]);
  });

  it("replaces the message with a newer send, never with an older one answered late", () => {
    const older = claimComposerSendSeq();
    const newer = claimComposerSendSeq();
    noteLastComposerSend("t1", "newer", [], newer);
    noteLastComposerSend("t1", "older", [], older);
    expect(getLastComposerSend("t1")?.text).toBe("newer");

    noteLastComposerSend("t1", "newest", [], claimComposerSendSeq());
    expect(getLastComposerSend("t1")?.text).toBe("newest");
  });

  it("notes nothing for a blank send", () => {
    noteLastComposerSend("t1", "  \n", ["/a.png"], claimComposerSendSeq());
    expect(getLastComposerSend("t1")).toBeUndefined();
  });

  it("gives a pane already closed nothing back", () => {
    panelIds = ["t2"];
    noteLastComposerSend("t1", "late", [], claimComposerSendSeq());
    expect(getLastComposerSend("t1")).toBeUndefined();
  });

  it("forgets a pane's message on clear, and only that pane's", () => {
    noteLastComposerSend("t1", "one", [], claimComposerSendSeq());
    noteLastComposerSend("t2", "two", [], claimComposerSendSeq());
    useLastComposerSendStore.getState().clear("t1");

    expect(getLastComposerSend("t1")).toBeUndefined();
    expect(getLastComposerSend("t2")?.text).toBe("two");
  });
});
