// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientAppError } from "@/utils/clientAppError";

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: readMock } }));

import { useFileLoad, type FileLoadIntent } from "../useFileLoad";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const read = (content: string) => ({ content, pathIsCanonical: true });

// The pane loads explicitly on every new identity; the harness does the same.
function renderLoad(initial: { filePath: string | undefined; root: string }) {
  return renderHook(
    ({ filePath, root }) => {
      const load = useFileLoad(filePath, root);
      return load;
    },
    { initialProps: initial }
  );
}

async function load(
  result: { current: { loadFile: (i: FileLoadIntent) => void } },
  intent: FileLoadIntent
) {
  await act(async () => {
    result.current.loadFile(intent);
  });
}

describe("useFileLoad identity", () => {
  beforeEach(() => {
    readMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a read that lands after a root-only identity change", async () => {
    const stale = deferred<ReturnType<typeof read>>();
    readMock.mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderLoad({ filePath: "/a/file.ts", root: "/a" });
    await load(result, "explicit");
    expect(result.current.loadState).toBe("loading");

    readMock.mockResolvedValueOnce(read("new root"));
    rerender({ filePath: "/a/file.ts", root: "/" });
    await load(result, "explicit");
    expect(result.current.content).toBe("new root");

    await act(async () => {
      stale.resolve(read("old root"));
    });
    expect(result.current.content).toBe("new root");
    expect(readMock).toHaveBeenLastCalledWith(expect.objectContaining({ rootPath: "/" }));
  });

  it("forgets the old file's good view, so a silent failure on the new one surfaces", async () => {
    readMock.mockResolvedValueOnce(read("first"));
    const { result, rerender } = renderLoad({ filePath: "/a/one.ts", root: "/a" });
    await load(result, "explicit");
    expect(result.current.loadState).toBe("loaded");

    rerender({ filePath: "/a/two.ts", root: "/a" });
    readMock.mockRejectedValueOnce(new Error("EBUSY"));
    await load(result, "ambient");
    expect(result.current.loadState).toBe("error");
    expect(result.current.errorCode).toBe("INVALID_PATH");
  });
});

describe("useFileLoad silent failures", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it.each(["ambient", "revealed"] as const)(
    "%s keeps the last good content through a transient failure",
    async (intent) => {
      readMock.mockResolvedValueOnce(read("good"));
      const { result } = renderLoad({ filePath: "/a/file.ts", root: "/a" });
      await load(result, "explicit");

      readMock.mockRejectedValueOnce(new Error("EBUSY"));
      await load(result, intent);
      expect(result.current.loadState).toBe("loaded");
      expect(result.current.content).toBe("good");
      expect(result.current.errorCode).toBeNull();
    }
  );

  it.each(["NOT_FOUND", "PERMISSION", "OUTSIDE_ROOT"] as const)(
    "surfaces a permanent %s failure even on a silent pass",
    async (code) => {
      readMock.mockResolvedValueOnce(read("good"));
      const { result } = renderLoad({ filePath: "/a/file.ts", root: "/a" });
      await load(result, "explicit");

      readMock.mockRejectedValueOnce(new ClientAppError(code, "gone"));
      await load(result, "ambient");
      expect(result.current.loadState).toBe("error");
      expect(result.current.errorCode).toBe(code);
    }
  );

  it("settles an explicit skeleton a silent transient failure superseded", async () => {
    readMock.mockResolvedValueOnce(read("good"));
    const { result } = renderLoad({ filePath: "/a/file.ts", root: "/a" });
    await load(result, "explicit");

    const pending = deferred<ReturnType<typeof read>>();
    readMock.mockReturnValueOnce(pending.promise);
    await load(result, "explicit");
    expect(result.current.loadState).toBe("loading");

    readMock.mockRejectedValueOnce(new Error("EBUSY"));
    await load(result, "ambient");
    expect(result.current.loadState).toBe("loaded");
  });
});
