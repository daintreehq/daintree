import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { ClientUploadTransport } from "../ClientUploadTransport.js";
import {
  sendLocalFolder,
  type FolderSendOptions,
  type FolderSendTransport,
} from "../folderSend.js";
import type { PackedFolderArchive } from "../localFolderPack.js";

const SESSION = { isOpen: true } as unknown as LinkSession;

function linkError(code: string, message = "link"): Error {
  return Object.assign(new Error(message), { code });
}

function fakeArchive() {
  const remove = vi.fn(async () => {});
  const archive: PackedFolderArchive = {
    path: "/packs/folder-pack-1.zip",
    archiveBytes: 400,
    sha256: "a".repeat(64),
    totals: { fileCount: 2, folderCount: 1, totalBytes: 100 },
    openSource: vi.fn(async () => ({
      size: 400,
      sha256: "a".repeat(64),
      read: async () => new Uint8Array(0),
      close: vi.fn(),
    })),
    remove,
  };
  return { archive, remove };
}

function fakeTransport(overrides: Partial<FolderSendTransport> = {}) {
  return {
    prepareFolder: vi.fn<FolderSendTransport["prepareFolder"]>(async () => ({
      result: { status: "ready", token: "b".repeat(32) },
      session: SESSION,
    })),
    sendFolderArchive: vi.fn<FolderSendTransport["sendFolderArchive"]>(async () => {}),
    folderStatus: vi.fn<FolderSendTransport["folderStatus"]>(async () => ({
      status: "done",
      hostPath: "/tmp/daintree-inbox/files/x/Audit",
    })),
    cancelFolder: vi.fn<FolderSendTransport["cancelFolder"]>(async () => ({
      status: "cancelled",
    })),
    whenReachable: vi.fn(async () => true),
    ...overrides,
  };
}

function setup(transport: FolderSendTransport) {
  const controller = new AbortController();
  const { archive, remove } = fakeArchive();
  const events: FileTransferEvent[] = [];
  const release = vi.fn();
  const options: FolderSendOptions = {
    transport,
    hostId: "studio-01",
    webContentsId: 7,
    opId: "op-1",
    rootName: "Audit",
    hostLabel: "studio-01",
    localLabel: "This Mac",
    signal: controller.signal,
    teardown: new AbortController().signal,
    viewGone: () => false,
    pack: vi.fn(async () => ({ status: "packed" as const, archive })),
    takeSlot: vi.fn(async () => release),
    requireBoundHost: () => {},
    emit: (event) => events.push(event),
    reconnectWaitMs: 1_000,
    random: () => 0,
    pollIntervalMs: 0,
  };
  return { options, controller, remove, release, events };
}

