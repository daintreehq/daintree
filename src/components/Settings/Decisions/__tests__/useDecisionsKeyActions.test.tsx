// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DecisionsDevice,
  DecisionsRevokeDeviceResult,
  DecisionsRotateKeysResult,
} from "@shared/types/decisions";
import { useDecisionsKeyActions } from "../useDecisionsKeyActions";

const PIXEL: DecisionsDevice = {
  deviceId: "dev_pixel",
  label: "Pixel 9",
  role: "phone",
  pairedAt: "2026-10-30T00:00:00.000Z",
  lastSeenAt: null,
  pushEnabled: true,
};

const revokeDevice = vi.fn<(deviceId: string) => Promise<DecisionsRevokeDeviceResult>>();
const rotateKeys = vi.fn<() => Promise<DecisionsRotateKeysResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useDecisionsKeyActions (#16010)", () => {
  beforeEach(() => {
    revokeDevice.mockReset();
    rotateKeys.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { revokeDevice, rotateKeys } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("sends one key change at a time, however quickly they are asked for", async () => {
    const rotation = deferred<DecisionsRotateKeysResult>();
    rotateKeys.mockReturnValue(rotation.promise);
    const { result } = renderHook(() => useDecisionsKeyActions(vi.fn()));

    let revoked: boolean | undefined;
    act(() => {
      result.current.rotate();
      result.current.rotate();
      void result.current.revoke(PIXEL).then((finished) => (revoked = finished));
    });
    await act(async () => {
      rotation.resolve({ result: "rotated", keyEpoch: 2 });
    });

    expect(rotateKeys).toHaveBeenCalledOnce();
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(revoked).toBe(false);
  });

  it("reads the list again after a revocation that may have changed the relay, and not after unmount", async () => {
    const onChanged = vi.fn();
    revokeDevice.mockResolvedValueOnce({ result: "unconfirmed", origin: "https://r.example" });
    const { result, unmount } = renderHook(() => useDecisionsKeyActions(onChanged));

    await act(async () => {
      await expect(result.current.revoke(PIXEL)).resolves.toBe(false);
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(result.current.revokeError).toContain("r.example");

    const late = deferred<DecisionsRotateKeysResult>();
    rotateKeys.mockReturnValueOnce(late.promise);
    act(() => result.current.rotate());
    unmount();
    await act(async () => {
      late.resolve({ result: "rotated", keyEpoch: 3 });
    });

    expect(onChanged).toHaveBeenCalledOnce();
  });
});
