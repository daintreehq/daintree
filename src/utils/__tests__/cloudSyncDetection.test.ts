import { describe, it, expect } from "vitest";
import { detectCloudSyncService } from "../cloudSyncDetection";

describe("detectCloudSyncService", () => {
  describe("macOS", () => {
    const home = "/Users/testuser";

    it.each([
      [`${home}/Library/CloudStorage/OneDrive-Personal/repo`, "OneDrive"],
      [`${home}/Library/CloudStorage/OneDrive-Acme Corp/repo`, "OneDrive"],
      [`${home}/Library/CloudStorage/OneDrive/repo`, "OneDrive"],
      [`${home}/Library/CloudStorage/GoogleDrive-user@gmail.com/repo`, "Google Drive"],
      [`${home}/Library/CloudStorage/Dropbox/repo`, "Dropbox"],
      [`${home}/Library/CloudStorage/Dropbox-TeamName/repo`, "Dropbox"],
      [`${home}/Library/Mobile Documents/com~apple~CloudDocs/repo`, "iCloud Drive"],
      [`${home}/Library/Mobile Documents/iCloud~com~app/repo`, "iCloud Drive"],
    ])("detects %s as %s", (path, expected) => {
      expect(detectCloudSyncService(path, home, "mac")).toBe(expected);
    });

    it("returns null for non-synced paths", () => {
      expect(detectCloudSyncService(`${home}/Projects/repo`, home, "mac")).toBeNull();
      expect(detectCloudSyncService(`${home}/Desktop/repo`, home, "mac")).toBeNull();
    });

    it("is case-insensitive", () => {
      expect(
        detectCloudSyncService(
          `${home}/library/cloudstorage/dropbox/repo`,
          home,
          "mac",
        ),
      ).toBe("Dropbox");
    });

    it("rejects boundary false positives", () => {
      expect(
        detectCloudSyncService(`${home}/Library/CloudStorageBackup/repo`, home, "mac"),
      ).toBeNull();
      expect(
        detectCloudSyncService(`${home}/Library/Mobile DocumentsOld/repo`, home, "mac"),
      ).toBeNull();
    });
  });

  describe("Windows", () => {
    const home = "C:/Users/testuser";

    it.each([
      [`${home}/OneDrive/repo`, "OneDrive"],
      [`${home}/OneDrive - Acme Corp/repo`, "OneDrive"],
      [`${home}/Dropbox/repo`, "Dropbox"],
      [`${home}/Dropbox (Team)/repo`, "Dropbox"],
      [`${home}/My Drive/repo`, "Google Drive"],
    ])("detects %s as %s", (path, expected) => {
      expect(detectCloudSyncService(path, home, "windows")).toBe(expected);
    });

    it("handles backslash paths", () => {
      expect(
        detectCloudSyncService(
          "C:\\Users\\testuser\\OneDrive\\repo",
          "C:\\Users\\testuser",
          "windows",
        ),
      ).toBe("OneDrive");
    });

    it("is case-insensitive", () => {
      expect(
        detectCloudSyncService(`${home}/onedrive/repo`, home, "windows"),
      ).toBe("OneDrive");
    });

    it("returns null for non-synced paths", () => {
      expect(detectCloudSyncService(`${home}/Projects/repo`, home, "windows")).toBeNull();
    });

    it("rejects boundary false positives", () => {
      expect(
        detectCloudSyncService(`${home}/OneDriveOld/repo`, home, "windows"),
      ).toBeNull();
      expect(
        detectCloudSyncService(`${home}/DropboxArchive/repo`, home, "windows"),
      ).toBeNull();
    });
  });

  describe("Linux", () => {
    const home = "/home/testuser";

    it.each([
      [`${home}/Dropbox/repo`, "Dropbox"],
      [`${home}/OneDrive/repo`, "OneDrive"],
    ])("detects %s as %s", (path, expected) => {
      expect(detectCloudSyncService(path, home, "linux")).toBe(expected);
    });

    it("is case-sensitive", () => {
      expect(detectCloudSyncService(`${home}/dropbox/repo`, home, "linux")).toBeNull();
    });

    it("returns null for non-synced paths", () => {
      expect(detectCloudSyncService(`${home}/projects/repo`, home, "linux")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty inputs", () => {
      expect(detectCloudSyncService("", "/Users/test", "mac")).toBeNull();
      expect(detectCloudSyncService("/Users/test/Dropbox/repo", "", "mac")).toBeNull();
    });

    it("handles trailing slashes", () => {
      expect(
        detectCloudSyncService(
          "/Users/test/Library/CloudStorage/Dropbox/repo/",
          "/Users/test/",
          "mac",
        ),
      ).toBe("Dropbox");
    });

    it("matches exact sync root without subpath", () => {
      expect(
        detectCloudSyncService(
          "/Users/test/Library/CloudStorage/Dropbox",
          "/Users/test",
          "mac",
        ),
      ).toBe("Dropbox");
    });
  });
});
