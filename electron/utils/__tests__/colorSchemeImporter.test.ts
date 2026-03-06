import { describe, it, expect } from "vitest";
import { parseColorSchemeContent } from "../colorSchemeImporter.js";

const VALID_ITERMCOLORS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Ansi 0 Color</key>
  <dict>
    <key>Red Component</key> <real>0.0</real>
    <key>Green Component</key> <real>0.0</real>
    <key>Blue Component</key> <real>0.0</real>
  </dict>
  <key>Ansi 1 Color</key>
  <dict>
    <key>Red Component</key> <real>1.0</real>
    <key>Green Component</key> <real>0.0</real>
    <key>Blue Component</key> <real>0.0</real>
  </dict>
  <key>Ansi 2 Color</key>
  <dict>
    <key>Red Component</key> <real>0.0</real>
    <key>Green Component</key> <real>1.0</real>
    <key>Blue Component</key> <real>0.0</real>
  </dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key> <real>0.1</real>
    <key>Green Component</key> <real>0.1</real>
    <key>Blue Component</key> <real>0.1</real>
  </dict>
  <key>Foreground Color</key>
  <dict>
    <key>Red Component</key> <real>0.9</real>
    <key>Green Component</key> <real>0.9</real>
    <key>Blue Component</key> <real>0.9</real>
  </dict>
