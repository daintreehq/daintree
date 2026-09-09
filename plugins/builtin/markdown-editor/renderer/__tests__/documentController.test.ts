// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";

const { announceMock } = vi.hoisted(() => ({ announceMock: vi.fn() }));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
// A minimal panel store: the controller only needs `panelsById` and a live
// subscription to notice its panel being removed.
type PanelStoreShape = { panelsById: Record<string, { id: string }> };
const panelStoreHolder = vi.hoisted(() => ({
  store: null as UseBoundStore<StoreApi<PanelStoreShape>> | null,
}));
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  const store = create<PanelStoreShape>(() => ({
    panelsById: { "panel-1": { id: "panel-1" }, "panel-2": { id: "panel-2" } },
  }));
  panelStoreHolder.store = store;
  return { usePanelStore: store };
});

import { DocumentController, __resetDocumentControllersForTests } from "../documentController";
import { useDocumentStateStore } from "../documentStateStore";
import { getFileDocumentProjection, useFileDocumentStore } from "@/store/fileDocumentStore";
import { CHANNELS, PUSH_CHANNELS, identityKey } from "../../shared/protocol";
import { createFakeMain, sha, type FakeMain } from "./testHost";

const panelStore = () => panelStoreHolder.store!;

const PROPS = {
  panelId: "panel-1",
  filePath: "/repo/docs/plan.md",
  fileName: "plan.md",
  rootPath: "/repo",
  worktreePath: "/repo",
  projectId: "p1",
};
const IDENTITY = { projectId: "p1", worktreePath: "/repo", filePath: "/repo/docs/plan.md" };
const KEY = identityKey(IDENTITY);

let main: FakeMain;
let uninstall: () => void;

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

async function open(text = "# Plan\n"): Promise<DocumentController> {
  main.files.set(PROPS.filePath, text);
  const controller = DocumentController.acquire(PROPS);
  await flush();
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  main = createFakeMain();
  uninstall = main.install();
  announceMock.mockClear();
  panelStore().setState({
    panelsById: { "panel-1": { id: "panel-1" }, "panel-2": { id: "panel-2" } },
  });
  useFileDocumentStore.setState({ byPanelId: {} });
  useDocumentStateStore.setState({ records: {} });
});

afterEach(() => {
  __resetDocumentControllersForTests();
  uninstall();
  vi.useRealTimers();
});

