// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/registry/builtinRendererRegistry", () => ({ registerBuiltinView: vi.fn() }));
vi.mock("@/registry/fileEditorRegistry", () => ({ registerFileEditor: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { PLUGIN_ID, PUSH_CHANNELS } from "../../shared/ids";

const dispose = vi.fn();
const on = vi.fn(() => dispose);

beforeEach(() => {
  vi.resetModules();
  dispose.mockClear();
  on.mockClear();
  (window as unknown as { electron: unknown }).electron = {
    plugin: { on, invoke: vi.fn() },
  };
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

// Row 4 of the lazy-loading audit: the entry used to drop the subscription's
// disposer on the floor, so the recovery listener could never be released.
describe("markdown entry recovery subscription", () => {
  it("subscribes at module eval and keeps the disposer", async () => {
    const entry = await import("../index");
    expect(on).toHaveBeenCalledWith(PLUGIN_ID, PUSH_CHANNELS.recoverDraft, expect.any(Function));

    entry.disposeRecoverDraftsSubscription();
    expect(dispose).toHaveBeenCalledTimes(1);

    // Idempotent: a second teardown must not call into a released listener.
    entry.disposeRecoverDraftsSubscription();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe without a plugin host", async () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const entry = await import("../index");
    expect(on).not.toHaveBeenCalled();
    expect(() => entry.disposeRecoverDraftsSubscription()).not.toThrow();
  });
});
