// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ActionDispatchResult } from "@shared/types/actions";

const { dispatchMock, selectHandle } = vi.hoisted(() => ({
  dispatchMock: vi.fn<(id: string, args?: unknown, opts?: unknown) => Promise<unknown>>(),
  // The last `onValueChange` the select received. The real trigger can still
  // deliver a pick while it looks disabled (a deferred Radix open), so the
  // component's own guards are driven through this rather than the DOM.
  selectHandle: { onValueChange: null as ((v: string) => void) | null },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

interface SelectStubOption {
  value: string;
  label: string;
  description?: string;
}

vi.mock("@/components/Settings/SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    description,
    value,
    onValueChange,
    options,
    disabled,
  }: {
    label: string;
    description?: string;
    value: string;
    onValueChange: (v: string) => void;
    options: SelectStubOption[];
    disabled?: boolean;
  }) => {
    selectHandle.onValueChange = onValueChange;
    return (
      <div>
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} title={o.description}>
              {o.label}
            </option>
          ))}
        </select>
        {description && <p data-testid="select-description">{description}</p>}
      </div>
    );
  },
}));

import { WindowOpeningSection } from "../WindowOpeningSection";

const SELECT_LABEL = "Open folders in a new window";

function ok(mode: unknown): ActionDispatchResult {
  return { ok: true, result: { openFoldersInNewWindow: mode } };
}