describe("following a folder send's outcome", () => {
  it("never asks the host to admit it again once its archive may have arrived", async () => {
    const transport = fakeTransport({
      sendFolderArchive: vi.fn(async () => {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "end sent, ack lost" });
      }),
      folderStatus: vi.fn(async () => ({ status: "unknown" as const })),
    });
    const { options, remove, release } = setup(transport);

    await expect(sendLocalFolder(options)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });

    expect(transport.prepareFolder).toHaveBeenCalledTimes(1);
    expect(transport.sendFolderArchive).toHaveBeenCalledTimes(1);
    expect(transport.folderStatus).toHaveBeenCalledWith("studio-01", "op-1", expect.anything());
    expect(remove).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("asks only after the status of an archive the host has once its answer is lost", async () => {
    const transport = fakeTransport({
      folderStatus: vi
        .fn<FolderSendTransport["folderStatus"]>()
        .mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "down" }))
        .mockResolvedValue({ status: "unknown" }),
    });
    const { options } = setup(transport);

    await expect(sendLocalFolder(options)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(transport.prepareFolder).toHaveBeenCalledTimes(1);
    expect(transport.whenReachable).toHaveBeenCalledTimes(1);
  });

  it("asks a busy host again under the same id until it takes the folder", async () => {
    const transport = fakeTransport({
      prepareFolder: vi
        .fn<FolderSendTransport["prepareFolder"]>()
        .mockResolvedValueOnce({ result: { status: "refused", reason: "busy" }, session: SESSION })
        .mockRejectedValueOnce(new AppError({ code: "RATE_LIMITED", message: "busy" }))
        .mockResolvedValue({
          result: { status: "ready", token: "c".repeat(32) },
          session: SESSION,
        }),
    });
    const { options } = setup(transport);

    await expect(sendLocalFolder(options)).resolves.toMatchObject({ status: "sent" });
    expect(
      vi.mocked(transport.prepareFolder).mock.calls.map(([, request]) => request.opId)
    ).toEqual(["op-1", "op-1", "op-1"]);
  });

  it("gives up on a host that stays busy", async () => {
    const transport = fakeTransport({
      prepareFolder: vi.fn(async () => ({
        result: { status: "refused" as const, reason: "busy" as const },
        session: SESSION,
      })),
    });
    const { options, remove } = setup(transport);

    await expect(sendLocalFolder(options)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(transport.sendFolderArchive).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it("answers a host's problem with the folder as a result, paths and all", async () => {
    const problem = {
      kind: "clash" as const,
      paths: ["Audit/Readme.md", "Audit/README.md"] as [string, string],
    };
    const transport = fakeTransport({
      folderStatus: vi.fn(async () => ({
        status: "failed" as const,
        reason: "name-clash" as const,
        problem,
      })),
    });
    const { options } = setup(transport);

    await expect(sendLocalFolder(options)).resolves.toEqual({ status: "refused", problem });
  });

  it("answers sent when a cancel reaches the host after publication began", async () => {
    const stop = { cancel: () => {} };
    const transport = fakeTransport({
      folderStatus: vi.fn(async () => {
        stop.cancel();
        return { status: "unpacking" as const, filesDone: 1, filesTotal: 2 };
      }),
      cancelFolder: vi.fn(async () => ({ status: "done" as const, hostPath: "/inbox/x/Audit" })),
    });
    const { options, controller, events } = setup(transport);
    stop.cancel = () => controller.abort();

    await expect(sendLocalFolder(options)).resolves.toEqual({
      status: "sent",
      hostPath: "/inbox/x/Audit",
      totals: { fileCount: 2, folderCount: 1, totalBytes: 100 },
    });
    expect(transport.cancelFolder).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ phase: "unpacking", filesDone: 2, filesTotal: 2 });
  });

  it("keeps a folder the host had already placed when a cancel lands as it answers", async () => {
    const stop = { cancel: () => {} };
    const transport = fakeTransport({
      folderStatus: vi.fn(async () => {
        stop.cancel();
        return { status: "done" as const, hostPath: "/inbox/x/Audit" };
      }),
      cancelFolder: vi.fn(async () => ({ status: "unknown" as const })),
    });
    const { options, controller } = setup(transport);
    stop.cancel = () => controller.abort();

    await expect(sendLocalFolder(options)).resolves.toMatchObject({
      status: "sent",
      hostPath: "/inbox/x/Audit",
    });
    expect(transport.cancelFolder).not.toHaveBeenCalled();
  });

  it("settles a packed archive lost to a view that went through the cancel", async () => {
    const transport = fakeTransport();
    const { options, controller } = setup(transport);
    const { archive, remove } = fakeArchive();
    archive.openSource = vi.fn(async () => {
      controller.abort();
      throw new Error("ENOENT");
    });
    options.pack = vi.fn(async () => ({ status: "packed" as const, archive }));

    await expect(sendLocalFolder(options)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancelFolder).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalled();
  });

  it("asks the host to cancel once, holding its slot until the host answers", async () => {
    const stop = { cancel: () => {} };
    let answer!: () => void;
    const transport = fakeTransport({
      folderStatus: vi.fn(async () => {
        stop.cancel();
        return { status: "unpacking" as const, filesDone: 0, filesTotal: 2 };
      }),
      cancelFolder: vi.fn(
        () =>
          new Promise<{ status: "cancelled" }>((resolve) => {
            answer = () => resolve({ status: "cancelled" });
          })
      ),
    });
    const { options, controller, release } = setup(transport);
    stop.cancel = () => controller.abort();

    const sent = sendLocalFolder(options);
    const settled = sent.catch((error: unknown) => error);
    await vi.waitFor(() => expect(transport.cancelFolder).toHaveBeenCalledTimes(1));
    expect(release).not.toHaveBeenCalled();
    answer();

    expect(await settled).toMatchObject({ code: "CANCELLED" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on an archive the host reports arriving for too long, and stops it there", async () => {
    const transport = fakeTransport({
      prepareFolder: vi.fn(async () => ({
        result: { status: "receiving" as const },
        session: SESSION,
      })),
      folderStatus: vi.fn(async () => ({ status: "receiving" as const })),
    });
    const { options } = setup(transport);

    await expect(sendLocalFolder({ ...options, receivingWaitMs: 0 })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(transport.cancelFolder).toHaveBeenCalledTimes(1);
  });

  it("rejects cancelled when the person cancels while that stop is on its way", async () => {
    const stop = { cancel: () => {} };
    const transport = fakeTransport({
      prepareFolder: vi.fn(async () => ({
        result: { status: "receiving" as const },
        session: SESSION,
      })),
      folderStatus: vi.fn(async () => ({ status: "receiving" as const })),
      cancelFolder: vi.fn(async () => {
        stop.cancel();
        return { status: "cancelled" as const };
      }),
    });
    const { options, controller } = setup(transport);
    stop.cancel = () => controller.abort();

    await expect(sendLocalFolder({ ...options, receivingWaitMs: 0 })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(transport.cancelFolder).toHaveBeenCalledTimes(1);
  });
});

describe("folder upload errors", () => {
  const SECRET = "/Users/someone/Secret Project/Audit/src/app.ts";

  function linkedTransport(session: Partial<LinkSession>) {
    const transport = new ClientUploadTransport();
    transport.noteEndpointOpened("studio-01", {
      session: { isOpen: true, ...session } as LinkSession,
      webContentsId: 7,
      endpointId: "view-7",
    });
    return transport;
  }

  const request = {
    opId: "op-1",
    rootName: "Audit",
    archiveBytes: 400,
    sha256: "a".repeat(64),
    fileCount: 2,
    folderCount: 1,
    totalBytes: 100,
  };
  const callOptions = { webContentsId: 7, hostLabel: "studio-01" };

  it.each(["VALIDATION", "UNSUPPORTED", "INTERNAL", "HOST_DISCONNECTED", "OUTCOME_UNKNOWN", ""])(
    "never repeat what the host or link said (%s)",
    async (code) => {
      const transport = linkedTransport({
        call: vi.fn(async () => {
          throw code ? linkError(code, SECRET) : new Error(SECRET);
        }),
      });
      const error = await transport
        .prepareFolder("studio-01", request, callOptions)
        .catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(`${error.message} ${error.userMessage}`).not.toContain("Secret");
      expect(error.cause).toBeUndefined();
    }
  );

  it("never repeat a reply that doesn't parse", async () => {
    const transport = linkedTransport({
      call: vi.fn(async () => ({ status: "weird", hostPath: SECRET })),
    });
    const error = await transport.folderStatus("studio-01", "op-1", callOptions).catch((e) => e);
    expect(error).toMatchObject({ code: "INTERNAL" });
    expect(`${error.message} ${error.userMessage}`).not.toContain("Secret");
  });

  it("never repeat a failed transfer", async () => {
    const session = {
      isOpen: true,
      transfers: { send: vi.fn(async () => Promise.reject(linkError("TRANSFER_FAILED", SECRET))) },
    } as unknown as LinkSession;
    const transport = new ClientUploadTransport();
    const error = await transport
      .sendFolderArchive(
        session,
        { size: 1, sha256: "a".repeat(64), read: async () => new Uint8Array(1) },
        "b".repeat(32),
        { hostLabel: "studio-01" }
      )
      .catch((e) => e);
    expect(error).toMatchObject({ code: "INTERNAL" });
    expect(`${error.message} ${error.userMessage}`).not.toContain("Secret");
  });
});
