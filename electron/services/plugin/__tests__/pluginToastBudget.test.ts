import { beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_TOAST_BURST,
  PLUGIN_TOAST_REFILL_MS,
  admitPluginToast,
  resetPluginToastBudget,
} from "../pluginToastBudget.js";

const T0 = 1_000_000;

function admitted(pluginId: string, count: number, now: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (admitPluginToast(pluginId, now)) n++;
  return n;
}

beforeEach(() => resetPluginToastBudget());

describe("admitPluginToast", () => {
  it("admits a burst, then refuses until a token refills", () => {
    expect(admitted("acme", PLUGIN_TOAST_BURST * 2, T0)).toBe(PLUGIN_TOAST_BURST);
    expect(admitPluginToast("acme", T0 + PLUGIN_TOAST_REFILL_MS / 2)).toBe(false);
    expect(admitPluginToast("acme", T0 + PLUGIN_TOAST_REFILL_MS)).toBe(true);
    expect(admitPluginToast("acme", T0 + PLUGIN_TOAST_REFILL_MS)).toBe(false);
  });

  it("never refills past a burst, however long the plugin was idle", () => {
    admitted("acme", PLUGIN_TOAST_BURST, T0);
    expect(admitted("acme", PLUGIN_TOAST_BURST * 2, T0 + 1_000 * PLUGIN_TOAST_REFILL_MS)).toBe(
      PLUGIN_TOAST_BURST
    );
  });

  it("keeps each plugin's budget its own", () => {
    admitted("acme", PLUGIN_TOAST_BURST, T0);
    expect(admitPluginToast("acme", T0)).toBe(false);
    expect(admitted("other", PLUGIN_TOAST_BURST, T0)).toBe(PLUGIN_TOAST_BURST);
  });

  it("forgets an idle plugin only once its budget is whole again", () => {
    admitted("acme", PLUGIN_TOAST_BURST, T0);
    // Another plugin's call prunes only buckets that have refilled, so a
    // drained one is not handed back early.
    admitPluginToast("other", T0 + PLUGIN_TOAST_REFILL_MS / 2);
    expect(admitPluginToast("acme", T0 + PLUGIN_TOAST_REFILL_MS / 2)).toBe(false);
  });

  it("refills nothing when the clock steps backwards", () => {
    admitted("acme", PLUGIN_TOAST_BURST, T0);
    expect(admitPluginToast("acme", T0 - 60_000)).toBe(false);
  });
});