</dict>
</plist>`;

const VALID_BASE16 = JSON.stringify({
  scheme: "My Base16 Theme",
  base00: "#1a1a2e",
  base01: "#16213e",
  base02: "#0f3460",
  base03: "#533483",
  base04: "#e94560",
  base05: "#eaeaea",
  base06: "#f0f0f0",
  base07: "#ffffff",
  base08: "#ff6b6b",
  base09: "#ffa502",
  base0A: "#ffd93d",
  base0B: "#6bff6b",
  base0C: "#6bffff",
  base0D: "#6b6bff",
  base0E: "#ff6bff",
  base0F: "#ffb86b",
});

const VALID_VSCODE = JSON.stringify({
  name: "My VS Code Theme",
  colors: {
    "terminal.background": "#1e1e1e",
    "terminal.foreground": "#d4d4d4",
    "terminal.ansiBlack": "#000000",
    "terminal.ansiRed": "#cd3131",
    "terminal.ansiGreen": "#0dbc79",
    "terminal.ansiYellow": "#e5e510",
    "terminal.ansiBlue": "#2472c8",
    "terminal.ansiMagenta": "#bc3fbc",
    "terminal.ansiCyan": "#11a8cd",
    "terminal.ansiWhite": "#e5e5e5",
    "terminal.ansiBrightBlack": "#666666",
    "terminal.ansiBrightRed": "#f14c4c",
    "terminal.ansiBrightGreen": "#23d18b",
    "terminal.ansiBrightYellow": "#f5f543",
    "terminal.ansiBrightBlue": "#3b8eea",
    "terminal.ansiBrightMagenta": "#d670d6",
    "terminal.ansiBrightCyan": "#29b8db",
    "terminal.ansiBrightWhite": "#e5e5e5",
  },
});

describe("colorSchemeImporter", () => {
  describe("iTerm2 .itermcolors", () => {
    it("parses valid .itermcolors content", () => {
      const result = parseColorSchemeContent(VALID_ITERMCOLORS, "test.itermcolors");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.colors.black).toBe("#000000");
      expect(result.scheme.colors.red).toBe("#ff0000");
      expect(result.scheme.colors.green).toBe("#00ff00");
      expect(result.scheme.colors.background).toBe("#1a1a1a");
      expect(result.scheme.colors.foreground).toBe("#e6e6e6");
      expect(result.scheme.type).toBe("dark");
    });

    it("returns error for empty .itermcolors", () => {
      const result = parseColorSchemeContent("<plist></plist>", "empty.itermcolors");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]).toContain("No valid color entries");
    });

    it("fills missing colors with defaults", () => {
      const result = parseColorSchemeContent(VALID_ITERMCOLORS, "test.itermcolors");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // brightRed is not in the test fixture, should be filled with default
      expect(result.scheme.colors.brightRed).toBeDefined();
    });

    it("derives scheme name from filename", () => {
      const result = parseColorSchemeContent(VALID_ITERMCOLORS, "Dracula.itermcolors");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.name).toBe("Dracula");
      expect(result.scheme.id).toBe("custom-dracula");
    });

    it("parses .itermcolors with integer component values", () => {
      const integerPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key> <integer>0</integer>
    <key>Green Component</key> <integer>0</integer>
    <key>Blue Component</key> <integer>0</integer>
  </dict>
  <key>Foreground Color</key>
  <dict>
    <key>Red Component</key> <integer>1</integer>
    <key>Green Component</key> <integer>1</integer>
    <key>Blue Component</key> <integer>1</integer>
  </dict>
</dict></plist>`;
      const result = parseColorSchemeContent(integerPlist, "int-test.itermcolors");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.colors.background).toBe("#000000");
      expect(result.scheme.colors.foreground).toBe("#ffffff");
    });
  });

  describe("Base16 JSON", () => {
    it("parses valid Base16 JSON with correct ANSI slot mapping", () => {
      const result = parseColorSchemeContent(VALID_BASE16, "theme.json");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.name).toBe("My Base16 Theme");
      // base00 → background and black
      expect(result.scheme.colors.background).toBe("#1a1a2e");
      expect(result.scheme.colors.black).toBe("#1a1a2e");
      // base05 → foreground
      expect(result.scheme.colors.foreground).toBe("#eaeaea");
      // base08 → red
      expect(result.scheme.colors.red).toBe("#ff6b6b");
      // base0B → green
      expect(result.scheme.colors.green).toBe("#6bff6b");
      // base0D → blue
      expect(result.scheme.colors.blue).toBe("#6b6bff");
      expect(result.scheme.type).toBe("dark");
    });

    it("parses lowercase Base16 keys", () => {
      const lower = JSON.stringify({
        scheme: "Lowercase",
        base00: "#111111",
        base05: "#eeeeee",
        base08: "#ff0000",
      });
      const result = parseColorSchemeContent(lower, "lower.json");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.colors.background).toBe("#111111");
      expect(result.scheme.colors.foreground).toBe("#eeeeee");
      expect(result.scheme.colors.red).toBe("#ff0000");
    });

    it("returns error for empty JSON object", () => {
      const result = parseColorSchemeContent("{}", "empty.json");
      expect(result.ok).toBe(false);
    });
  });

  describe("VS Code JSON", () => {
    it("parses valid VS Code JSON", () => {
      const result = parseColorSchemeContent(VALID_VSCODE, "theme.json");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.name).toBe("My VS Code Theme");
      expect(result.scheme.colors.background).toBe("#1e1e1e");
      expect(result.scheme.colors.foreground).toBe("#d4d4d4");
      expect(result.scheme.colors.red).toBe("#cd3131");
      expect(result.scheme.colors.brightWhite).toBe("#e5e5e5");
      expect(result.scheme.type).toBe("dark");
    });

    it("handles flat VS Code format (no nested colors object)", () => {
      const flat = JSON.stringify({
        "terminal.background": "#1e1e1e",
        "terminal.foreground": "#d4d4d4",
        "terminal.ansiBlack": "#000000",
      });
      const result = parseColorSchemeContent(flat, "flat.json");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.colors.background).toBe("#1e1e1e");
    });
  });

  describe("error handling", () => {
    it("rejects invalid JSON", () => {
      const result = parseColorSchemeContent("not json", "bad.json");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]).toContain("Failed to parse");
    });

    it("rejects JSON array", () => {
      const result = parseColorSchemeContent("[1, 2, 3]", "array.json");
      expect(result.ok).toBe(false);
    });

    it("rejects unrecognized format", () => {
      const result = parseColorSchemeContent('{"foo": "bar"}', "unknown.json");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]).toContain("Unrecognized color scheme format");
    });
  });

  describe("light theme detection", () => {
    it("detects light themes by background luminance", () => {
      const lightVscode = JSON.stringify({
        "terminal.background": "#fdf6e3",
        "terminal.foreground": "#657b83",
        "terminal.ansiBlack": "#073642",
      });
      const result = parseColorSchemeContent(lightVscode, "light.json");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.scheme.type).toBe("light");
    });
  });
});
