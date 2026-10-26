import { describe, expect, it } from "vitest";
import { ClientAppError } from "../clientAppError";
import { hostAgentLimitFromError, hostAgentLimitSpawnError } from "../hostAgentLimitSpawnError";

describe("hostAgentLimitSpawnError (#14704)", () => {
  const hostAgentLimit = { host: "Studio", count: 12, limit: 10 };
  const refusal = new ClientAppError(
    "HOST_AGENT_LIMIT_REACHED",
    "Agent launch refused",
    "Studio has reached its limit of 10 live agent terminals.",
    { code: "HOST_AGENT_LIMIT_REACHED", ...hostAgentLimit }
  );

  it("keeps the host and count the refusal was judged on, and the message the person reads", () => {
    expect(hostAgentLimitFromError(refusal)).toEqual(hostAgentLimit);
    expect(hostAgentLimitSpawnError(refusal)).toEqual({
      code: "HOST_AGENT_LIMIT",
      message: "Studio has reached its limit of 10 live agent terminals.",
      hostAgentLimit,
    });
  });

  it("leaves every other failure to the ordinary spawn error", () => {
    expect(hostAgentLimitSpawnError(new ClientAppError("PERMISSION", "no"))).toBeNull();
    expect(
      hostAgentLimitSpawnError(new ClientAppError("HOST_AGENT_LIMIT_REACHED", "no"))
    ).toBeNull();
    expect(hostAgentLimitSpawnError(new Error("ENOENT"))).toBeNull();
  });
});
