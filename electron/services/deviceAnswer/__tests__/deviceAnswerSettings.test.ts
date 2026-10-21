import { describe, expect, it } from "vitest";
import { sanitizeDeviceAnswerSettings } from "../deviceAnswerSettings.js";

describe("sanitizeDeviceAnswerSettings", () => {
  it("redacts a secret an answer recorded before labels were redacted", () => {
    const settings = sanitizeDeviceAnswerSettings({
      answers: [
        {
          at: 1,
          deviceId: "dev-1",
          deviceName: "Phone",
          runId: "run-1",
          label: "Use token=abcdef123456",
          outcome: "refused",
          reason: 'No option "Use token=abcdef123456" is on the screen.',
        },
        {
          at: 2,
          deviceId: "dev-1",
          deviceName: "Phone",
          runId: "run-1",
          label: "Yes",
          outcome: "answered",
        },
      ],
    });
    expect(settings.answers[0]).toMatchObject({ label: "Use token=[redacted]" });
    expect(settings.answers[1]).toEqual({
      at: 2,
      deviceId: "dev-1",
      deviceName: "Phone",
      runId: "run-1",
      label: "Yes",
      outcome: "answered",
    });
    expect(JSON.stringify(settings)).not.toContain("abcdef123456");
  });
});
