import { describe, expect, it, vi } from "vitest";
import { claimPageDictationKey, registerPageDictationKey } from "../pageDictationKey.js";

const press = { type: "keyDown", key: "." } as Electron.Input;

describe("pageDictationKey", () => {
  it("leaves every key to the page until a claim is registered", () => {
    expect(claimPageDictationKey(press)).toBe(false);
  });

  it("asks the registered claim, and stops once it is unregistered", () => {
    const claim = vi.fn(() => true);
    const unregister = registerPageDictationKey(claim);

    expect(claimPageDictationKey(press)).toBe(true);
    expect(claim).toHaveBeenCalledWith(press);

    unregister();
    expect(claimPageDictationKey(press)).toBe(false);
  });

  it("keeps a newer claim when an older one unregisters late", () => {
    const unregisterOld = registerPageDictationKey(() => false);
    const unregisterNew = registerPageDictationKey(() => true);

    unregisterOld();
    expect(claimPageDictationKey(press)).toBe(true);
    unregisterNew();
  });
});
