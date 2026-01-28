import { describe, it, expect } from "vitest";
import { createProjectSettingsSnapshot, areSnapshotsEqual } from "../projectSettingsDirty";
import type { CommandOverride } from "@shared/types/commands";

describe("projectSettingsDirty", () => {
  describe("createProjectSettingsSnapshot", () => {
    it("should create a normalized snapshot", () => {
      const snapshot = createProjectSettingsSnapshot(
        "  My Project  ",
        "🌲",
        "  npm run dev  ",
        undefined,
        ["  node_modules/**  ", "", "  dist/**  "],
        [
          { id: "1", key: "  API_KEY  ", value: "secret123" },
          { id: "2", key: "  PORT  ", value: "3000" },
        ],
        [
          {
            id: "cmd1",
            name: "  Build  ",
            command: "  npm run build  ",
            icon: "🔨",
            description: "Build the app",
          },
          { id: "cmd2", name: "", command: "test", icon: undefined },
        ],
        "recipe-123",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(snapshot.name).toBe("My Project");
      expect(snapshot.devServerCommand).toBe("npm run dev");
      expect(snapshot.excludedPaths).toEqual(["node_modules/**", "dist/**"]);
      expect(snapshot.environmentVariables).toEqual({
        API_KEY: "secret123",
        PORT: "3000",
      });
      expect(snapshot.runCommands).toHaveLength(2);
      expect(snapshot.runCommands[0]).toEqual({
        id: "cmd1",
        name: "Build",
        command: "npm run build",
      });
      expect(snapshot.runCommands[1]).toEqual({
        id: "cmd2",
        name: "",
        command: "test",
      });
      expect(snapshot.defaultWorktreeRecipeId).toBe("recipe-123");
    });

    it("should keep partial environment variables with values", () => {
      const snapshot = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "",
        undefined,
        [],
        [
          { id: "1", key: "  ", value: "value1" },
          { id: "2", key: "KEY", value: "value2" },
        ],
        [],
        undefined,
        [],
        {}
      );

      expect(Object.keys(snapshot.environmentVariables).length).toBe(2);
      expect(snapshot.environmentVariables["KEY"]).toBe("value2");
      expect(snapshot.environmentVariables["__partial_1"]).toBe("value1");
    });

    it("should keep duplicate environment variable keys for dirty tracking", () => {
      const snapshot = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "",
        undefined,
        [],
        [
          { id: "1", key: "KEY", value: "value1" },
          { id: "2", key: "KEY", value: "value2" },
        ],
        [],
        undefined,
        [],
        {}
      );

      expect(Object.keys(snapshot.environmentVariables).length).toBe(2);
      expect(snapshot.environmentVariables["KEY"]).toBeDefined();
    });

    it("should sort environment variables by key", () => {
      const snapshot = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "",
        undefined,
        [],
        [
          { id: "1", key: "ZEBRA", value: "z" },
          { id: "2", key: "ALPHA", value: "a" },
          { id: "3", key: "BETA", value: "b" },
        ],
        [],
        undefined,
        [],
        {}
      );

      expect(Object.keys(snapshot.environmentVariables)).toEqual(["ALPHA", "BETA", "ZEBRA"]);
    });

    it("should preserve excluded paths order", () => {
      const snapshot = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "",
        undefined,
        ["z/**", "a/**", "m/**"],
        [],
        [],
        undefined,
        [],
        {}
      );

      expect(snapshot.excludedPaths).toEqual(["z/**", "a/**", "m/**"]);
    });

    it("should preserve command overrides order", () => {
      const overrides: CommandOverride[] = [
        { commandId: "z", disabled: false },
        { commandId: "a", disabled: true },
      ];

      const snapshot = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "",
        undefined,
        [],
        [],
        [],
        undefined,
        overrides,
        {}
      );

      expect(snapshot.commandOverrides[0].commandId).toBe("z");
      expect(snapshot.commandOverrides[1].commandId).toBe("a");
    });
  });

  describe("areSnapshotsEqual", () => {
    const baseSnapshot = createProjectSettingsSnapshot(
      "Project",
      "🌲",
      "npm run dev",
      undefined,
      ["node_modules/**"],
      [{ id: "1", key: "KEY", value: "value" }],
      [{ id: "cmd1", name: "Build", command: "npm run build" }],
      "recipe-1",
      [{ commandId: "test", disabled: false }],
      {}
    );

    it("should return true for identical snapshots", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(true);
    });

    it("should detect changed name", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Different Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed emoji", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🚀",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed devServerCommand", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm start",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed projectIconSvg", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        "<svg></svg>",
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed excludedPaths", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**", "dist/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed environment variables", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "different-value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed runCommands", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Test", command: "npm test" }],
        "recipe-1",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed defaultWorktreeRecipeId", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-2",
        [{ commandId: "test", disabled: false }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });

    it("should detect changed commandOverrides", () => {
      const snapshot2 = createProjectSettingsSnapshot(
        "Project",
        "🌲",
        "npm run dev",
        undefined,
        ["node_modules/**"],
        [{ id: "1", key: "KEY", value: "value" }],
        [{ id: "cmd1", name: "Build", command: "npm run build" }],
        "recipe-1",
        [{ commandId: "test", disabled: true }],
        {}
      );

      expect(areSnapshotsEqual(baseSnapshot, snapshot2)).toBe(false);
    });
  });
});
