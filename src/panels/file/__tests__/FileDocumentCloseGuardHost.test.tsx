// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelsById = vi.hoisted(
  () => ({}) as Record<string, { id: string; kind: string; filePath: string; location?: string }>
);
const notifyMock = vi.hoisted(() => vi.fn());
const showFileDraftMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById }) },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/lib/notificationAddress", () => ({
  panelNotificationAddress: (panelId: string) => ({ panelId, worktreeId: "wt-1" }),
}));
vi.mock("../showFileDraft", () => ({ showFileDraft: showFileDraftMock }));

import { FileDocumentCloseGuardHost } from "../FileDocumentCloseGuardHost";
import { useFileDocumentStore, type FileDocumentProjection } from "@/store/fileDocumentStore";
import {
  __resetPanelCloseGuardsForTests,
  consultPanelCloseGuards,
  hasPanelCloseGuard,
} from "@/services/panelCloseGuard";
import { TooltipProvider } from "@/components/ui/tooltip";

function projection(overrides: Partial<FileDocumentProjection> = {}): FileDocumentProjection {
  return {
    identityKey: "doc",
    draftText: "draft",
    dirty: true,
    conflict: false,
    save: vi.fn(async () => ({ status: "saved" as const })),
    discard: vi.fn(async () => {}),
    ...overrides,
  };
}

function publish(panelId: string, next: FileDocumentProjection) {
  act(() => {
    useFileDocumentStore.getState().setFileDocument(panelId, next);
  });
}

beforeEach(() => {
  __resetPanelCloseGuardsForTests();
  useFileDocumentStore.setState({ byPanelId: {} });
  for (const id of Object.keys(panelsById)) delete panelsById[id];
  panelsById.p1 = { id: "p1", kind: "file", filePath: "/repo/docs/plan.md" };
  notifyMock.mockReset();
  showFileDraftMock.mockReset();
});

afterEach(() => {
  cleanup();
  __resetPanelCloseGuardsForTests();
});

describe("FileDocumentCloseGuardHost (#12323)", () => {
  it("guards exactly the panels whose document is dirty, whether or not a pane is mounted", () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    expect(hasPanelCloseGuard("p1")).toBe(false);
    publish("p1", projection());
    expect(hasPanelCloseGuard("p1")).toBe(true);
    publish("p1", projection({ dirty: false, draftText: null }));
    expect(hasPanelCloseGuard("p1")).toBe(false);
    act(() => {
      useFileDocumentStore.getState().setFileDocument("p1", projection());
      useFileDocumentStore.getState().clearFileDocument("p1");
    });
    expect(hasPanelCloseGuard("p1")).toBe(false);
  });

  it("asks Save / Discard / Cancel and answers the close with the user's choice", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const save = vi.fn(async () => ({ status: "saved" as const }));
    publish("p1", projection({ save }));

    let verdict = consultPanelCloseGuards(["p1"]);
    expect(await screen.findByText("Save changes to 'plan.md'?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("file-pane-close-prompt")).toBeNull());

    verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await expect(verdict).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a refused save or a failed discard answers Cancel, never proceed", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    publish(
      "p1",
      projection({
        save: vi.fn(async () => ({
          status: "refused" as const,
          reason: "The file hasn't finished loading",
        })),
        discard: vi.fn(async () => {
          throw new Error("disk full");
        }),
      })
    );
    let verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await expect(verdict).resolves.toBe(false);

    verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Discard changes" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    });
    await expect(verdict).resolves.toBe(false);
  });

  it("Discard runs the document's discard and proceeds", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const discard = vi.fn(async () => {
      // The document goes clean mid-operation; the prompt must still answer.
      useFileDocumentStore.getState().setFileDocument("p1", projection({ dirty: false, discard }));
    });
    publish("p1", projection({ discard }));
    const verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Discard changes" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    });
    await expect(verdict).resolves.toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("a prompt whose document went clean underneath it answers Cancel", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    publish("p1", projection());
    const verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-prompt");
    // A sibling panel saved the document.
    publish("p1", projection({ dirty: false, draftText: null }));
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("file-pane-close-prompt")).toBeNull());
  });
});

