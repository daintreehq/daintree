// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpAssistantSettings } from "@shared/types";
import {
  SettingsFlushContext,
  SettingsFlushProvider,
  type FailedSettingsFlush,
} from "../../SettingsFlushRegistry";
import { SettingsValidationProvider } from "../../SettingsValidationRegistry";
import { ASSISTANT_LAUNCH_SECTION_ID } from "../assistantSettingsModel";
import { useAssistantSettingsPersistence } from "../useAssistantSettingsPersistence";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const REFUSAL = "Custom CLI args can't contain these characters: ; | & > < $( ${ ` \\";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const STORED: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  runbookSearch: true,
  tier: "core",
  bypassPermissions: false,
  auditRetention: 7,
  modelIds: {},
  customArgs: "--verbose",
  idleHibernateMinutes: 5,
  loadGlobalHooksAndServers: false,
  daintreeConfirmations: "inherit",
  acceptRemoteControl: true,
};

let setSettings: ReturnType<typeof vi.fn>;

function install() {
  setSettings = vi.fn().mockResolvedValue(undefined);
  window.electron = {
    helpAssistant: {
      getSettings: vi.fn().mockResolvedValue(STORED),
      setSettings,
    },
    mcpServer: {
      getStatus: vi.fn().mockResolvedValue({ enabled: true, port: 1, apiKey: "k" }),
      onRuntimeStateChanged: vi.fn(() => () => {}),
    },
  } as unknown as typeof window.electron;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SettingsValidationProvider>
      <SettingsFlushProvider>{children}</SettingsFlushProvider>
    </SettingsValidationProvider>
  );
}

async function renderPersistence() {
  const hook = renderHook(
    () => ({ state: useAssistantSettingsPersistence(), flush: useContext(SettingsFlushContext)! }),
    { wrapper }
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.state.loading).toBe(false);
  return hook;
}

type Hook = Awaited<ReturnType<typeof renderPersistence>>;

function type(hook: Hook, value: string) {
  act(() => hook.result.current.state.editCustomArgs(value));
}

async function settleDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

async function close(hook: Hook): Promise<FailedSettingsFlush[]> {
  let failed: FailedSettingsFlush[] = [];
  await act(async () => {
    failed = await hook.result.current.flush.flushAll();
  });
  return failed;
}

const HELD = [{ tab: "assistant", landOn: ASSISTANT_LAUNCH_SECTION_ID }];

