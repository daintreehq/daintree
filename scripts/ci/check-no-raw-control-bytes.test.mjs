import { describe, it, expect } from "vitest";
import { findControlBytes, formatByte, isBinaryPath } from "./check-no-raw-control-bytes.mjs";

describe("check-no-raw-control-bytes", () => {
  describe("findControlBytes", () => {
    it("allows TAB, LF, and CR", () => {
      expect(findControlBytes(Buffer.from("a\tb\r\nc\n", "utf8"))).toEqual([]);
    });

    it("allows escape sequences written as text", () => {
      expect(findControlBytes(Buffer.from("const s = `${a}\\x00${b}`;\n", "utf8"))).toEqual([]);
    });

    it("reports a raw NUL with its line and column", () => {
      const buf = Buffer.from([0x61, 0x0a, 0x62, 0x63, 0x00, 0x64, 0x0a]);
      expect(findControlBytes(buf)).toEqual([{ line: 2, column: 3, byte: 0x00 }]);
    });

    it("reports every other C0 byte but not space or DEL", () => {
      const buf = Buffer.from([0x01, 0x1b, 0x07, 0x1f, 0x0b, 0x0c, 0x20, 0x7f]);
      expect(findControlBytes(buf).map((h) => h.byte)).toEqual([
        0x01, 0x1b, 0x07, 0x1f, 0x0b, 0x0c,
      ]);
    });

    it("finds a NUL past the first 8 KB", () => {
      const buf = Buffer.concat([Buffer.alloc(10_000, 0x61), Buffer.from([0x00])]);
      expect(findControlBytes(buf)).toEqual([{ line: 1, column: 10_001, byte: 0x00 }]);
    });

    it("does not flag UTF-8 multibyte characters", () => {
      expect(findControlBytes(Buffer.from("— é 日本\n", "utf8"))).toEqual([]);
    });
  });

  describe("isBinaryPath", () => {
    it("excludes binary asset extensions case-insensitively", () => {
      expect(isBinaryPath("build/icon.PNG")).toBe(true);
      expect(isBinaryPath("build/icon-compiled/Assets.car")).toBe(true);
      expect(isBinaryPath("electron/resources/sounds/chime.wav")).toBe(true);
    });

    it("scans source and text files", () => {
      expect(isBinaryPath("electron/services/PtyClient.ts")).toBe(false);
      expect(isBinaryPath("docs/README.md")).toBe(false);
      expect(isBinaryPath(".nvmrc")).toBe(false);
    });
  });

  it("formats bytes as two-digit hex", () => {
    expect(formatByte(0x00)).toBe("0x00");
    expect(formatByte(0x1b)).toBe("0x1b");
  });
});
