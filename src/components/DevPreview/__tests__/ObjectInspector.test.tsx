/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type {
  CdpGetPropertiesResult,
  CdpPropertyDescriptor,
  SerializedConsoleRow,
} from "@shared/types/ipc/webviewConsole";
import { MAX_LIVE_OBJECT_ROWS } from "@shared/config/devPreviewConsole";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ObjectInspector, ObjectViewCacheContext, type ObjectViewCache } from "../ObjectInspector";
import { useConsoleCaptureStore, flushConsoleCaptureBuffer } from "@/store/consoleCaptureStore";

const getConsoleProperties =
  vi.fn<
    (
      webContentsId: number,
      paneId: string,
      rowId: number,
      objectId: string
    ) => Promise<CdpGetPropertiesResult>
  >();

function prop(
  name: string,
  rest: Omit<CdpPropertyDescriptor, "name" | "configurable" | "enumerable">
): CdpPropertyDescriptor {
  return { name, configurable: true, enumerable: true, ...rest };
}

async function expandWith(properties: CdpPropertyDescriptor[]): Promise<HTMLElement> {
  getConsoleProperties.mockResolvedValue({ properties });
  const { container } = render(
    // No hover delay, so a tooltip opened by a pointer is up by the next check.
    <TooltipProvider delayDuration={0}>
      <ObjectInspector
        arg={{ type: "object", objectId: "obj-1", preview: "{…}" }}
        webContentsId={7}
        paneId="pane-1"
        rowId={3}
        path="0"
      />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: /\{…\}/ }));
  await waitFor(() => expect(container.querySelector("[id]")).not.toBeNull());
  return container;
}

function propertyRow(container: HTMLElement, name: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("span")).find(
    (el) => el.textContent === `${name}:`
  );
  if (!label?.parentElement) throw new Error(`no row for ${name}`);
  return label.parentElement;
}

/** The marker a sighted reader sees in place of a value; assistive tech skips it. */
function marker(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('[aria-hidden="true"]');
}

function explanation(row: HTMLElement): string | undefined {
  return row.querySelector(".sr-only")?.textContent ?? undefined;
}

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { webview: { getConsoleProperties } },
  });
});

afterEach(() => {
  getConsoleProperties.mockReset();
  Reflect.deleteProperty(window, "electron");
});

describe("ObjectInspector property values", () => {
  it("shows an unrun getter as an accessor, not as undefined", async () => {
    const container = await expandWith([
      prop("total", { accessor: { getter: true, setter: false } }),
      prop("missing", { value: { type: "primitive", kind: "undefined", value: null } }),
    ]);

    expect(getConsoleProperties).toHaveBeenCalledWith(7, "pane-1", 3, "obj-1");

    const total = propertyRow(container, "total");
    expect(marker(total)?.textContent).toBe("(…)");
    expect(total.textContent).not.toContain("undefined");

    const missing = propertyRow(container, "missing");
    expect(marker(missing)).toBeNull();
    expect(missing.textContent).toBe("missing:undefined");
  });

  it("gives every kind of unread value its own marker and explanation", async () => {
    const container = await expandWith([
      prop("getOnly", { accessor: { getter: true, setter: false } }),
      prop("getSet", { accessor: { getter: true, setter: true } }),
      prop("setOnly", { accessor: { getter: false, setter: true } }),
      prop("neither", { accessor: { getter: false, setter: false } }),
      prop("bare", {}),
    ]);
    const read = (name: string) => {
      const row = propertyRow(container, name);
      return { label: marker(row)?.textContent, explanation: explanation(row) };
    };
    const getOnly = read("getOnly");
    const setOnly = read("setOnly");
    const bare = read("bare");

    // A getter reads the same whether or not a setter sits beside it, and so
    // does an accessor without a getter whatever its setter.
    expect(read("getSet")).toEqual(getOnly);
    expect(read("neither")).toEqual(setOnly);

    const kinds = [getOnly, setOnly, bare];
    for (const kind of kinds) {
      expect(kind.label).toBeTruthy();
      expect(kind.label).not.toBe("undefined");
      expect(kind.explanation).toBeTruthy();
    }
    expect(new Set(kinds.map((k) => k.label)).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => k.explanation)).size).toBe(kinds.length);
  });

  it("explains the marker in a tooltip on hover, matching what assistive tech reads", async () => {
    const container = await expandWith([
      prop("total", { accessor: { getter: true, setter: false } }),
    ]);
    const total = propertyRow(container, "total");
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerMove(marker(total)!, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe(explanation(total));
  });

  it("adds no control for the marker and reads nothing more from the page", async () => {
    const container = await expandWith([
      prop("total", { accessor: { getter: true, setter: false } }),
    ]);
    const total = propertyRow(container, "total");
    expect(total.querySelector("button, a, [tabindex]")).toBeNull();

    fireEvent.click(marker(total)!);
    await act(async () => {});
    expect(getConsoleProperties).toHaveBeenCalledTimes(1);
  });
});

