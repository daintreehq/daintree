/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  CdpGetPropertiesResult,
  CdpPropertyDescriptor,
} from "@shared/types/ipc/webviewConsole";
import { ObjectInspector } from "../ObjectInspector";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
    <ObjectInspector
      arg={{ type: "object", objectId: "obj-1", preview: "{…}" }}
      webContentsId={7}
      paneId="pane-1"
      rowId={3}
      path="0"
    />
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

/** What a sighted reader sees: everything outside the sr-only text and the tooltip. */
function visibleValue(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".sr-only, [data-testid='tooltip']").forEach((el) => el.remove());
  return (clone.textContent ?? "").replace(/^[^:]+:/, "").trim();
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
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("ObjectInspector property values", () => {
  it("shows an unrun getter as an accessor, not as undefined", async () => {
    const container = await expandWith([
      prop("total", { accessor: { getter: true, setter: false } }),
      prop("missing", { value: { type: "primitive", kind: "undefined", value: null } }),
    ]);

    expect(getConsoleProperties).toHaveBeenCalledWith(7, "pane-1", 3, "obj-1");

    const total = propertyRow(container, "total");
    expect(visibleValue(total)).toBe("(…)");
    expect(total.querySelector(".sr-only")?.textContent).toBe("Getter not run");
    expect(total.querySelector("[data-testid='tooltip']")?.textContent).toBe("Getter not run");

    expect(visibleValue(propertyRow(container, "missing"))).toBe("undefined");
  });

  it("says a getter was not run even when the accessor also has a setter", async () => {
    const container = await expandWith([
      prop("both", { accessor: { getter: true, setter: true } }),
    ]);
    expect(visibleValue(propertyRow(container, "both"))).toBe("(…)");
  });

  it("marks an accessor without a getter instead of claiming a getter was skipped", async () => {
    const container = await expandWith([
      prop("sink", { accessor: { getter: false, setter: true } }),
    ]);
    const sink = propertyRow(container, "sink");
    expect(visibleValue(sink)).toBe("(no getter)");
    expect(sink.querySelector(".sr-only")?.textContent).not.toMatch(/getter not run/i);
  });

  it("never prints undefined for a property that reported no value at all", async () => {
    const container = await expandWith([prop("odd", {})]);
    expect(visibleValue(propertyRow(container, "odd"))).not.toBe("undefined");
  });

  it("adds no control for the marker and reads nothing more from the page", async () => {
    const container = await expandWith([
      prop("total", { accessor: { getter: true, setter: false } }),
    ]);
    const total = propertyRow(container, "total");
    expect(total.querySelector("button, a, [tabindex]")).toBeNull();

    fireEvent.click(total);
    expect(getConsoleProperties).toHaveBeenCalledTimes(1);
  });
});
