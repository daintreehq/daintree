import { describe, it, expect } from "vitest";
import { load } from "js-yaml";

const BASE_URL = "https://updates.canopyide.com/releases";

const MANIFESTS = [
  { name: "macOS", file: "latest-mac.yml" },
  { name: "Windows", file: "latest.yml" },
  { name: "Linux", file: "latest-linux.yml" },
] as const;

interface UpdateFile {
  url: string;
  sha512: string;
  size: number;
  blockMapSize?: number;
}

interface UpdateManifest {
  version: string;
  files: UpdateFile[];
  path: string;
  sha512: string;
  releaseDate: string;
}

describe("Update endpoint", () => {
  for (const { name, file } of MANIFESTS) {
    describe(`${name} (${file})`, () => {
      let manifest: UpdateManifest;

      it("returns 200 and valid YAML", async () => {
        const res = await fetch(`${BASE_URL}/${file}`);
        expect(res.status).toBe(200);

        const text = await res.text();
        manifest = load(text) as UpdateManifest;
        expect(manifest).toBeDefined();
      });

      it("has a valid semver version", () => {
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      });

      it("has at least one file entry with url, sha512, and size", () => {
        expect(manifest.files.length).toBeGreaterThan(0);
        for (const f of manifest.files) {
          expect(f.url).toBeTruthy();
          expect(f.sha512).toBeTruthy();
          expect(f.size).toBeGreaterThan(0);
        }
      });

      it("has a valid releaseDate", () => {
        const date = new Date(manifest.releaseDate);
        expect(date.getTime()).not.toBeNaN();
      });

      it("has a top-level path matching the first file url", () => {
        expect(manifest.path).toBe(manifest.files[0].url);
      });

      it("artifact URLs are reachable (HEAD request)", async () => {
        for (const f of manifest.files) {
          const artifactUrl = `${BASE_URL}/${encodeURIComponent(f.url)}`;
          const res = await fetch(artifactUrl, { method: "HEAD" });
          expect(res.status, `${f.url} should be reachable`).toBe(200);
          const contentLength = Number(res.headers.get("content-length"));
          expect(contentLength, `${f.url} content-length should match size`).toBe(f.size);
        }
      }, 30000);
    });
  }
});