describe("ObjectInspector released values (#17067)", () => {
  /** A console row as the panel renders it: focusable, reading its value from the store. */
  function StoreRow() {
    const arg = useConsoleCaptureStore((state) => state.messages.get("pane-1")?.[0]?.args[0]);
    if (!arg) return null;
    return (
      <div tabIndex={0} data-console-row={3}>
        <ObjectInspector arg={arg} webContentsId={7} paneId="pane-1" rowId={3} path="0" />
      </div>
    );
  }

  function renderRow() {
    return render(
      <TooltipProvider delayDuration={0}>
        <StoreRow />
      </TooltipProvider>
    );
  }

  function row(id: number, objectId = `obj-${id}`): SerializedConsoleRow {
    return {
      id,
      paneId: "pane-1",
      level: "log",
      cdpType: "log",
      args: [{ type: "object", objectId, preview: "{a: 1}" }],
      summaryText: "{a: 1}",
      groupDepth: 0,
      timestamp: 0,
      navigationGeneration: 0,
    };
  }

  function addRow(next: SerializedConsoleRow) {
    useConsoleCaptureStore.getState().addStructuredMessage(next);
    flushConsoleCaptureBuffer();
  }

  beforeEach(() => {
    useConsoleCaptureStore.getState().removePane("pane-1");
    addRow(row(3, "obj-1"));
  });

  afterEach(() => {
    useConsoleCaptureStore.getState().removePane("pane-1");
  });

  it("stops offering the value, and keeps focus on its row, when main says it is gone", async () => {
    getConsoleProperties.mockResolvedValue({ properties: [], released: true });
    const { container } = renderRow();
    const disclosure = screen.getByRole("button", { name: /\{a: 1\}/ });
    disclosure.focus();

    fireEvent.click(disclosure);

    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    const [kept] = useConsoleCaptureStore.getState().getMessages("pane-1");
    expect(kept!.args[0]).toMatchObject({ type: "object", objectId: "" });
    expect(document.activeElement).toBe(container.querySelector("[data-console-row]"));
  });

  it("keeps an expanded value inspectable after it ages out of the live window", async () => {
    getConsoleProperties.mockResolvedValue({ properties: [] });
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: /\{a: 1\}/ }));
    await waitFor(() => expect(getConsoleProperties).toHaveBeenCalledTimes(1));

    await act(async () => {
      for (let id = 4; id < 4 + MAX_LIVE_OBJECT_ROWS + 1; id++) addRow(row(id));
    });

    expect(screen.getByRole("button", { name: /\{a: 1\}/ })).not.toBeNull();
  });

  it("hands focus to the row when a focused value ages out", async () => {
    const { container } = renderRow();
    screen.getByRole("button", { name: /\{a: 1\}/ }).focus();

    await act(async () => {
      for (let id = 4; id < 4 + MAX_LIVE_OBJECT_ROWS + 1; id++) addRow(row(id));
    });

    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("[data-console-row]"));
  });

  it("hands focus to the row when a focused nested value goes with its parent", async () => {
    getConsoleProperties.mockResolvedValue({
      properties: [
        prop("child", { value: { type: "object", objectId: "child-obj", preview: "{b: 2}" } }),
      ],
    });
    const { container } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: /\{a: 1\}/ }));
    const child = await screen.findByRole("button", { name: /\{b: 2\}/ });
    child.focus();

    act(() => useConsoleCaptureStore.getState().releaseRowHandles("pane-1", 3));

    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("[data-console-row]"));
  });

  it("shows a released value as its preview, with no control, and says why", async () => {
    useConsoleCaptureStore.getState().releaseRowHandles("pane-1", 3);
    renderRow();

    expect(screen.queryByRole("button")).toBeNull();
    const preview = screen.getByText("{a: 1}");
    const reason = preview.querySelector(".sr-only")?.textContent ?? "";
    expect(reason).not.toBe("");

    fireEvent.pointerMove(preview, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBeTruthy();
    expect(getConsoleProperties).not.toHaveBeenCalled();
  });
});

describe("ObjectInspector view cache keys (#17497)", () => {
  const obj = (objectId: string) => ({
    type: "object" as const,
    objectId,
    preview: `{${objectId}}`,
  });

  it("keeps a dotted property name apart from the same names nested", async () => {
    const reads: Record<string, CdpPropertyDescriptor[]> = {
      root: [prop("a.b", { value: obj("dotted") }), prop("a", { value: obj("outer") })],
      dotted: [prop("x", { value: { type: "primitive", kind: "number", value: 1 } })],
      outer: [prop("b", { value: obj("inner") })],
      inner: [prop("y", { value: { type: "primitive", kind: "number", value: 2 } })],
    };
    getConsoleProperties.mockImplementation(async (_w, _p, _r, objectId) => ({
      properties: reads[objectId] ?? [],
    }));
    const cache: ObjectViewCache = new Map();
    const ui = (
      <TooltipProvider delayDuration={0}>
        <ObjectViewCacheContext value={cache}>
          <ObjectInspector arg={obj("root")} webContentsId={7} paneId="pane-1" rowId={3} path="0" />
        </ObjectViewCacheContext>
      </TooltipProvider>
    );
    const { container, unmount } = render(ui);
    const open = async (el: Element) => {
      fireEvent.click(el);
      await act(async () => {});
    };
    await open(screen.getByRole("button", { name: /\{root\}/ }));
    await open(propertyRow(container, "a.b").querySelector("button")!);
    await open(propertyRow(container, "a").querySelector("button")!);
    await open(propertyRow(container, "b").querySelector("button")!);

    const keys = Array.from(cache.keys());
    expect(new Set(keys).size).toBe(4);
    expect(cache.get('3:0."a.b"')?.properties?.[0]?.name).toBe("x");
    expect(cache.get('3:0."a"."b"')?.properties?.[0]?.name).toBe("y");

    // A remount (virtualized row scrolled back in) reads each branch from the cache.
    unmount();
    getConsoleProperties.mockClear();
    const again = render(ui);
    expect(again.container.textContent).toContain("x:");
    expect(again.container.textContent).toContain("y:");
    expect(getConsoleProperties).not.toHaveBeenCalled();
  });
});
