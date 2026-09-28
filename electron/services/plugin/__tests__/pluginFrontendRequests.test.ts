import { describe, expect, it } from "vitest";
import { coercePromptAnswer, PluginPromptPayloadSchema } from "../pluginFrontendRequests.js";
import type { PluginUiPromptParams } from "../../../../shared/types/pluginUiPrompt.js";

const sendToAgent: PluginUiPromptParams = {
  kind: "sendToAgent",
  request: { text: "Card body", sourceLabel: "Deploy", terminalId: "t-1" },
};

describe("coercePromptAnswer for a remote send-to-agent", () => {
  it("passes each well-formed outcome through", () => {
    for (const answer of [
      { status: "drafted", terminalId: "t-1" },
      { status: "cancelled" },
      { status: "refused", reason: "input-busy" },
      { status: "refused", reason: "launch-failed", worktreeId: "wt-1" },
    ]) {
      expect(coercePromptAnswer(sendToAgent, answer)).toEqual(answer);
    }
  });

  it("reads anything else a Shell answers as cancelled", () => {
    for (const answer of [
      undefined,
      true,
      { status: "drafted" },
      { status: "refused", reason: "made-up" },
      { status: "submitted", terminalId: "t-1" },
    ]) {
      expect(coercePromptAnswer(sendToAgent, answer)).toEqual({ status: "cancelled" });
    }
  });
});

describe("PluginPromptPayloadSchema", () => {
  const payload = (params: unknown) => ({
    promptId: "p-1",
    pluginId: "acme.deploy",
    pluginDisplayName: "Deploy",
    params,
  });

  it("accepts a send-to-agent prompt", () => {
    expect(PluginPromptPayloadSchema.safeParse(payload(sendToAgent)).success).toBe(true);
  });

  it("refuses a send-to-agent without a source label", () => {
    const params = { kind: "sendToAgent", request: { text: "x", sourceLabel: "" } };
    expect(PluginPromptPayloadSchema.safeParse(payload(params)).success).toBe(false);
  });

  it("takes the same ids the host API does, up to 512 characters", () => {
    const params = (terminalId: string) => ({
      kind: "sendToAgent",
      request: { text: "x", sourceLabel: "Deploy", terminalId },
    });
    expect(PluginPromptPayloadSchema.safeParse(payload(params("t".repeat(512)))).success).toBe(
      true
    );
    expect(PluginPromptPayloadSchema.safeParse(payload(params("t".repeat(513)))).success).toBe(
      false
    );
    const long = "t".repeat(300);
    expect(coercePromptAnswer(sendToAgent, { status: "drafted", terminalId: long })).toEqual({
      status: "drafted",
      terminalId: long,
    });
  });
});
