// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigBundlePreview,
  ConfigBundlePreviewSection,
  ConfigImportReport,
} from "@shared/types/configBundle";

interface NotifyCall {
  message: string;
  action?: { label: string };
}

const { notifyMock, refreshMock } = vi.hoisted(() => ({
  notifyMock: vi.fn<(payload: NotifyCall) => void>(),
  refreshMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/services/configBundleRefresh", () => ({ refreshImportedConfig: refreshMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { ImportConfigDialog } from "../ImportConfigDialog";
import { IMPORT_CONFIG_EVENT } from "../importConfigEvent";

function section(
  id: ConfigBundlePreviewSection["section"],
  changes: ConfigBundlePreviewSection["changes"]
): ConfigBundlePreviewSection {
  return {
    section: id,
    add: changes.filter((c) => c.kind === "add").length,
    update: changes.filter((c) => c.kind === "update").length,
    unchanged: 0,
    changes,
  };
}

function ready(sections: ConfigBundlePreviewSection[]): ConfigBundlePreview {
  return {
    outcome: "ready",
    fileName: "bundle.json",
    bundleJson: "{}",
    sections,
    unknownSections: [],
    errors: [],
  };
}

const REPLACING = ready([
  section("keybindingOverrides", [
    { key: "terminal.new", label: "New terminal", kind: "update" },
    { key: "terminal.split", label: "Split terminal", kind: "add" },
  ]),
  section("appTheme", [
    { key: "colorSchemeId", label: "Color scheme", kind: "update", from: "Daintree", to: "Bondi" },
  ]),
]);

const ADDING_ONLY = ready([
  section("globalRecipes", [{ key: "r2", label: "Nightly triage", kind: "add" }]),
]);

let previewImport: ReturnType<typeof vi.fn>;
let applyImport: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  previewImport = vi.fn();
  applyImport = vi.fn();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      configBundle: {
        previewImport,
        applyImport,
        export: vi.fn(),
        onImported: () => () => {},
      },
    },
  });
  notifyMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  cleanup();
});

async function open(preview: ConfigBundlePreview) {
  previewImport.mockResolvedValue(preview);
  render(<ImportConfigDialog />);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(IMPORT_CONFIG_EVENT));
  });
}

const bodyText = () => document.body.textContent ?? "";

describe("ImportConfigDialog", () => {
  it("names what it replaces, not only how many", async () => {
    await open(REPLACING);

    const text = bodyText();
    for (const change of REPLACING.sections.flatMap((s) => s.changes)) {
      expect(text).toContain(change.label);
    }
    // A scalar shows both ends of the change, so the user can see what they lose.
    expect(text).toContain("Daintree → Bondi");
  });

  it("offers a backup only when the import would replace something", async () => {
    await open(REPLACING);
    expect(screen.queryByRole("button", { name: /Export a backup/ })).not.toBeNull();
    cleanup();

    await open(ADDING_ONLY);
    expect(screen.getByText(/Nightly triage/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Export a backup/ })).toBeNull();
  });

  it("stays open with the reason and a retry when the apply rolls back", async () => {
    const reason = "Couldn't import theme: disk full. Nothing was changed.";
    applyImport.mockResolvedValue({
      outcome: "rolled-back",
      sections: [],
      errors: [reason],
      rolledBack: false,
    } satisfies ConfigImportReport);
    await open(REPLACING);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import configuration" }));
    });

    expect(bodyText()).toContain(reason);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("reports a stale window, not a failed import, when only the refresh fails", async () => {
    applyImport.mockResolvedValue({
      outcome: "applied",
      sections: [],
      errors: [],
      rolledBack: false,
    } satisfies ConfigImportReport);
    refreshMock.mockRejectedValueOnce(new Error("store hydrate failed"));
    await open(REPLACING);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import configuration" }));
    });

    // The write landed, so re-applying is the wrong recovery: the dialog closes
    // and the notice offers a refresh instead.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(applyImport).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]?.[0];
    expect(call?.message).toMatch(/^Configuration imported/);
    expect(call?.action?.label).not.toBe("Try again");
  });
});
