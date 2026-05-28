import { describe, it, expect } from "vitest";
import { McpServerContributionSchema } from "../plugin.js";

describe("McpServerContributionSchema (issue #9233)", () => {
  it("accepts a minimal stdio contribution", () => {
    const result = McpServerContributionSchema.safeParse({
      id: "linear",
      name: "Linear",
      command: "npx",
    });
    expect(result.success).toBe(true);
  });

  it("accepts args and env", () => {
    const result = McpServerContributionSchema.safeParse({
      id: "linear",
      name: "Linear",
      command: "npx",
      args: ["-y", "@linear/mcp"],
      env: { LINEAR_TOKEN: "abc" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a contribution declaring a url field (HTTP/SSE transport)", () => {
    const result = McpServerContributionSchema.safeParse({
      id: "linear",
      name: "Linear",
      command: "npx",
      url: "https://mcp.example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects any unknown top-level field", () => {
    const result = McpServerContributionSchema.safeParse({
      id: "linear",
      name: "Linear",
      command: "npx",
      transport: "stdio",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(McpServerContributionSchema.safeParse({ name: "Linear", command: "npx" }).success).toBe(
      false
    );
    expect(McpServerContributionSchema.safeParse({ id: "linear", command: "npx" }).success).toBe(
      false
    );
    expect(McpServerContributionSchema.safeParse({ id: "linear", name: "Linear" }).success).toBe(
      false
    );
  });

  it("rejects ids with disallowed characters", () => {
    const result = McpServerContributionSchema.safeParse({
      id: "linear server",
      name: "Linear",
      command: "npx",
    });
    expect(result.success).toBe(false);
  });
});
