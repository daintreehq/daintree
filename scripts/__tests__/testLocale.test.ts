import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestLocale } from "../lib/testLocale.js";

let restore: () => void;
beforeEach(() => {
  restore = installTestLocale("en-US");
});
afterEach(() => restore());

describe("test locale contracts", () => {
  it("preserves subclasses and native prototypes", () => {
    class Custom extends Intl.NumberFormat {
      marker() {
        return "custom";
      }
    }
    const formatter = new Custom();
    expect(formatter).toBeInstanceOf(Custom);
    expect(formatter).toBeInstanceOf(Intl.NumberFormat);
    expect(formatter.marker()).toBe("custom");
    expect(formatter.format(1234)).toBe("1,234");
    expect(Intl.NumberFormat.supportedLocalesOf(["en-US"])).toEqual(["en-US"]);
  });

  it("keeps callable constructors callable and new-only constructors new-only", () => {
    expect(Intl.NumberFormat().format(1234)).toBe("1,234");
    expect(() => Reflect.apply(Intl.Segmenter, undefined, [])).toThrow(TypeError);
    expect(new Intl.Segmenter().resolvedOptions().locale).toBe("en-US");
  });

  it("pins missing and empty locales and respects explicit ones", () => {
    expect(new Intl.NumberFormat([]).resolvedOptions().locale).toBe("en-US");
    expect(new Intl.NumberFormat("de-DE").format(1234)).toBe("1.234");
    expect((1234).toLocaleString()).toBe("1,234");
    expect((1234).toLocaleString("de-DE")).toBe("1.234");
  });

  it("validates Number receivers and reads boxed numbers without user coercion", () => {
    expect(() => Number.prototype.toLocaleString.call("1234")).toThrow(TypeError);
    expect(() => Number.prototype.toLocaleString.call(null)).toThrow(TypeError);
    const boxed = Object(1234);
    boxed.valueOf = () => 999;
    boxed[Symbol.toPrimitive] = () => 888;
    expect(Number.prototype.toLocaleString.call(boxed)).toBe("1,234");
  });

  it("preserves localeCompare receiver validation and coercion order", () => {
    expect(() => String.prototype.localeCompare.call(null, "x")).toThrow(TypeError);
    expect(() => String.prototype.localeCompare.call(undefined, "x")).toThrow(TypeError);
    expect(() => String.prototype.localeCompare.call(Symbol("x"), "x")).toThrow(TypeError);
    expect(String.prototype.localeCompare.call(Object("a"), "b")).toBeLessThan(0);
    const calls: string[] = [];
    const receiver = {
      toString: () => {
        calls.push("receiver");
        return "a";
      },
    };
    const other = {
      toString: () => {
        calls.push("other");
        return "b";
      },
    };
    String.prototype.localeCompare.call(receiver, other as unknown as string);
    expect(calls).toEqual(["receiver", "other"]);
  });
});
