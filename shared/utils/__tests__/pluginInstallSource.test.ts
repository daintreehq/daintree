import { describe, expect, it } from "vitest";
import { describePluginInstallSource } from "../pluginInstallSource.js";

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
