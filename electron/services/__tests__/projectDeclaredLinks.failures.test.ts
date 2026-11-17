import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn<(path: string) => Promise<string>>(),
  open: vi.fn<(path: string, flags: number) => Promise<unknown>>(),
}));

vi.mock("node:fs/promises", () => ({
  realpath: (path: string) => fsMock.realpath(path),
  open: (path: string, flags: number) => fsMock.open(path, flags),
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

beforeEach(() => {
  fsMock.realpath.mockReset();
  fsMock.realpath.mockImplementation(async (path) => path);
  fsMock.open.mockReset();
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
      fsMock.realpath.mockImplementation(async (path) => {
        if (path.endsWith("package.json")) throw errno(code);
        return path;
      });
      await expect(readDeclaredProjectLinks(freshRoot())).resolves.toEqual([]);
      expect(fsMock.open).not.toHaveBeenCalled();
    }
  );
});
