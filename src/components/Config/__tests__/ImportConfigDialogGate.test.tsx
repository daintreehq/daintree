// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dialogLoads: 0,
  refresh: vi.fn(async () => {}),
  onImported: null as (() => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock("@/services/configBundleRefresh", () => ({ refreshImportedConfig: h.refresh }));
vi.mock("../ImportConfigDialog", () => {
  h.dialogLoads++;
  return {
    ImportConfigDialog: ({ request }: { request: number }) => (
      <div data-testid="import-dialog" data-request={request} />
    ),
  };
});

import { ImportConfigDialogGate } from "../ImportConfigDialogGate";
import { IMPORT_CONFIG_EVENT } from "../importConfigEvent";

// Read before any test mounts a gate: the mock counts module evaluations, and a
// module evaluates once per file.
const dialogLoadsWithGate = h.dialogLoads;

const requestImport = () =>
  act(async () => {
    window.dispatchEvent(new CustomEvent(IMPORT_CONFIG_EVENT));
  });

beforeEach(() => {
  h.refresh.mockClear();
  h.unsubscribe.mockClear();
  h.onImported = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      configBundle: {
        onImported: (callback: () => void) => {
          h.onImported = callback;
          return h.unsubscribe;
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ImportConfigDialogGate", () => {
  it("loads no dialog until an import is asked for, then hands it that first request", async () => {
    expect(dialogLoadsWithGate).toBe(0);
    const loadsBefore = h.dialogLoads;
    render(<ImportConfigDialogGate />);
    await act(async () => {});
    expect(h.dialogLoads).toBe(loadsBefore);
    expect(screen.queryByTestId("import-dialog")).toBeNull();

    await requestImport();

    const dialog = await screen.findByTestId("import-dialog");
    expect(dialog.dataset.request).toBe("1");
    expect(h.dialogLoads).toBe(1);
  });

  it("hands the dialog the latest of requests made together", async () => {
    render(<ImportConfigDialogGate />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(IMPORT_CONFIG_EVENT));
      window.dispatchEvent(new CustomEvent(IMPORT_CONFIG_EVENT));
    });

    expect((await screen.findByTestId("import-dialog")).dataset.request).toBe("2");
  });

  it("hands every later request to the same dialog", async () => {
    render(<ImportConfigDialogGate />);
    await requestImport();
    const dialog = await screen.findByTestId("import-dialog");

    await requestImport();

    expect(screen.getByTestId("import-dialog")).toBe(dialog);
    expect(dialog.dataset.request).toBe("2");
  });

  it("refreshes config another window imported without loading the dialog", async () => {
    render(<ImportConfigDialogGate />);

    await act(async () => h.onImported?.());

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("import-dialog")).toBeNull();
  });

  it("stops listening for both once unmounted", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<ImportConfigDialogGate />);
    const added = add.mock.calls.find(([type]) => type === IMPORT_CONFIG_EVENT);
    expect(added).toBeDefined();

    view.unmount();

    expect(remove).toHaveBeenCalledWith(IMPORT_CONFIG_EVENT, added![1]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