describe("FileDocumentCloseGuardHost: a Save that doesn't land (#15017)", () => {
  async function pressSave() {
    await screen.findByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
  }

  it.each([
    ["conflict", "The file changed on disk", "The file changed on disk. Your draft is kept."],
    [
      "unavailable",
      "The file isn't where it was",
      "The file isn't where it was. Your draft is kept.",
    ],
    ["error", "EACCES: permission denied.", "EACCES: permission denied. Your draft is kept."],
    [
      "refused",
      "The draft is too large for this editor to save",
      "The draft is too large for this editor to save. Your draft is kept.",
    ],
  ] as const)(
    "on %s, Save answers Cancel and says why, with a way back to the editor",
    async (status, reason, message) => {
      render(
        <TooltipProvider>
          <FileDocumentCloseGuardHost />
        </TooltipProvider>
      );
      publish("p1", projection({ save: vi.fn(async () => ({ status, reason })) }));
      const verdict = consultPanelCloseGuards(["p1"]);
      await pressSave();
      await expect(verdict).resolves.toBe(false);
      await waitFor(() => expect(screen.queryByTestId("file-pane-close-prompt")).toBeNull());

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const payload = notifyMock.mock.calls[0]![0];
      expect(payload).toMatchObject({
        type: "error",
        title: "Couldn't save 'plan.md'",
        message,
        priority: "high",
        urgent: true,
        replaceKey: "file-save-failed:p1",
        context: { eventKind: "uiFeedback", panelId: "p1", worktreeId: "wt-1" },
      });
      expect(payload.action.label).toBe("Review draft");
      expect(payload.actions).toBeUndefined();
      payload.action.onClick();
      expect(showFileDraftMock).toHaveBeenCalledWith("p1");
    }
  );

  it("a save that throws answers Cancel and reports the error", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    publish(
      "p1",
      projection({
        save: vi.fn(async () => {
          throw new Error("Save channel closed");
        }),
      })
    );
    const verdict = consultPanelCloseGuards(["p1"]);
    await pressSave();
    await expect(verdict).resolves.toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0].message).toBe("Save channel closed. Your draft is kept.");
  });

  it("names the file as the prompt did when the document is released before the save answers", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const save = vi.fn(async () => {
      useFileDocumentStore.getState().clearFileDocument("p1");
      return { status: "unavailable" as const, reason: "The file isn't where it was" };
    });
    publish("p1", projection({ fileName: "notes.md", save }));
    const verdict = consultPanelCloseGuards(["p1"]);
    await pressSave();
    await expect(verdict).resolves.toBe(false);
    expect(notifyMock.mock.calls[0]![0].title).toBe("Couldn't save 'notes.md'");
  });

  it("a failed Save leaves the next queued prompt standing and names only its own file", async () => {
    panelsById.p2 = { id: "p2", kind: "file", filePath: "/repo/docs/other.md" };
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    let fail: () => void = () => {};
    const firstSave = vi.fn(
      () =>
        new Promise<{ status: "conflict"; reason: string }>((resolve) => {
          fail = () => resolve({ status: "conflict", reason: "The file changed on disk" });
        })
    );
    const secondSave = vi.fn(async () => ({ status: "saved" as const }));
    publish("p1", projection({ save: firstSave }));
    publish("p2", projection({ identityKey: "doc-2", save: secondSave }));

    const first = consultPanelCloseGuards(["p1"]);
    await screen.findByText("Save changes to 'plan.md'?");
    const second = consultPanelCloseGuards(["p2"]);
    await pressSave();
    await act(async () => {
      fail();
    });
    await expect(first).resolves.toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0].title).toBe("Couldn't save 'plan.md'");

    expect(await screen.findByText("Save changes to 'other.md'?")).toBeTruthy();
    await pressSave();
    await expect(second).resolves.toBe(true);
    expect(secondSave).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("unmounting answers Cancel, and a save that lands after reports nothing", async () => {
    const { unmount } = render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    let fail: () => void = () => {};
    publish(
      "p1",
      projection({
        save: vi.fn(
          () =>
            new Promise<{ status: "error"; reason: string }>((resolve) => {
              fail = () => resolve({ status: "error", reason: "Disk full" });
            })
        ),
      })
    );
    const verdict = consultPanelCloseGuards(["p1"]);
    await pressSave();
    unmount();
    await expect(verdict).resolves.toBe(false);
    await act(async () => {
      fail();
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stays quiet when the panel was removed while the save ran", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const save = vi.fn(async () => {
      delete panelsById.p1;
      return { status: "error" as const, reason: "Disk full" };
    });
    publish("p1", projection({ save }));
    const verdict = consultPanelCloseGuards(["p1"]);
    await pressSave();
    await expect(verdict).resolves.toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
