import { describe, it, expect } from "vitest";
import path from "path";
import { generateProjectId, isValidProjectId, getProjectStateDir } from "../projectStorePaths.js";

describe("ProjectStore", () => {
  describe("generateProjectId", () => {
    it("generates valid SHA256 hex string IDs", () => {
      const id = generateProjectId("/Users/foo/my-repo");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates deterministic IDs for same path", () => {
      const id1 = generateProjectId("/Users/foo/my-repo");
      const id2 = generateProjectId("/Users/foo/my-repo");
      expect(id1).toBe(id2);
    });

    it("generates different IDs for different paths", () => {
      const id1 = generateProjectId("/Users/foo/repo-a");
      const id2 = generateProjectId("/Users/foo/repo-b");
      expect(id1).not.toBe(id2);
    });

    it("handles paths with special characters", () => {
      const id = generateProjectId("/Users/foo/my-repo with spaces & symbols!");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles empty string", () => {
      const id = generateProjectId("");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles unicode paths", () => {
      const id = generateProjectId("/Users/用户/项目");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles Windows-style paths", () => {
      const id = generateProjectId("C:\\Users\\foo\\my-repo");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("isValidProjectId", () => {
    it("accepts valid 64-character hex string", () => {
      const validId = "a".repeat(64);
      expect(isValidProjectId(validId)).toBe(true);
    });

    it("accepts mixed hex characters", () => {
      const validId = "0123456789abcdef".repeat(4);
      expect(isValidProjectId(validId)).toBe(true);
    });

    it("rejects short strings", () => {
      expect(isValidProjectId("abc")).toBe(false);
      expect(isValidProjectId("a".repeat(63))).toBe(false);
    });

    it("rejects long strings", () => {
      expect(isValidProjectId("a".repeat(65))).toBe(false);
    });

    it("rejects non-hex characters", () => {
      expect(isValidProjectId("g".repeat(64))).toBe(false);
      expect(isValidProjectId("z".repeat(64))).toBe(false);
    });

    it("rejects uppercase hex characters", () => {
      expect(isValidProjectId("A".repeat(64))).toBe(false);
      expect(isValidProjectId("ABCDEF".repeat(10) + "abcd")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidProjectId("")).toBe(false);
    });

    it("rejects path traversal attempts", () => {
      expect(isValidProjectId("../../../etc/passwd")).toBe(false);
      expect(isValidProjectId("..")).toBe(false);
      expect(isValidProjectId("./test")).toBe(false);
    });

    it("rejects strings with slashes", () => {
      expect(isValidProjectId("a".repeat(32) + "/" + "b".repeat(31))).toBe(false);
    });

    it("rejects strings with special characters", () => {
      expect(isValidProjectId("a".repeat(63) + "!")).toBe(false);
      expect(isValidProjectId("a".repeat(63) + " ")).toBe(false);
    });
  });

  describe("getProjectStateDir", () => {
    const projectsConfigDir = path.resolve("/home/user/.config/daintree/projects");

    it("returns valid path for valid hex ID", () => {
      const validId = "a".repeat(64);
      const dir = getProjectStateDir(projectsConfigDir, validId);
      expect(dir).toBe(path.join(projectsConfigDir, validId));
    });

    it("returns null for invalid project ID", () => {
      expect(getProjectStateDir(projectsConfigDir, "invalid")).toBeNull();
      expect(getProjectStateDir(projectsConfigDir, "")).toBeNull();
      expect(getProjectStateDir(projectsConfigDir, "short")).toBeNull();
    });

    it("rejects path traversal attempt with ../", () => {
      const maliciousId = "../../../etc/passwd";
      const dir = getProjectStateDir(projectsConfigDir, maliciousId);
      expect(dir).toBeNull();
    });

    it("rejects path with .. in middle", () => {
      const attemptedTraversal = "a".repeat(30) + ".." + "a".repeat(32);
      const dir = getProjectStateDir(projectsConfigDir, attemptedTraversal);
      expect(dir).toBeNull();
    });

    it("accepts generated project IDs", () => {
      const projectPath = "/Users/foo/my-repo";
      const id = generateProjectId(projectPath);
      const dir = getProjectStateDir(projectsConfigDir, id);

      expect(dir).not.toBeNull();
      expect(dir).toBe(path.join(projectsConfigDir, id));
    });

    it("only allows hex IDs in state dir paths", () => {
      const realId = generateProjectId("/some/path");
      expect(getProjectStateDir(projectsConfigDir, realId)).not.toBeNull();

      expect(getProjectStateDir(projectsConfigDir, "test-project-name")).toBeNull();
      expect(getProjectStateDir(projectsConfigDir, "my_project_123")).toBeNull();
    });
  });

  describe("path safety integration", () => {
    const projectsConfigDir = path.resolve("/home/user/.config/daintree/projects");

    it("prevents accessing files outside projectsConfigDir", () => {
      const attacks = [
        "../../../etc/passwd",
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//etc/passwd",
        "..\\..\\..\\etc\\passwd",
        "/etc/passwd",
        "a/../../../etc/passwd",
      ];

      for (const attack of attacks) {
        const result = getProjectStateDir(projectsConfigDir, attack);
        expect(result).toBeNull();
      }
    });

    it("end-to-end: project path to secure state dir", () => {
      const projectPath = "/Users/developer/my-project";

      const id = generateProjectId(projectPath);
      expect(isValidProjectId(id)).toBe(true);

      const stateDir = getProjectStateDir(projectsConfigDir, id);
      expect(stateDir).not.toBeNull();

      expect(stateDir!.startsWith(projectsConfigDir)).toBe(true);

      expect(stateDir!.includes(projectPath)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles null-like inputs gracefully", () => {
      expect(isValidProjectId("null")).toBe(false);
      expect(isValidProjectId("undefined")).toBe(false);
    });

    it("handles very long paths for ID generation", () => {
      const longPath = "/a".repeat(1000);
      const id = generateProjectId(longPath);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles symlink-like path patterns", () => {
      const symlinkPath = "/Users/foo/link -> /actual/path";
      const id = generateProjectId(symlinkPath);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles paths with newlines", () => {
      const pathWithNewline = "/Users/foo/my\nrepo";
      const id = generateProjectId(pathWithNewline);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

describe("ProjectStore ID collision resistance", () => {
  it("generates unique IDs for similar paths", () => {
    const paths = [
      "/Users/foo/project",
      "/Users/foo/project1",
      "/Users/foo/project2",
      "/Users/foo/projects",
      "/Users/foo/project/",
      "/users/foo/project",
    ];

    const ids = paths.map(generateProjectId);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(paths.length);
  });

  it("generates unique IDs for 1000 random paths", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      const randomPath = `/Users/test/project-${i}-${Math.random().toString(36)}`;
      const id = generateProjectId(randomPath);
      ids.add(id);
    }

    expect(ids.size).toBe(1000);
  });
});

describe("ProjectSettings validation", () => {
  function validateAndSanitizeSettings(parsed: unknown): {
    runCommands: Array<{ label: string; command: string; icon?: string; description?: string }>;
    environmentVariables?: Record<string, string>;
    excludedPaths?: string[];
    projectIconSvg?: string;
    defaultWorktreeRecipeId?: string;
    devServerCommand?: string;
  } {
    const obj = parsed as Record<string, unknown>;

    return {
      runCommands: Array.isArray(obj?.runCommands) ? obj.runCommands : [],
      environmentVariables: obj?.environmentVariables as Record<string, string> | undefined,
      excludedPaths: obj?.excludedPaths as string[] | undefined,
      projectIconSvg: typeof obj?.projectIconSvg === "string" ? obj.projectIconSvg : undefined,
      defaultWorktreeRecipeId:
        typeof obj?.defaultWorktreeRecipeId === "string" ? obj.defaultWorktreeRecipeId : undefined,
      devServerCommand:
        typeof obj?.devServerCommand === "string" ? obj.devServerCommand : undefined,
    };
  }

  describe("projectIconSvg validation", () => {
    it("accepts valid SVG string", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
      });

      expect(settings.projectIconSvg).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
      );
    });

    it("rejects non-string projectIconSvg", () => {
      const settingsNull = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: null,
      });
      expect(settingsNull.projectIconSvg).toBeUndefined();

      const settingsNumber = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: 12345,
      });
      expect(settingsNumber.projectIconSvg).toBeUndefined();

      const settingsObject = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: { svg: "<svg/>" },
      });
      expect(settingsObject.projectIconSvg).toBeUndefined();

      const settingsArray = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: ["<svg/>"],
      });
      expect(settingsArray.projectIconSvg).toBeUndefined();
    });

    it("accepts empty string for projectIconSvg", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: "",
      });

      expect(settings.projectIconSvg).toBe("");
    });

    it("preserves SVG content exactly", () => {
      const complexSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="grad1">
            <stop offset="0%" style="stop-color:rgb(255,255,0);stop-opacity:1" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="40" fill="url(#grad1)"/>
      </svg>`;

      const settings = validateAndSanitizeSettings({
        runCommands: [],
        projectIconSvg: complexSvg,
      });

      expect(settings.projectIconSvg).toBe(complexSvg);
    });
  });

  describe("runCommands validation", () => {
    it("accepts valid runCommands array", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [
          { label: "Build", command: "npm run build", icon: "hammer" },
          { label: "Test", command: "npm test" },
        ],
      });

      expect(settings.runCommands).toHaveLength(2);
      expect(settings.runCommands[0]).toEqual({
        label: "Build",
        command: "npm run build",
        icon: "hammer",
      });
    });

    it("returns empty array for non-array runCommands", () => {
      const settingsNull = validateAndSanitizeSettings({
        runCommands: null,
      });
      expect(settingsNull.runCommands).toEqual([]);

      const settingsString = validateAndSanitizeSettings({
        runCommands: "not an array",
      });
      expect(settingsString.runCommands).toEqual([]);

      const settingsObject = validateAndSanitizeSettings({
        runCommands: { build: "npm run build" },
      });
      expect(settingsObject.runCommands).toEqual([]);
    });

    it("returns empty array for undefined runCommands", () => {
      const settings = validateAndSanitizeSettings({});
      expect(settings.runCommands).toEqual([]);
    });
  });

  describe("defaultWorktreeRecipeId validation", () => {
    it("accepts valid string", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        defaultWorktreeRecipeId: "recipe-123",
      });

      expect(settings.defaultWorktreeRecipeId).toBe("recipe-123");
    });

    it("rejects non-string values", () => {
      const settingsNumber = validateAndSanitizeSettings({
        runCommands: [],
        defaultWorktreeRecipeId: 123,
      });
      expect(settingsNumber.defaultWorktreeRecipeId).toBeUndefined();

      const settingsNull = validateAndSanitizeSettings({
        runCommands: [],
        defaultWorktreeRecipeId: null,
      });
      expect(settingsNull.defaultWorktreeRecipeId).toBeUndefined();
    });
  });

  describe("devServerCommand validation", () => {
    it("accepts valid string", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        devServerCommand: "npm run dev",
      });

      expect(settings.devServerCommand).toBe("npm run dev");
    });

    it("rejects non-string values", () => {
      const settingsNumber = validateAndSanitizeSettings({
        runCommands: [],
        devServerCommand: 123,
      });
      expect(settingsNumber.devServerCommand).toBeUndefined();

      const settingsArray = validateAndSanitizeSettings({
        runCommands: [],
        devServerCommand: ["npm", "run", "dev"],
      });
      expect(settingsArray.devServerCommand).toBeUndefined();
    });
  });

  describe("settings round-trip", () => {
    it("preserves all valid fields through parse/stringify", () => {
      const originalSettings = {
        runCommands: [
          {
            label: "Build",
            command: "npm run build",
            icon: "hammer",
            description: "Build project",
          },
          { label: "Test", command: "npm test" },
        ],
        environmentVariables: {
          NODE_ENV: "development",
          DEBUG: "true",
        },
        excludedPaths: ["node_modules", ".git", "dist"],
        projectIconSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        defaultWorktreeRecipeId: "recipe-456",
        devServerCommand: "npm run dev -- --port 3000",
      };

      const serialized = JSON.stringify(originalSettings, null, 2);
      const parsed = JSON.parse(serialized);
      const validated = validateAndSanitizeSettings(parsed);

      expect(validated.runCommands).toEqual(originalSettings.runCommands);
      expect(validated.environmentVariables).toEqual(originalSettings.environmentVariables);
      expect(validated.excludedPaths).toEqual(originalSettings.excludedPaths);
      expect(validated.projectIconSvg).toBe(originalSettings.projectIconSvg);
      expect(validated.defaultWorktreeRecipeId).toBe(originalSettings.defaultWorktreeRecipeId);
      expect(validated.devServerCommand).toBe(originalSettings.devServerCommand);
    });

    it("handles corrupted JSON gracefully", () => {
      const corrupted = {
        runCommands: "not an array",
        projectIconSvg: 12345,
        defaultWorktreeRecipeId: { id: "test" },
        devServerCommand: null,
      };

      const validated = validateAndSanitizeSettings(corrupted);

      expect(validated.runCommands).toEqual([]);
      expect(validated.projectIconSvg).toBeUndefined();
      expect(validated.defaultWorktreeRecipeId).toBeUndefined();
      expect(validated.devServerCommand).toBeUndefined();
    });

    it("handles empty object", () => {
      const validated = validateAndSanitizeSettings({});

      expect(validated.runCommands).toEqual([]);
      expect(validated.projectIconSvg).toBeUndefined();
      expect(validated.defaultWorktreeRecipeId).toBeUndefined();
      expect(validated.devServerCommand).toBeUndefined();
    });

    it("handles null input", () => {
      const validated = validateAndSanitizeSettings(null);

      expect(validated.runCommands).toEqual([]);
    });

    it("handles undefined input", () => {
      const validated = validateAndSanitizeSettings(undefined);

      expect(validated.runCommands).toEqual([]);
    });
  });

  describe("environmentVariables validation", () => {
    it("accepts valid environment variables object", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        environmentVariables: {
          NODE_ENV: "production",
          API_KEY: "secret-key-123",
        },
      });

      expect(settings.environmentVariables).toEqual({
        NODE_ENV: "production",
        API_KEY: "secret-key-123",
      });
    });

    it("preserves undefined when environmentVariables is not set", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
      });

      expect(settings.environmentVariables).toBeUndefined();
    });
  });

  describe("excludedPaths validation", () => {
    it("accepts valid excludedPaths array", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
        excludedPaths: ["node_modules", ".git", "dist", "coverage"],
      });

      expect(settings.excludedPaths).toEqual(["node_modules", ".git", "dist", "coverage"]);
    });

    it("preserves undefined when excludedPaths is not set", () => {
      const settings = validateAndSanitizeSettings({
        runCommands: [],
      });

      expect(settings.excludedPaths).toBeUndefined();
    });
  });
});

describe("relocateProject — ID derivation helpers (smoke tests only)", () => {
  it("new path produces a valid project ID", () => {
    const newPath = "/Users/foo/moved-repo";
    const newId = generateProjectId(newPath);
    expect(isValidProjectId(newId)).toBe(true);
  });

  it("different paths produce different project IDs", () => {
    const oldPath = "/Users/foo/old-location";
    const newPath = "/Users/foo/new-location";
    const oldId = generateProjectId(oldPath);
    const newId = generateProjectId(newPath);
    expect(oldId).not.toBe(newId);
  });

  it("same path produces same project ID (no-op relocation path)", () => {
    const path1 = "/Users/foo/my-project";
    const id1 = generateProjectId(path1);
    const id2 = generateProjectId(path1);
    expect(id1).toBe(id2);
  });

  it("state dir path is computed correctly for new project ID", () => {
    const projectsConfigDir = path.resolve("/home/user/.config/daintree/projects");

    const newPath = "/Users/foo/new-location";
    const newId = generateProjectId(newPath);
    const newStateDir = getProjectStateDir(projectsConfigDir, newId);

    expect(newStateDir).not.toBeNull();
    expect(newStateDir!.startsWith(projectsConfigDir)).toBe(true);
    expect(newStateDir).toBe(path.join(projectsConfigDir, newId));
  });
});
