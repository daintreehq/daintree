import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn<(path: string) => Promise<string>>(),
  open: vi.fn<(path: string, flags: number) => Promise<unknown>>(),
  stat: vi.fn<(path: string) => Promise<{ isFile: () => boolean }>>(),
}));

vi.mock("node:fs/promises", () => ({
  realpath: (path: string) => fsMock.realpath(path),
  open: (path: string, flags: number) => fsMock.open(path, flags),
  stat: (path: string) => fsMock.stat(path),
}));

// A gate with a short deadline, so a stalled call is given up on quickly.
vi.mock("../projectIoGate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projectIoGate.js")>();
  return {
    ...actual,
    // Room for the calls the stall tests leave holding their slots.
    projectIo: new actual.ProjectIoGate({ limits: { defaultTimeoutMs: 50, maxInFlight: 8 } }),
  };
});

const { readDeclaredProjectLinks } = await import("../projectDeclaredLinks.js");
const { isProjectIoError } = await import("../projectIoGate.js");

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

let nextRoot = 0;
/** A root of its own per test: a stalled call marks its root stalled for good. */
function freshRoot(): string {
  return `/repos/project-${++nextRoot}`;
}

/** A file's handle that reads `text`, as an open manifest would. */
function textHandle(text: string) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return {
    stat: async () => ({ isFile: () => true, size: bytes.length }),
    read: async (buffer: Buffer, at: number, length: number) => {
      const bytesRead = bytes.copy(buffer, at, offset, Math.min(bytes.length, offset + length));
      offset += bytesRead;
      return { bytesRead };
    },
    close: vi.fn(() => Promise.resolve()),
  };
}

// Only package.json stands at the root unless a test says otherwise.
const OTHER_MANIFEST = /[\\/](pyproject\.toml|Cargo\.toml|catalog-info\.yaml)$/;

beforeEach(() => {
  fsMock.realpath.mockReset();
  fsMock.realpath.mockImplementation(async (path) => {
    if (OTHER_MANIFEST.test(path)) throw errno("ENOENT");
    return path;
  });
  fsMock.open.mockReset();
  fsMock.stat.mockReset();
  fsMock.stat.mockResolvedValue({ isFile: () => true });
});

describe("readDeclaredProjectLinks when the disk misbehaves (#17252)", () => {
  it("gives up on a stalled read at the deadline, without waiting for the handle to close", async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    fsMock.open.mockResolvedValue({ stat: () => new Promise(() => {}), close });

    const outcome = await readDeclaredProjectLinks(freshRoot()).then(
      () => "resolved",
      (error: unknown) => (isProjectIoError(error) ? error.code : "other")
    );

    expect(outcome).toBe("PROJECT_IO_STALLED");
    expect(close).toHaveBeenCalledOnce();
  });

  it("gives up on a stalled byte read too, without waiting for the handle to close", async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    fsMock.open.mockResolvedValue({
      stat: async () => ({ isFile: () => true, size: 64 }),
      read: () => new Promise(() => {}),
      close,
    });

    await expect(readDeclaredProjectLinks(freshRoot())).rejects.toMatchObject({
      code: "PROJECT_IO_STALLED",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("declares nothing for a socket or other non-file at the path, without opening it", async () => {
    fsMock.stat.mockResolvedValue({ isFile: () => false });
    await expect(readDeclaredProjectLinks(freshRoot())).resolves.toEqual([]);
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("reads nothing from a FIFO swapped in after the check and opens nonblocking where supported", async () => {
    const { constants } = await import("node:fs");
    const read = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    fsMock.open.mockResolvedValue({ stat: async () => ({ isFile: () => false }), read, close });

    await expect(readDeclaredProjectLinks(freshRoot())).resolves.toEqual([]);
    expect(fsMock.open).toHaveBeenCalledOnce();
    if (constants.O_NONBLOCK !== undefined) {
      expect(fsMock.open.mock.calls[0]![1] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    }
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a descriptor whose open landed after the gate gave up on it", async () => {
    const close = vi.fn(() => Promise.resolve());
    let land: (handle: unknown) => void = () => {};
    fsMock.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        })
    );

    await expect(readDeclaredProjectLinks(freshRoot())).rejects.toSatisfy(isProjectIoError);
    expect(close).not.toHaveBeenCalled();
    land({ stat: vi.fn(), close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it.each(["EIO", "ESTALE", "EMFILE", "EBUSY"])(
    "rejects on %s, which may clear, so the caller keeps its list",
    async (code) => {
      fsMock.open.mockRejectedValue(errno(code));
      await expect(readDeclaredProjectLinks(freshRoot())).rejects.toMatchObject({ code });
    }
  );

  it.each(["ENOENT", "ENOTDIR", "EACCES"])(
    "declares nothing on %s, which settles that there is nothing to read",
    async (code) => {
      const root = freshRoot();
      fsMock.realpath.mockImplementation(async (path) => {
        if (path !== root) throw errno(code);
        return path;
      });
      await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
      expect(fsMock.realpath).toHaveBeenCalledTimes(5);
      expect(fsMock.open).not.toHaveBeenCalled();
    }
  );

  it("rejects when the project folder itself fails in a way that may pass", async () => {
    const root = freshRoot();
    fsMock.realpath.mockImplementation(async (path) => {
      if (path === root) throw errno("EIO");
      return path;
    });
    await expect(readDeclaredProjectLinks(root)).rejects.toMatchObject({ code: "EIO" });
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("rejects when a parser can't load, rather than reading its file as malformed (#17254)", async () => {
    const missing = new Error("parser chunk missing");
    vi.doMock("smol-toml", () => {
      throw missing;
    });
    try {
      fsMock.realpath.mockImplementation(async (path) => {
        if (/[\\/](Cargo\.toml|catalog-info\.yaml)$/.test(path)) throw errno("ENOENT");
        return path;
      });
      fsMock.open.mockImplementation(async (path) =>
        path.endsWith("package.json")
          ? textHandle(JSON.stringify({ homepage: "https://widget.example.dev" }))
          : textHandle('[project.urls]\nDocs = "https://docs.example.dev"\n')
      );
      const error: unknown = await readDeclaredProjectLinks(freshRoot()).then(
        () => null,
        (rejection: unknown) => rejection
      );
      // The loader may wrap the factory's error; either way it is the one that surfaces.
      const cause = error instanceof Error ? error.cause : undefined;
      expect(error === missing || cause === missing).toBe(true);
      expect(fsMock.open).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("smol-toml");
    }
  });

  it("rejects when a later manifest fails in a way that may pass, rather than dropping its links (#17254)", async () => {
    const packageJson = textHandle(JSON.stringify({ homepage: "https://widget.example.dev" }));
    fsMock.realpath.mockImplementation(async (path) => {
      if (/[\\/](Cargo\.toml|catalog-info\.yaml)$/.test(path)) throw errno("ENOENT");
      return path;
    });
    fsMock.open.mockImplementation(async (path) => {
      if (path.endsWith("package.json")) return packageJson;
      throw errno("EIO");
    });

    await expect(readDeclaredProjectLinks(freshRoot())).rejects.toMatchObject({ code: "EIO" });
    expect(fsMock.open.mock.calls.map(([path]) => path.split(/[\\/]/).pop())).toEqual([
      "package.json",
      "pyproject.toml",
    ]);
    expect(packageJson.close).toHaveBeenCalledOnce();
  });
});
