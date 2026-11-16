/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type {
  CdpGetPropertiesResult,
  CdpPropertyDescriptor,
} from "@shared/types/ipc/webviewConsole";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ObjectInspector } from "../ObjectInspector";
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
  function renderValue(objectId: string) {
    return render(
      <TooltipProvider delayDuration={0}>
        <ObjectInspector
          arg={{ type: "object", objectId, preview: "{a: 1}" }}
          webContentsId={7}
          paneId="pane-1"
          rowId={3}
          path="0"
        />
      </TooltipProvider>
    );
  }

  beforeEach(() => {
    useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 3,
      paneId: "pane-1",
      level: "log",
      cdpType: "log",
      args: [{ type: "object", objectId: "obj-1", preview: "{a: 1}" }],
      summaryText: "{a: 1}",
      groupDepth: 0,
      timestamp: 0,
      navigationGeneration: 0,
    });
    flushConsoleCaptureBuffer();
  });

  afterEach(() => {
    useConsoleCaptureStore.getState().removePane("pane-1");
  });

  it("stops offering the value when main says the row's handles are gone", async () => {
    getConsoleProperties.mockResolvedValue({ properties: [], released: true });
    renderValue("obj-1");

    const disclosure = screen.getByRole("button", { name: /\{a: 1\}/ });
    fireEvent.click(disclosure);
    await waitFor(() => {
      const [row] = useConsoleCaptureStore.getState().getMessages("pane-1");
      expect(row!.args[0]).toMatchObject({ type: "object", objectId: "" });
    });
    // Not opened onto an empty tree.
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a released value as its preview, with no control, and says why", async () => {
    renderValue("");

    expect(screen.queryByRole("button")).toBeNull();
    const preview = screen.getByText("{a: 1}");
    const reason = preview.querySelector(".sr-only")?.textContent ?? "";
    expect(reason).not.toBe("");

    fireEvent.pointerMove(preview, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBeTruthy();
    expect(getConsoleProperties).not.toHaveBeenCalled();
  });
});
