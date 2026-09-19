import { describe, expect, it } from "vitest";
import {
  appendHandbackInstruction,
  buildHandbackInstruction,
  isHandbackCode,
  mintHandbackCode,
} from "../handback.js";
import { HANDBACK_CODE_TOKEN } from "../../types/handback.js";

describe("buildHandbackInstruction", () => {
  const instruction = buildHandbackInstruction("k7f3qa");

  it("ends with the marker line for the minted code", () => {
    expect(instruction.endsWith("DAINTREE-DONE-k7f3qa: <summary> END-k7f3qa")).toBe(true);
  });

  it("carries the code in exactly one marker pair", () => {
    expect(instruction.match(/DAINTREE-DONE-k7f3qa/g)).toHaveLength(1);
    expect(instruction.match(/END-k7f3qa/g)).toHaveLength(1);
    expect(instruction).not.toContain(HANDBACK_CODE_TOKEN);
  });

  it("stays on one line, so a launch that flattens newlines keeps it intact", () => {
    expect(instruction).not.toMatch(/[\r\n]/);
  });

  it("starts both markers with a letter, so no TUI renders them as markup", () => {
    const markers = instruction.match(/\S*(?:DAINTREE-DONE|END)-k7f3qa/g) ?? [];
    expect(markers).toHaveLength(2);
    for (const marker of markers) expect(marker).toMatch(/^[A-Za-z]/);
  });
});

describe("appendHandbackInstruction", () => {
  it("appends the instruction after one blank line, as the last thing", () => {
    expect(appendHandbackInstruction("Fix the bug", "k7f3qa")).toBe(
      `Fix the bug\n\n${buildHandbackInstruction("k7f3qa")}`
    );
  });

  it("drops trailing line breaks so the gap stays one blank line", () => {
    expect(appendHandbackInstruction("Fix the bug\r\n\n", "k7f3qa")).toBe(
      `Fix the bug\n\n${buildHandbackInstruction("k7f3qa")}`
    );
  });

  it("leaves interior text untouched", () => {
    const text = "line one\n\n  indented line two  ";
    expect(appendHandbackInstruction(text, "k7f3qa").startsWith(`${text}\n\n`)).toBe(true);
  });
});

describe("mintHandbackCode", () => {
  it("mints six characters from [a-z0-9]", () => {
    for (let i = 0; i < 200; i++) {
      const code = mintHandbackCode();
      expect(code).toMatch(/^[a-z0-9]{6}$/);
      expect(isHandbackCode(code)).toBe(true);
    }
  });

  it("mints a fresh code each time", () => {
    const codes = new Set(Array.from({ length: 200 }, () => mintHandbackCode()));
    expect(codes.size).toBe(200);
  });
});

describe("isHandbackCode", () => {
  it("rejects anything but six lowercase alphanumerics", () => {
    expect(isHandbackCode("K7F3QA")).toBe(false);
    expect(isHandbackCode("k7f3q")).toBe(false);
    expect(isHandbackCode("k7f3qa1")).toBe(false);
    expect(isHandbackCode("k7f-qa")).toBe(false);
    expect(isHandbackCode(123456)).toBe(false);
    expect(isHandbackCode(undefined)).toBe(false);
  });
});
