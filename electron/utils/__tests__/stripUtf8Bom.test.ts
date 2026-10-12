import { describe, expect, it } from "vitest";
import { stripUtf8Bom } from "../stripUtf8Bom.js";

describe("stripUtf8Bom", () => {
  it("makes BOM-prefixed JSON parseable", () => {
    expect(() => JSON.parse("﻿{}")).toThrow();
    expect(JSON.parse(stripUtf8Bom('﻿{"a":1}'))).toEqual({ a: 1 });
  });

  it("removes exactly one leading BOM", () => {
    expect(stripUtf8Bom("﻿﻿x")).toBe("﻿x");
  });

  it("leaves text without a leading BOM untouched", () => {
    const text = '{"k":"a﻿b"}';
    expect(stripUtf8Bom(text)).toBe(text);
    expect(stripUtf8Bom("")).toBe("");
  });
});