function fail(message: string): ActionDispatchResult {
  return { ok: false, error: { code: "EXECUTION_ERROR", message } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function selectIn(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${SELECT_LABEL}"]`);
  if (!el) throw new Error("no window opening select");
  return el;
}

function buttonIn(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

function updateCalls() {
  return dispatchMock.mock.calls.filter(([id]) => id === "windowOpening.updateConfig");
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  dispatchMock.mockImplementation(async (id) => {
    if (id === "windowOpening.getConfig") return ok("off");
    if (id === "windowOpening.updateConfig") return ok("on");
    throw new Error(`unexpected dispatch ${id}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  selectHandle.onValueChange = null;
});

function pick(value: string) {
  const onValueChange = selectHandle.onValueChange;
  if (!onValueChange) throw new Error("select not rendered");
  onValueChange(value);
}

function describedMode(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-testid="select-description"]')?.textContent;
}

function optionDescription(container: HTMLElement, value: string): string | undefined {
  return selectIn(container).querySelector<HTMLOptionElement>(`option[value="${value}"]`)?.title;
}

describe("WindowOpeningSection", () => {
  it("keeps its search anchor mounted and the select locked until the saved value lands", async () => {
    const load = deferred<ActionDispatchResult>();
    dispatchMock.mockImplementationOnce(() => load.promise);

    const { container } = render(<WindowOpeningSection />);

    expect(container.querySelector("#general-window-opening")).not.toBeNull();
    expect(selectIn(container).disabled).toBe(true);
    expect(selectIn(container).value).toBe("default");

    await act(async () => {
      load.resolve(ok("off"));
    });

    expect(selectIn(container).disabled).toBe(false);
    expect(selectIn(container).value).toBe("off");
    expect(dispatchMock).toHaveBeenCalledWith("windowOpening.getConfig", undefined, {
      source: "user",
    });
  });

  it("offers the three modes, default first, each with a one-line description", async () => {
    const { container } = render(<WindowOpeningSection />);
    await flush();

    const options = [...selectIn(container).querySelectorAll("option")];
    expect(options.map((o) => o.value)).toEqual(["default", "on", "off"]);
    expect(new Set(options.map((o) => o.textContent)).size).toBe(3);
    for (const option of options) {
      expect(option.textContent?.length).toBeGreaterThan(0);
      expect(option.title.length).toBeGreaterThan(0);
      expect(option.title.endsWith(".")).toBe(false);
    }
  });

  it("saves a new choice and locks the select while the write is in flight", async () => {
    const save = deferred<ActionDispatchResult>();
    const { container } = render(<WindowOpeningSection />);
    await flush();
    dispatchMock.mockImplementationOnce(() => save.promise);

    fireEvent.change(selectIn(container), { target: { value: "on" } });

    expect(updateCalls()).toEqual([
      ["windowOpening.updateConfig", { openFoldersInNewWindow: "on" }, { source: "user" }],
    ]);
    expect(selectIn(container).value).toBe("on");
    expect(selectIn(container).disabled).toBe(true);

    await act(async () => {
      save.resolve(ok("on"));
    });

    expect(selectIn(container).value).toBe("on");
    expect(selectIn(container).disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("describes the selected mode beneath the select, following the pick", async () => {
    const save = deferred<ActionDispatchResult>();
    const { container } = render(<WindowOpeningSection />);
    await flush();

    expect(describedMode(container)).toBe(optionDescription(container, "off"));

    dispatchMock.mockImplementationOnce(() => save.promise);
    fireEvent.change(selectIn(container), { target: { value: "on" } });
    expect(describedMode(container)).toBe(optionDescription(container, "on"));

    await act(async () => {
      save.resolve(ok("on"));
    });
    expect(describedMode(container)).toBe(optionDescription(container, "on"));
  });

  it("ignores a pick that arrives before the saved value has loaded", async () => {
    const load = deferred<ActionDispatchResult>();
    dispatchMock.mockImplementationOnce(() => load.promise);
    const { container } = render(<WindowOpeningSection />);

    act(() => pick("on"));
    expect(updateCalls()).toHaveLength(0);

    await act(async () => {
      load.resolve(ok("off"));
    });
    expect(selectIn(container).value).toBe("off");
    expect(selectIn(container).disabled).toBe(false);
  });

  it("ignores a second pick while a save is in flight", async () => {
    const save = deferred<ActionDispatchResult>();
    const { container } = render(<WindowOpeningSection />);
    await flush();
    dispatchMock.mockImplementationOnce(() => save.promise);

    act(() => pick("on"));
    act(() => pick("default"));

    expect(updateCalls()).toHaveLength(1);
    await act(async () => {
      save.resolve(ok("on"));
    });
    expect(selectIn(container).value).toBe("on");
  });

  it("ignores a value that isn't a mode", async () => {
    render(<WindowOpeningSection />);
    await flush();

    act(() => pick(""));
    act(() => pick("sometimes"));

    expect(updateCalls()).toHaveLength(0);
  });

  it("releases the lock and reports a save whose result isn't a recognized mode", async () => {
    const { container } = render(<WindowOpeningSection />);
    await flush();
    dispatchMock.mockImplementationOnce(async () => ok(undefined));

    fireEvent.change(selectIn(container), { target: { value: "on" } });
    await flush();

    expect(selectIn(container).value).toBe("off");
    expect(selectIn(container).disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't save window setting"
    );
  });

  it("keeps a StrictMode remount's read when the discarded first read settles last", async () => {
    const reads: Array<ReturnType<typeof deferred<ActionDispatchResult>>> = [];
    dispatchMock.mockImplementation(async (id) => {
      if (id !== "windowOpening.getConfig") throw new Error(`unexpected dispatch ${id}`);
      const read = deferred<ActionDispatchResult>();
      reads.push(read);
      return read.promise;
    });

    const { container } = render(
      <StrictMode>
        <WindowOpeningSection />
      </StrictMode>
    );
    expect(reads).toHaveLength(2);

    await act(async () => {
      reads[1]!.resolve(ok("on"));
    });
    await act(async () => {
      reads[0]!.resolve(ok("off"));
    });

    expect(selectIn(container).value).toBe("on");
  });

  it("does not write when the current value is picked again", async () => {
    const { container } = render(<WindowOpeningSection />);
    await flush();

    fireEvent.change(selectIn(container), { target: { value: "off" } });

    expect(updateCalls()).toHaveLength(0);
  });

  it("rolls back a failed save and retries exactly the value that failed", async () => {
    const { container } = render(<WindowOpeningSection />);
    await flush();
    dispatchMock.mockImplementationOnce(async () => fail("disk full"));

    fireEvent.change(selectIn(container), { target: { value: "on" } });
    await flush();

    expect(selectIn(container).value).toBe("off");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't save window setting");
    expect(alert?.textContent).toContain("disk full");

    const retry = buttonIn(container, "Retry");
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });

    expect(updateCalls()).toHaveLength(2);
    expect(updateCalls()[1]?.[1]).toEqual({ openFoldersInNewWindow: "on" });
    expect(selectIn(container).value).toBe("on");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a load failure with a retry that reloads the setting", async () => {
    dispatchMock.mockImplementationOnce(async () => fail("store unreadable"));

    const { container } = render(<WindowOpeningSection />);
    await flush();

    expect(container.querySelector("#general-window-opening")).not.toBeNull();
    // The row stays, locked, so a failed read never looks like a missing setting.
    expect(selectIn(container).disabled).toBe(true);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load window settings");
    expect(alert?.textContent).toContain("store unreadable");

    await act(async () => {
      buttonIn(container, "Retry")!.click();
    });

    expect(selectIn(container).value).toBe("off");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("treats a result without a recognised mode as a load failure", async () => {
    dispatchMock.mockImplementationOnce(async () => ok("sometimes"));

    const { container } = render(<WindowOpeningSection />);
    await flush();

    expect(selectIn(container).disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load window settings"
    );
  });
});
