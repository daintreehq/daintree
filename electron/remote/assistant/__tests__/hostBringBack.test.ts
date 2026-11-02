import { describe, expect, it, vi } from "vitest";
import type { HostBringBackAnswer } from "../../../../shared/types/hostWake.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HOST_BRING_BACK_DETAILS, runHostBringBack } from "../hostBringBack.js";

const ANSWER: HostBringBackAnswer = {
  status: "woken",
  wake: "sent",
  reached: true,
  startRequested: false,
  observed: null,
  elapsedMs: 9_000,
};

function deps(overrides: Partial<Parameters<typeof runHostBringBack>[0]> = {}) {
  return {
    hostIds: () => ["studio", "mini"],
    controlOn: (hostId: string) => hostId === "studio",
    bringBack: vi.fn(async () => ANSWER),
    ...overrides,
  };
}

describe("host.bringBack for this machine's assistants (#16170)", () => {
  it("runs the Shell's attempt and answers with what it observed and what to do next", async () => {
    const d = deps();
    await expect(runHostBringBack(d, { hostId: "studio" })).resolves.toEqual({
      outcome: "ok",
      detail: HOST_BRING_BACK_DETAILS.woken,
      retryAfterMs: null,
      answer: ANSWER,
    });
    expect(d.bringBack).toHaveBeenCalledWith("studio");
    // Each ending has its own next step.
    const refused = await runHostBringBack(
      deps({ bringBack: vi.fn(async () => ({ ...ANSWER, status: "not_startable" as const })) }),
      { hostId: "studio" }
    );
    expect(refused.detail).toBe(HOST_BRING_BACK_DETAILS.not_startable);
    expect(refused.detail).not.toBe(HOST_BRING_BACK_DETAILS.woken);
  });

  it("tries nothing for this machine, a host it doesn't know, or one whose control is off", async () => {
    const d = deps();
    expect(await runHostBringBack(d, { hostId: "local" })).toMatchObject({
      outcome: "unsupported",
      answer: null,
    });
    expect(await runHostBringBack(d, { hostId: "elsewhere" })).toMatchObject({
      outcome: "not_found",
      answer: null,
    });
    expect(await runHostBringBack(d, { hostId: "mini" })).toMatchObject({
      outcome: "opted_out",
      answer: null,
    });
    expect(d.bringBack).not.toHaveBeenCalled();
    expect(
      await runHostBringBack({ ...deps(), bringBack: undefined }, { hostId: "studio" })
    ).toMatchObject({ outcome: "unsupported", answer: null });
  });

  it("calls a host removed between the look and the attempt not found, and lets anything else through", async () => {
    const gone = deps({
      bringBack: vi.fn(async () => {
        throw new AppError({ code: "NOT_FOUND", message: "No host with id studio" });
      }),
    });
    expect(await runHostBringBack(gone, { hostId: "studio" })).toMatchObject({
      outcome: "not_found",
    });
    const broken = deps({
      bringBack: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(runHostBringBack(broken, { hostId: "studio" })).rejects.toThrow("boom");
  });
});
