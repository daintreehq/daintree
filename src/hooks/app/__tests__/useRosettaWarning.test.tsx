// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const notify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notify(...args),
}));

import { useRosettaWarning } from "../useRosettaWarning";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import type { BootResult } from "@shared/types/ipc/app";

function bootResult(fields: {
  runningUnderRosetta?: boolean;
  rosettaWarningDismissed?: boolean;
}): BootResult {
  return fields as unknown as BootResult;
}

describe("useRosettaWarning", () => {
  beforeEach(() => {
    notify.mockClear();
    useRosettaBannerStore.setState({ visible: false });
  });

  it("does nothing while the boot result is unavailable", () => {
    useRosettaBannerStore.setState({ visible: true });
    renderHook(() => useRosettaWarning(null));
    expect(useRosettaBannerStore.getState().visible).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows the banner when running under Rosetta and not dismissed", () => {
    renderHook(() => useRosettaWarning(bootResult({ runningUnderRosetta: true })));
    expect(useRosettaBannerStore.getState().visible).toBe(true);
  });

  it("keeps the banner hidden when the warning was dismissed", () => {
    renderHook(() =>
      useRosettaWarning(bootResult({ runningUnderRosetta: true, rosettaWarningDismissed: true }))
    );
    expect(useRosettaBannerStore.getState().visible).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the banner hidden on native builds", () => {
    useRosettaBannerStore.setState({ visible: true });
    renderHook(() => useRosettaWarning(bootResult({ runningUnderRosetta: false })));
    expect(useRosettaBannerStore.getState().visible).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the banner hidden when the field is absent (older main process)", () => {
    renderHook(() => useRosettaWarning(bootResult({})));
    expect(useRosettaBannerStore.getState().visible).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("routes a single low-priority inbox notification per session", () => {
    const result = bootResult({ runningUnderRosetta: true });
    const { rerender } = renderHook(({ boot }: { boot: BootResult }) => useRosettaWarning(boot), {
      initialProps: { boot: result },
    });
    rerender({ boot: bootResult({ runningUnderRosetta: true }) });
    rerender({ boot: bootResult({ runningUnderRosetta: true }) });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      type: "warning",
      priority: "low",
      supersedeKey: "rosetta-translation",
      countable: false,
      context: { eventKind: "host" },
    });
  });
});
