import { describe, expect, it } from "vitest";
import { createKeyedLogLimiter } from "../keyedLogLimiter.js";

describe("createKeyedLogLimiter", () => {
  it("lets the first call through and counts what it holds back", () => {
    let t = 0;
    const limiter = createKeyedLogLimiter({ windowMs: 1000, now: () => t });
    expect(limiter.take("a")).toBe(0);
    t = 500;
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    t = 1000;
    expect(limiter.take("a")).toBe(2);
    t = 2000;
    expect(limiter.take("a")).toBe(0);
  });

  it("keeps keys independent", () => {
    const limiter = createKeyedLogLimiter({ now: () => 0 });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("b")).toBe(0);
    expect(limiter.take("a")).toBeNull();
  });

  it("bounds the keys it remembers", () => {
    const limiter = createKeyedLogLimiter({ maxKeys: 2, now: () => 0 });
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("c")).toBeNull();
  });

  it("forgets everything on clear", () => {
    const limiter = createKeyedLogLimiter({ now: () => 0 });
    limiter.take("a");
    limiter.clear();
    expect(limiter.take("a")).toBe(0);
  });
});