describe("DocumentController (#12323)", () => {
  it("loads the document, publishes a clean projection, and reuses itself per panel", async () => {
    const controller = await open();
    const record = controller.record();
    expect(record.status).toBe("ready");
    expect(record.base?.text).toBe("# Plan\n");
    expect(record.loadGeneration).toBe(1);
    expect(getFileDocumentProjection("panel-1")).toMatchObject({
      identityKey: KEY,
      draftText: null,
      dirty: false,
      conflict: false,
    });
    expect(DocumentController.acquire(PROPS)).toBe(controller);
  });

  it("marks a draft dirty, previews it, and persists it after a second of quiet", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nedit\n");
    expect(getFileDocumentProjection("panel-1")).toMatchObject({
      dirty: true,
      draftText: "# Plan\n\nedit\n",
    });
    expect(main.calls.some((c) => c.channel === CHANNELS.draftPut)).toBe(false);
    await flush(1000);
    const put = main.calls.find((c) => c.channel === CHANNELS.draftPut);
    expect(put?.args).toMatchObject({
      generation: expect.any(Number),
      record: { draftText: "# Plan\n\nedit\n", baseRevision: sha("# Plan\n") },
    });
  });

  it("typing back to the base text clears the draft and its record", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nedit\n");
    await flush(1000);
    controller.setText("# Plan\n");
    await flush();
    expect(controller.record().draft).toBeNull();
    expect(getFileDocumentProjection("panel-1")?.dirty).toBe(false);
    expect(main.calls.filter((c) => c.channel === CHANNELS.draftDelete)).toHaveLength(1);
  });

  it("saves the draft, adopts the new revision, clears the record, and announces", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nedit\n");
    await expect(getFileDocumentProjection("panel-1")!.save()).resolves.toBe(true);
    const record = controller.record();
    expect(record.base).toMatchObject({
      text: "# Plan\n\nedit\n",
      revision: sha("# Plan\n\nedit\n"),
    });
    expect(record.draft).toBeNull();
    expect(main.files.get(PROPS.filePath)).toBe("# Plan\n\nedit\n");
    expect(main.calls.some((c) => c.channel === CHANNELS.draftDelete)).toBe(true);
    expect(announceMock).toHaveBeenCalledWith("Saved");
    // The debounced persist from before the save never fires.
    await flush(1000);
    expect(main.calls.some((c) => c.channel === CHANNELS.draftPut)).toBe(false);
  });

  it("an unedited save writes nothing", async () => {
    const controller = await open();
    await controller.save();
    const save = main.calls.find((c) => c.channel === CHANNELS.save);
    expect(save?.args).toMatchObject({ unchanged: true });
  });

  it("typing during an in-flight save stays dirty against the new revision", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nfirst\n");
    let release: (value: unknown) => void = () => {};
    main.overrides.set(
      CHANNELS.save,
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const saving = controller.save();
    await flush();
    controller.setText("# Plan\n\nfirst\n\nsecond\n");
    release({ status: "saved", revision: sha("# Plan\n\nfirst\n"), wrote: true });
    await expect(saving).resolves.toBe(false);
    const record = controller.record();
    expect(record.base?.text).toBe("# Plan\n\nfirst\n");
    expect(record.draft).toEqual({
      text: "# Plan\n\nfirst\n\nsecond\n",
      baseRevision: sha("# Plan\n\nfirst\n"),
    });
    expect(getFileDocumentProjection("panel-1")?.dirty).toBe(true);
  });

  it("a stale save becomes a conflict that blocks saving, then loading the disk version resolves it", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nmine\n");
    main.files.set(PROPS.filePath, "# Plan\n\ntheirs\n");
    await expect(controller.save()).resolves.toBe(false);
    expect(controller.record().conflict).toMatchObject({ text: "# Plan\n\ntheirs\n" });
    expect(getFileDocumentProjection("panel-1")?.conflict).toBe(true);
    expect(announceMock).toHaveBeenCalledWith("File changed on disk");
    // Ordinary save is held while the conflict stands.
    main.calls.length = 0;
    await expect(controller.save()).resolves.toBe(false);
    expect(main.calls.some((c) => c.channel === CHANNELS.save)).toBe(false);

    const generation = controller.record().loadGeneration;
    await controller.loadDiskVersion();
    const record = controller.record();
    expect(record.conflict).toBeNull();
    expect(record.draft).toBeNull();
    expect(record.base?.text).toBe("# Plan\n\ntheirs\n");
    expect(record.loadGeneration).toBe(generation + 1);
  });

  it("an external change while clean reloads with a fresh history", async () => {
    const controller = await open();
    const generation = controller.record().loadGeneration;
    main.files.set(PROPS.filePath, "# Plan\n\nagent\n");
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: KEY });
    await flush(200);
    const record = controller.record();
    expect(record.base?.text).toBe("# Plan\n\nagent\n");
    expect(record.loadGeneration).toBe(generation + 1);
    expect(record.draft).toBeNull();
  });

  it("an external change while dirty keeps the draft and raises a conflict", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nmine\n");
    main.files.set(PROPS.filePath, "# Plan\n\nagent\n");
    controller.sync({ changeTick: 1 });
    controller.sync({ changeTick: 2 });
    await flush(200);
    const record = controller.record();
    expect(record.draft?.text).toBe("# Plan\n\nmine\n");
    expect(record.conflict).toMatchObject({ text: "# Plan\n\nagent\n" });
  });

  it("ignores a document-changed push for another document", async () => {
    const controller = await open();
    main.calls.length = 0;
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: "someone else" });
    await flush(200);
    expect(main.calls.some((c) => c.channel === CHANNELS.revalidate)).toBe(false);
    expect(controller.record().loadGeneration).toBe(1);
  });

  it("a deleted file is reported unavailable and the draft is kept", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nmine\n");
    main.files.delete(PROPS.filePath);
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: KEY });
    await flush(200);
    expect(controller.record().status).toBe("unavailable");
    expect(controller.record().draft?.text).toBe("# Plan\n\nmine\n");
    expect(getFileDocumentProjection("panel-1")).toMatchObject({ dirty: true, conflict: true });
  });

  it("restores a stored draft on open, as a conflict when the base moved", async () => {
    main.drafts.set(KEY, {
      generation: 1,
      record: {
        stateVersion: 1,
        identity: IDENTITY,
        baseRevision: sha("# Plan\n"),
        baseText: "# Plan\n",
        draftText: "# Plan\n\nrecovered\n",
        hasBom: false,
        eol: "\n",
        updatedAt: 1,
      },
    });
    const controller = await open("# Plan\n");
    expect(controller.record().draft?.text).toBe("# Plan\n\nrecovered\n");
    expect(controller.record().conflict).toBeNull();
    __resetDocumentControllersForTests();

    main.drafts.set(KEY, {
      generation: 1,
      record: {
        stateVersion: 1,
        identity: IDENTITY,
        baseRevision: sha("old base"),
        baseText: "old base",
        draftText: "old base plus draft",
        hasBom: false,
        eol: "\n",
        updatedAt: 1,
      },
    });
    const moved = await open("# Plan v2\n");
    expect(moved.record().draft?.text).toBe("old base plus draft");
    expect(moved.record().conflict).toMatchObject({ text: "# Plan v2\n" });
    expect(announceMock).toHaveBeenCalledWith("Recovered draft, file changed on disk");
  });

  it("discard drops the draft and record and reloads the editor", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nedit\n");
    const generation = controller.record().loadGeneration;
    await getFileDocumentProjection("panel-1")!.discard();
    expect(controller.record().draft).toBeNull();
    expect(controller.record().loadGeneration).toBe(generation + 1);
    expect(main.calls.some((c) => c.channel === CHANNELS.draftDelete)).toBe(true);
    // The debounced put from before the discard never lands.
    await flush(1000);
    expect(main.calls.some((c) => c.channel === CHANNELS.draftPut)).toBe(false);
  });

  it("two panels on one document share the record and keep it until the last leaves", async () => {
    const first = await open();
    const second = DocumentController.acquire({ ...PROPS, panelId: "panel-2" });
    await flush();
    expect(second.key).toBe(first.key);
    first.setText("# Plan\n\nshared\n");
    expect(second.record().draft?.text).toBe("# Plan\n\nshared\n");
    expect(getFileDocumentProjection("panel-2")?.dirty).toBe(true);

    panelStore().setState({ panelsById: { "panel-2": { id: "panel-2" } } });
    await flush();
    expect(getFileDocumentProjection("panel-1")).toBeUndefined();
    expect(useDocumentStateStore.getState().records[KEY]).toBeDefined();
    expect(DocumentController.get("panel-1")).toBeUndefined();

    panelStore().setState({ panelsById: {} });
    await flush();
    expect(useDocumentStateStore.getState().records[KEY]).toBeUndefined();
    expect(main.calls.filter((c) => c.channel === CHANNELS.release)).toHaveLength(2);
  });

  it("a sibling panel joins the document without reloading over its draft", async () => {
    const first = await open();
    first.setText("# Plan\n\nunsaved\n");
    main.calls.length = 0;
    const second = DocumentController.acquire({ ...PROPS, panelId: "panel-2" });
    await flush();
    expect(second.record().draft?.text).toBe("# Plan\n\nunsaved\n");
    expect(main.calls.some((c) => c.channel === CHANNELS.read)).toBe(false);
    expect(main.calls.some((c) => c.channel === CHANNELS.attach)).toBe(true);
  });

  it("a save finished by a panel that has since closed still settles the shared record", async () => {
    const first = await open();
    const second = DocumentController.acquire({ ...PROPS, panelId: "panel-2" });
    await flush();
    first.setText("# Plan\n\nboth\n");
    let release: (value: unknown) => void = () => {};
    main.overrides.set(
      CHANNELS.save,
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const saving = first.save();
    await flush();
    expect(second.record().saving).toBe(true);
    panelStore().setState({ panelsById: { "panel-2": { id: "panel-2" } } });
    await flush();
    release({ status: "saved", revision: sha("# Plan\n\nboth\n"), wrote: true });
    await saving;
    expect(second.record().saving).toBe(false);
    expect(second.record().draft).toBeNull();
    expect(second.record().base?.text).toBe("# Plan\n\nboth\n");
  });

  it("undoing back to the old base during a save keeps the document dirty against the new one", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nedit\n");
    let release: (value: unknown) => void = () => {};
    main.overrides.set(
      CHANNELS.save,
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const saving = controller.save();
    await flush();
    controller.setText("# Plan\n");
    release({ status: "saved", revision: sha("# Plan\n\nedit\n"), wrote: true });
    await expect(saving).resolves.toBe(false);
    const record = controller.record();
    expect(record.base?.text).toBe("# Plan\n\nedit\n");
    expect(record.draft).toEqual({ text: "# Plan\n", baseRevision: sha("# Plan\n\nedit\n") });
  });

  it("typing while a clean reload is in flight becomes a conflict, never a silent overwrite", async () => {
    const controller = await open();
    let releaseRead: (value: unknown) => void = () => {};
    main.overrides.set(
      CHANNELS.read,
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    main.files.set(PROPS.filePath, "# Plan\n\nagent\n");
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: KEY });
    await flush(200);
    controller.setText("# Plan\n\nme\n");
    releaseRead({
      status: "ok",
      text: "# Plan\n\nagent\n",
      revision: sha("# Plan\n\nagent\n"),
      hasBom: false,
      eol: "\n",
      mixedEol: false,
      size: 14,
    });
    await flush();
    const record = controller.record();
    expect(record.draft?.text).toBe("# Plan\n\nme\n");
    expect(record.base?.text).toBe("# Plan\n");
    expect(record.conflict).toMatchObject({ text: "# Plan\n\nagent\n" });
  });

  it("Load disk version keeps the draft when the disk version cannot be read", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nmine\n");
    main.files.set(PROPS.filePath, "# Plan\n\ntheirs\n");
    await controller.save();
    expect(controller.record().conflict).not.toBeNull();
    main.overrides.set(CHANNELS.read, () => ({ status: "refused", reason: "NOT_UTF8" }));
    await controller.loadDiskVersion();
    const record = controller.record();
    expect(record.draft?.text).toBe("# Plan\n\nmine\n");
    expect(record.conflict).not.toBeNull();
    expect(record.error).toMatch(/draft is kept/);
    expect(main.calls.some((c) => c.channel === CHANNELS.draftDelete)).toBe(false);
  });

  it("an external change whose new version cannot be read still holds Save", async () => {
    const controller = await open();
    controller.setText("# Plan\n\nmine\n");
    main.files.set(PROPS.filePath, "changed");
    main.overrides.set(CHANNELS.read, () => ({ status: "refused", reason: "NOT_UTF8" }));
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: KEY });
    await flush(200);
    expect(controller.record().conflict).toMatchObject({ text: null, revision: sha("changed") });
    await expect(controller.save()).resolves.toBe(false);
  });

  it("the panel switching to another file releases the binding", async () => {
    const controller = await open();
    controller.setText("# Plan\n\ndraft\n");
    panelStore().setState({
      panelsById: {
        "panel-1": { id: "panel-1", kind: "file", filePath: "/repo/other.md" } as never,
        "panel-2": { id: "panel-2" },
      },
    });
    await flush();
    expect(DocumentController.get("panel-1")).toBeUndefined();
    expect(getFileDocumentProjection("panel-1")).toBeUndefined();
    // The orphaned draft was written for recovery on the way out.
    expect(main.drafts.get(KEY)?.record.draftText).toBe("# Plan\n\ndraft\n");
  });

  it("a draft discarded, closed and reopened persists again with a later generation", async () => {
    const controller = await open();
    controller.setText("# Plan\n\none\n");
    await flush(1000);
    await controller.discard();
    panelStore().setState({ panelsById: { "panel-2": { id: "panel-2" } } });
    await flush();
    panelStore().setState({
      panelsById: { "panel-1": { id: "panel-1" }, "panel-2": { id: "panel-2" } },
    });
    const again = DocumentController.acquire(PROPS);
    await flush();
    again.setText("# Plan\n\ntwo\n");
    await flush(1000);
    expect(main.drafts.get(KEY)?.record.draftText).toBe("# Plan\n\ntwo\n");
    expect(again.record().storageWarning).toBeNull();
  });

  it("a file missing at open still surfaces its stored draft, and loads once the file is back", async () => {
    main.drafts.set(KEY, {
      generation: 1,
      record: {
        stateVersion: 1,
        identity: IDENTITY,
        baseRevision: sha("# Plan\n"),
        baseText: "# Plan\n",
        draftText: "# Plan\n\nkept\n",
        hasBom: false,
        eol: "\n",
        updatedAt: 1,
      },
    });
    const controller = DocumentController.acquire(PROPS);
    await flush();
    expect(controller.record().status).toBe("unavailable");
    expect(controller.record().draft?.text).toBe("# Plan\n\nkept\n");
    expect(getFileDocumentProjection("panel-1")).toMatchObject({ dirty: true, conflict: true });

    main.files.set(PROPS.filePath, "# Plan\n");
    main.push(PUSH_CHANNELS.documentChanged, { identityKey: KEY });
    await flush(200);
    const record = controller.record();
    expect(record.status).toBe("ready");
    expect(record.base?.text).toBe("# Plan\n");
    expect(record.draft?.text).toBe("# Plan\n\nkept\n");
    expect(record.conflict).toBeNull();
  });

  it("a panel removed mid-draft persists the record immediately for recovery", async () => {
    const controller = await open();
    controller.setText("# Plan\n\norphan\n");
    panelStore().setState({ panelsById: { "panel-2": { id: "panel-2" } } });
    await flush();
    const put = main.calls.find((c) => c.channel === CHANNELS.draftPut);
    expect(put?.args).toMatchObject({ record: { draftText: "# Plan\n\norphan\n" } });
  });

  it("a refused document publishes the refusal and never persists", async () => {
    main.overrides.set(CHANNELS.read, () => ({ status: "refused", reason: "NOT_UTF8" }));
    const controller = await open();
    expect(controller.record()).toMatchObject({ status: "refused", refusal: "NOT_UTF8" });
    controller.setText("anything");
    await flush(1000);
    expect(main.calls.some((c) => c.channel === CHANNELS.draftPut)).toBe(false);
  });

  it("surfaces a full recovery store as a warning while keeping the draft", async () => {
    const controller = await open();
    main.overrides.set(CHANNELS.draftPut, () => ({ status: "full", records: 50, bytes: 1 }));
    controller.setText("# Plan\n\nedit\n");
    await flush(1000);
    expect(controller.record().storageWarning).toMatch(/recovery storage is full/);
    expect(controller.record().draft?.text).toBe("# Plan\n\nedit\n");
  });

  it("refuses a draft that grew past the byte ceiling and says so", async () => {
    const controller = await open();
    controller.setText("x".repeat(2 * 1024 * 1024 + 1));
    expect(controller.record().error).toMatch(/over 2 MiB/);
    await expect(controller.save()).resolves.toBe(false);
    expect(main.calls.some((c) => c.channel === CHANNELS.save)).toBe(false);
  });
});
