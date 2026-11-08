// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyPopOut } from "@shared/types/ipc/canopy";
import { ALL_HOSTS_ID, useCanopyStore } from "@/store/canopyStore";
import {
  captureCanopyPopOut,
  popOutCanopyDialog,
  registerCanopyInboxPlace,
  type CanopyInboxPlace,
} from "../canopyPopOut";

const popOut = vi.fn<(place: CanopyPopOut) => Promise<void>>();

beforeEach(() => {
  popOut.mockReset();
  popOut.mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    value: { canopyWindow: { popOut } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    mode: "unset",
    hostId: null,
    roleFilter: "all",
    unreadOnly: false,
    archivedExpanded: false,
    trashExpanded: false,
    workOf: null,
  });
  delete window.__DAINTREE_HOST_ID__;
});

const inboxPlace = (over: Partial<CanopyInboxPlace> = {}): CanopyInboxPlace => ({
  hostId: "studio",
  query: "deploy",
  selection: { kind: "worker", runId: "run-2" },
  keptUnread: new Set(["run-2", "run-5"]),
  ...over,
});

describe("what a popped-out dialog carries (#16338)", () => {
  it("takes the inbox's host, search and row, and the store's filters", () => {
    useCanopyStore.setState({
      roleFilter: "assistants",
      unreadOnly: true,
      archivedExpanded: true,
      trashExpanded: true,
      workOf: { assistantId: "assistant-1", name: "Planner" },
    });
    const stop = registerCanopyInboxPlace(() => inboxPlace());

    expect(captureCanopyPopOut()).toEqual({
      hostId: "studio",
      query: "deploy",
      selection: { kind: "worker", runId: "run-2" },
      roleFilter: "assistants",
      unreadOnly: true,
      keptUnread: ["run-2", "run-5"],
      archivedExpanded: true,
      trashExpanded: true,
      workOf: { assistantId: "assistant-1", name: "Planner" },
    });
    stop();
  });

  it("carries an assistant selected in place of a worker", () => {
    const stop = registerCanopyInboxPlace(() =>
      inboxPlace({ selection: { kind: "assistant", assistantId: "assistant-7" } })
    );
    expect(captureCanopyPopOut().selection).toEqual({
      kind: "assistant",
      assistantId: "assistant-7",
    });
    stop();
  });

  it("keeps no read rows when Unread isn't on", () => {
    const stop = registerCanopyInboxPlace(() => inboxPlace());
    expect(captureCanopyPopOut().keptUnread).toEqual([]);
    stop();
  });

  it("carries the host and filters alone while no inbox is mounted, naming the own host", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    useCanopyStore.setState({ unreadOnly: true });

    expect(captureCanopyPopOut()).toMatchObject({
      hostId: "studio",
      query: "",
      selection: null,
      unreadOnly: true,
      keptUnread: [],
    });
    useCanopyStore.setState({ hostId: ALL_HOSTS_ID });
    expect(captureCanopyPopOut().hostId).toBe(ALL_HOSTS_ID);
  });

  it("forgets an inbox once it unmounts, and an old unmount leaves a newer one", () => {
    const stopOld = registerCanopyInboxPlace(() => inboxPlace({ query: "old" }));
    const stopNew = registerCanopyInboxPlace(() => inboxPlace({ query: "new" }));
    stopOld();
    expect(captureCanopyPopOut().query).toBe("new");
    stopNew();
    expect(captureCanopyPopOut().query).toBe("");
  });
});

describe("popping the dialog out", () => {
  it("closes the dialog only once the window has its place", async () => {
    useCanopyStore.setState({ mode: "on", isOpen: true });
    let taken!: () => void;
    popOut.mockImplementationOnce(() => new Promise<void>((resolve) => (taken = resolve)));

    const done = popOutCanopyDialog();
    await Promise.resolve();
    expect(useCanopyStore.getState().isOpen).toBe(true);

    taken();
    await done;
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("leaves the dialog exactly as it was when the window didn't take it", async () => {
    useCanopyStore.setState({
      mode: "on",
      isOpen: true,
      hostId: "studio",
      unreadOnly: true,
      workOf: { assistantId: "assistant-1", name: "Planner" },
    });
    const before = useCanopyStore.getState();
    popOut.mockRejectedValueOnce(new Error("Its window closed before Canopy moved."));

    await expect(popOutCanopyDialog()).rejects.toThrow("closed");

    const after = useCanopyStore.getState();
    expect(after.isOpen).toBe(true);
    expect(after.hostId).toBe(before.hostId);
    expect(after.unreadOnly).toBe(before.unreadOnly);
    expect(after.workOf).toBe(before.workOf);
  });

  it("joins a pop-out already under way rather than asking twice", async () => {
    useCanopyStore.setState({ mode: "on", isOpen: true });
    let taken!: () => void;
    popOut.mockImplementationOnce(() => new Promise<void>((resolve) => (taken = resolve)));

    const first = popOutCanopyDialog();
    const second = popOutCanopyDialog();
    expect(second).toBe(first);
    expect(popOut).toHaveBeenCalledTimes(1);

    taken();
    await first;
    await popOutCanopyDialog();
    expect(popOut).toHaveBeenCalledTimes(2);
  });
});
