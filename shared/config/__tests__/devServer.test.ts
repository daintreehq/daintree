import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_SERVER_PORT,
  getDevServerConfig,
  getDevServerOrigins,
  getDevServerUrl,
  getDevServerWebSocketOrigins,
} from "../devServer.js";

describe("devServer config", () => {
  it("returns the default loopback dev server config", () => {
    const config = getDevServerConfig({});

    expect(config).toEqual({
      host: "127.0.0.1",
      origin: `http://127.0.0.1:${DEFAULT_DEV_SERVER_PORT}`,
      port: DEFAULT_DEV_SERVER_PORT,
      protocol: "http:",
    });
  });

  it("supports explicit dev server URL overrides", () => {
    const env = {
      CANOPY_DEV_SERVER_URL: "http://localhost:6123",
    };

    expect(getDevServerUrl(env)).toBe("http://localhost:6123");
    expect(getDevServerOrigins(env)).toEqual(["http://localhost:6123", "http://127.0.0.1:6123"]);
    expect(getDevServerWebSocketOrigins(env)).toEqual([
      "ws://localhost:6123",
      "ws://127.0.0.1:6123",
    ]);
  });

  it("falls back to host and port env when URL override is invalid", () => {
    const env = {
      CANOPY_DEV_SERVER_HOST: "localhost",
      CANOPY_DEV_SERVER_PORT: "6124",
      CANOPY_DEV_SERVER_URL: "notaurl",
    };

    expect(getDevServerConfig(env)).toEqual({
      host: "localhost",
      origin: "http://localhost:6124",
      port: 6124,
      protocol: "http:",
    });
  });
});