describe("useAssistantSettingsPersistence custom args (#15576)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    install();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a refused value in the field with main's reason and holds the close", async () => {
    const hook = await renderPersistence();
    setSettings.mockRejectedValue(new Error(REFUSAL));

    type(hook, "--add-dir C:\\work\\shared");
    await settleDebounce();

    expect(setSettings).toHaveBeenCalledExactlyOnceWith({
      customArgs: "--add-dir C:\\work\\shared",
    });
    const { state } = hook.result.current;
    expect(state.displayedCustomArgs).toBe("--add-dir C:\\work\\shared");
    expect(state.settings.customArgs).toBe("--verbose");
    expect(state.customArgsError).toBe(REFUSAL);

    expect(await close(hook)).toEqual(HELD);
    // The value already failed once: the close reports it without sending it again.
    expect(setSettings).toHaveBeenCalledTimes(1);
  });

  it("attempts a failed value once, with no retry loop", async () => {
    const hook = await renderPersistence();
    setSettings.mockRejectedValue(new Error(REFUSAL));

    type(hook, "--flag;evil");
    await settleDebounce();
    await settleDebounce();
    await settleDebounce();

    expect(setSettings).toHaveBeenCalledTimes(1);
  });

  it("holds a close made before the debounce when the save is refused", async () => {
    const hook = await renderPersistence();
    setSettings.mockRejectedValue(new Error(REFUSAL));

    type(hook, "--add-dir C:\\work");
    const failed = await close(hook);

    expect(failed).toEqual(HELD);
    expect(setSettings).toHaveBeenCalledExactlyOnceWith({ customArgs: "--add-dir C:\\work" });
    expect(hook.result.current.state.displayedCustomArgs).toBe("--add-dir C:\\work");
    expect(hook.result.current.state.customArgsError).toBe(REFUSAL);

    // The debounce settling afterwards doesn't resend the value the close already tried.
    await settleDebounce();
    expect(setSettings).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight save and reports its failure", async () => {
    const hook = await renderPersistence();
    const save = deferred();
    setSettings.mockReturnValue(save.promise);

    type(hook, "--model sonnet");
    await settleDebounce();
    expect(setSettings).toHaveBeenCalledTimes(1);

    let failed: FailedSettingsFlush[] | null = null;
    let closing!: Promise<void>;
    act(() => {
      closing = hook.result.current.flush.flushAll().then((result) => {
        failed = result;
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failed).toBeNull();

    await act(async () => {
      save.reject(new Error("disk full"));
      await closing;
    });

    expect(failed).toEqual(HELD);
    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.displayedCustomArgs).toBe("--model sonnet");
    expect(hook.result.current.state.settings.customArgs).toBe("--verbose");
  });

  it("waits for an in-flight save and closes once it succeeds", async () => {
    const hook = await renderPersistence();
    const save = deferred();
    setSettings.mockReturnValue(save.promise);

    type(hook, "--model sonnet");
    await settleDebounce();

    let failed: FailedSettingsFlush[] | null = null;
    let closing!: Promise<void>;
    act(() => {
      closing = hook.result.current.flush.flushAll().then((result) => {
        failed = result;
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failed).toBeNull();

    await act(async () => {
      save.resolve();
      await closing;
    });

    expect(failed).toEqual([]);
    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.settings.customArgs).toBe("--model sonnet");
    expect(hook.result.current.state.displayedCustomArgs).toBe("--model sonnet");
  });

  it("keeps text typed during a save when the older save succeeds", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise);

    type(hook, "--model sonnet");
    await settleDebounce();
    type(hook, "--model sonnet --debug");

    await act(async () => {
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.state.displayedCustomArgs).toBe("--model sonnet --debug");

    await settleDebounce();
    expect(setSettings).toHaveBeenLastCalledWith({ customArgs: "--model sonnet --debug" });
    expect(hook.result.current.state.displayedCustomArgs).toBe("--model sonnet --debug");
    expect(hook.result.current.state.settings.customArgs).toBe("--model sonnet --debug");
  });

  it("keeps text typed during a save when the older save fails", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise);

    type(hook, "--add-dir C:\\work");
    await settleDebounce();
    type(hook, "--add-dir /work");

    await act(async () => {
      first.reject(new Error(REFUSAL));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.state.displayedCustomArgs).toBe("--add-dir /work");

    await settleDebounce();
    expect(setSettings).toHaveBeenLastCalledWith({ customArgs: "--add-dir /work" });
    expect(hook.result.current.state.settings.customArgs).toBe("--add-dir /work");
    expect(hook.result.current.state.customArgsError).toBeNull();
    expect(await close(hook)).toEqual([]);
  });

  it("saves an accepted value and closes without holding", async () => {
    const hook = await renderPersistence();

    type(hook, "--model opus");
    await settleDebounce();

    expect(setSettings).toHaveBeenCalledExactlyOnceWith({ customArgs: "--model opus" });
    expect(hook.result.current.state.settings.customArgs).toBe("--model opus");
    expect(hook.result.current.state.customArgsError).toBeNull();
    expect(await close(hook)).toEqual([]);
    expect(setSettings).toHaveBeenCalledTimes(1);
  });

  it("sends a newer draft only after the running save settles", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise);

    type(hook, "--model sonnet");
    await settleDebounce();
    type(hook, "--model opus");
    await settleDebounce();
    expect(setSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setSettings).toHaveBeenCalledTimes(2);
    expect(setSettings).toHaveBeenLastCalledWith({ customArgs: "--model opus" });
    expect(hook.result.current.state.settings.customArgs).toBe("--model opus");
  });

  it("drains a running save and then sends the newer draft on close", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error(REFUSAL));

    type(hook, "--model sonnet");
    await settleDebounce();
    type(hook, "--add-dir C:\\work");

    let failed: FailedSettingsFlush[] | null = null;
    let closing!: Promise<void>;
    act(() => {
      closing = hook.result.current.flush.flushAll().then((result) => {
        failed = result;
      });
    });
    await act(async () => {
      first.resolve();
      await closing;
    });

    expect(setSettings.mock.calls).toEqual([
      [{ customArgs: "--model sonnet" }],
      [{ customArgs: "--add-dir C:\\work" }],
    ]);
    expect(failed).toEqual(HELD);
    expect(hook.result.current.state.settings.customArgs).toBe("--model sonnet");
    expect(hook.result.current.state.displayedCustomArgs).toBe("--add-dir C:\\work");
    expect(hook.result.current.state.customArgsError).toBe(REFUSAL);
  });

  it("still saves a draft typed back to the stored value while another save runs", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise);

    type(hook, "--model sonnet");
    await settleDebounce();
    type(hook, "--verbose");
    await settleDebounce();
    expect(hook.result.current.state.displayedCustomArgs).toBe("--verbose");

    await act(async () => {
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setSettings).toHaveBeenLastCalledWith({ customArgs: "--verbose" });
    expect(hook.result.current.state.settings.customArgs).toBe("--verbose");
    expect(hook.result.current.state.displayedCustomArgs).toBe("--verbose");
  });

  it("queues a reset behind a running save and keeps the reset value", async () => {
    const hook = await renderPersistence();
    const first = deferred();
    setSettings.mockReturnValueOnce(first.promise);

    type(hook, "--model sonnet");
    await settleDebounce();
    act(() => hook.result.current.state.resetCustomArgs());
    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.displayedCustomArgs).toBe("");

    await act(async () => {
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setSettings).toHaveBeenLastCalledWith({ customArgs: "" });
    expect(hook.result.current.state.settings.customArgs).toBe("");
    expect(await close(hook)).toEqual([]);
  });

  it("retries a failed value from the banner once per click and clears the hold on success", async () => {
    const hook = await renderPersistence();
    setSettings.mockRejectedValueOnce(new Error("disk full"));

    type(hook, "--model opus");
    await settleDebounce();
    expect(hook.result.current.state.customArgsError).toBe("disk full");

    await act(async () => {
      hook.result.current.state.retryCustomArgs();
      hook.result.current.state.retryCustomArgs();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setSettings).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state.customArgsError).toBeNull();
    expect(hook.result.current.state.settings.customArgs).toBe("--model opus");
    expect(await close(hook)).toEqual([]);
  });

  it("drops a failure's message once the field moves past the value it was about", async () => {
    const hook = await renderPersistence();
    setSettings.mockRejectedValueOnce(new Error(REFUSAL));

    type(hook, "--a | b");
    await settleDebounce();
    expect(hook.result.current.state.customArgsError).toBe(REFUSAL);

    type(hook, "--a");
    expect(hook.result.current.state.customArgsError).toBeNull();
  });

  it("saves a draft on close before the debounce and doesn't send it twice", async () => {
    const hook = await renderPersistence();

    type(hook, "--model opus");
    expect(await close(hook)).toEqual([]);
    await settleDebounce();

    expect(setSettings).toHaveBeenCalledExactlyOnceWith({ customArgs: "--model opus" });
    expect(hook.result.current.state.settings.customArgs).toBe("--model opus");
  });
});
