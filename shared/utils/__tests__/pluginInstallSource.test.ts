import { describe, expect, it } from "vitest";
import { describeCatalogSource, describePluginInstallSource } from "../pluginInstallSource.js";

describe("describePluginInstallSource", () => {
  it("names a local archive by its file name alone", () => {
    expect(describePluginInstallSource("/Users/me/Downloads/acme-1.2.0.dntr")).toBe(
      "acme-1.2.0.dntr"
    );
    expect(describePluginInstallSource("C:\\Users\\me\\Downloads\\acme.dntr")).toBe("acme.dntr");
  });

  it("keeps a URL's host and path but never its query or fragment", () => {
    const label = describePluginInstallSource(
      "https://cdn.example.com/plugins/acme.dntr?X-Amz-Signature=secret#frag"
    );
    expect(label).toBe("cdn.example.com/plugins/acme.dntr");
    expect(label).not.toMatch(/secret|frag|\?/);
  });
});

describe("describeCatalogSource (#17434)", () => {
  it("keeps the host and the path as they are", () => {
    expect(describeCatalogSource("https://plugins.example.org/catalog.json")).toBe(
      "plugins.example.org/catalog.json"
    );
    expect(describeCatalogSource("https://plugins.example.org/lists/")).toBe(
      "plugins.example.org/lists/"
    );
    expect(describeCatalogSource("https://plugins.example.org/")).toBe("plugins.example.org");
  });

  it("marks a query without showing it, so two catalogs on one path stay apart", () => {
    const withQuery = describeCatalogSource("https://plugins.example.org/c.json?token=secret");
    expect(withQuery).toBe("plugins.example.org/c.json?…");
    expect(withQuery).not.toContain("secret");
    expect(withQuery).not.toBe(describeCatalogSource("https://plugins.example.org/c.json"));
  });
});
