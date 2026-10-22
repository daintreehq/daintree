// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import type { FileTransferEvent } from "@shared/types/ipc/fileTransfer";

type Payload = {
  type: string;
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
};

const notify = vi.hoisted(() => vi.fn((_payload: Payload) => "toast-1"));
vi.mock("@/lib/notify", () => ({ notify }));
const takeControl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/components/Recovery/takeControl", () => ({ takeControl }));

import { saveHostFile } from "../hostFileSave";
import { _resetTerminalInputGateForTesting, setDriveLeaseSnapshot } from "../terminal/inputGate";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useNotificationStore } from "@/store/notificationStore";
import { ClientAppError } from "@/utils/clientAppError";

const lease = (drivingHere: boolean): DriveLeaseView => ({
  projectId: "proj-1",
  holder: {
    leaseId: 3,
    endpointId: "view-9",
    clientId: "shell-b",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
  },
  drivingHere,
  isHolderEndpoint: drivingHere,
  viewerIsHostLocal: false,
});

let listeners: Array<(event: FileTransferEvent) => void>;
const download =
  vi.fn<
    (payload: {
      hostId: string;
      hostPath: string;
      opId: string;
    }) => Promise<{ localPath: string; bytes: number }>
  >();
const cancel = vi.fn(async () => {});

function notified(): Payload[] {
  return notify.mock.calls.map(([payload]) => payload);
}

beforeEach(() => {
  listeners = [];
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  (window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } }).__DAINTREE_INITIAL_PROJECT__ = {
    id: "proj-1",
  };
  useHostConnectionStore.getState().bindHost("studio-01", "studio-01");
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      fileTransfer: {
        download,
        cancel,
        onEvent: (listener: (event: FileTransferEvent) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((entry) => entry !== listener);
          };
        },
      },
    },
  });
});

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
  _resetTerminalInputGateForTesting();
  useHostConnectionStore.getState().reset();
  notify.mockClear();
  takeControl.mockClear();
  download.mockReset();
  cancel.mockClear();
});

describe("saveHostFile", () => {
  it("explains control to a watching window instead of starting a download", async () => {
    setDriveLeaseSnapshot(lease(false));
    await saveHostFile("/srv/app/talk.mov");

    expect(download).not.toHaveBeenCalled();
    const [payload] = notified();
    expect(payload?.title).toBe("Another window has control");
    expect(payload?.message).toContain("greg-mbp");
    payload?.action?.onClick();
    await vi.waitFor(() => expect(takeControl).toHaveBeenCalledWith("proj-1"));
  });

  it("saves into Downloads with progress on one toast, then says where it went", async () => {
    setDriveLeaseSnapshot(lease(true));
    const update = vi.spyOn(useNotificationStore.getState(), "updateNotification");
    const dismiss = vi.spyOn(useNotificationStore.getState(), "dismissNotification");
    let finish!: (value: { localPath: string; bytes: number }) => void;
    download.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const saving = saveHostFile("/srv/app/talk.mov");
    const request = download.mock.calls[0]![0];
    expect(request).toMatchObject({ hostId: "studio-01", hostPath: "/srv/app/talk.mov" });
    for (const listener of listeners) {
      listener({ type: "progress", opId: "someone-else", transferredBytes: 1, totalBytes: 2 });
      listener({ type: "progress", opId: request.opId, transferredBytes: 1, totalBytes: 4 });
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({ progress: { value: 0.25 } });

    finish({ localPath: "/Users/me/Downloads/talk (1).mov", bytes: 4 });
    await saving;
    expect(dismiss).toHaveBeenCalledWith("toast-1");
    expect(notified().at(-1)).toMatchObject({ type: "success", title: "File saved" });
    expect(notified().at(-1)?.message).toContain("talk (1).mov");
    expect(listeners).toEqual([]);
  });

  it("cancels through the toast and says nothing more", async () => {
    setDriveLeaseSnapshot(lease(true));
    download.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          cancel.mockImplementation(async () => {
            reject(new ClientAppError("CANCELLED", "Transfer cancelled"));
          });
        })
    );
    const saving = saveHostFile("/srv/app/talk.mov");
    const opId = download.mock.calls[0]![0].opId;
    notified()[0]?.action?.onClick();
    await saving;

    expect(cancel).toHaveBeenCalledWith({ opId });
    expect(notified()).toHaveLength(1);
  });

  it("takes control of this view's own project, whatever project a stale lease names", async () => {
    setDriveLeaseSnapshot(lease(true));
    download.mockRejectedValue(new ClientAppError("DRIVEN_ELSEWHERE", "Another window drives"));
    await saveHostFile("/srv/app/talk.mov");
    setDriveLeaseSnapshot({ ...lease(false), projectId: "proj-2" });
    notified().at(-1)?.action?.onClick();
    await vi.waitFor(() => expect(takeControl).toHaveBeenCalledWith("proj-1"));
  });

  it("explains control when the host refuses the download for it", async () => {
    setDriveLeaseSnapshot(lease(true));
    download.mockRejectedValue(new ClientAppError("DRIVEN_ELSEWHERE", "Another window drives"));
    await saveHostFile("/srv/app/talk.mov");
    expect(notified().at(-1)?.title).toBe("Another window has control");
  });

  it("reports any other failure with the host's words and a retry", async () => {
    setDriveLeaseSnapshot(lease(true));
    download.mockRejectedValueOnce(
      new ClientAppError("PAYLOAD_TOO_LARGE", "too large", "That file is too large.")
    );
    await saveHostFile("/srv/app/talk.mov");
    const failure = notified().at(-1);
    expect(failure).toMatchObject({ type: "error", message: "That file is too large." });

    download.mockResolvedValueOnce({ localPath: "/Users/me/Downloads/talk.mov", bytes: 1 });
    failure?.action?.onClick();
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  });

  it("does nothing in a window on this machine", async () => {
    delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    await saveHostFile("/repo/talk.mov");
    expect(download).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
