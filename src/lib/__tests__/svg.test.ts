import { describe, it, expect } from "vitest";
import { validateProjectSvg, svgToDataUrl } from "../svg";

describe("validateProjectSvg", () => {
  const validSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="40" fill="blue"/>
  </svg>`;

  it("should accept a valid SVG", () => {
    const result = validateProjectSvg(validSvg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).toBe(validSvg.trim());
    }
  });

  it("should accept SVG with common elements", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect x="10" y="10" width="80" height="80" fill="red"/>
      <path d="M10 10 L90 90" stroke="black"/>
      <text x="50" y="50">Hello</text>
    </svg>`;
    const result = validateProjectSvg(svg);
    expect(result.ok).toBe(true);
  });

  it("should reject empty input", () => {
    const result = validateProjectSvg("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("required");
    }
  });

  it("should reject null/undefined input", () => {
    const result = validateProjectSvg(null as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("required");
    }
  });

  it("should reject non-SVG content", () => {
    const result = validateProjectSvg("<html><body>Hello</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("valid SVG");
    }
  });

  it("should reject SVG with script tag", () => {
    const svgWithScript = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithScript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });

  it("should reject SVG with foreignObject", () => {
    const svgWithForeignObject = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="100" height="100">
        <div>Hello</div>
      </foreignObject>
    </svg>`;
    const result = validateProjectSvg(svgWithForeignObject);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });

  it("should reject SVG with onclick event handler", () => {
    const svgWithOnclick = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40" onclick="alert('xss')"/>
    </svg>`;
    const result = validateProjectSvg(svgWithOnclick);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });

  it("should reject SVG with onload event handler", () => {
    const svgWithOnload = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert('xss')">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithOnload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });

  it("should reject SVG with javascript: URL", () => {
    const svgWithJsUrl = `<svg xmlns="http://www.w3.org/2000/svg">
      <a xlink:href="javascript:alert('xss')">
        <circle cx="50" cy="50" r="40"/>
      </a>
    </svg>`;
    const result = validateProjectSvg(svgWithJsUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
  });

  it("should reject SVG with external href references", () => {
    const svgWithExternal = `<svg xmlns="http://www.w3.org/2000/svg">
      <image href="https://evil.com/image.svg"/>
    </svg>`;
    const result = validateProjectSvg(svgWithExternal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("external references");
    }
  });

  it("should reject SVG with external xlink:href references", () => {
    const svgWithXlink = `<svg xmlns="http://www.w3.org/2000/svg">
      <use xlink:href="https://evil.com/sprites.svg#icon"/>
    </svg>`;
    const result = validateProjectSvg(svgWithXlink);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("external references");
    }
  });

  it("should reject SVG with external url() in styles", () => {
    const svgWithUrlFunc = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect style="fill: url(https://evil.com/pattern)" width="100" height="100"/>
    </svg>`;
    const result = validateProjectSvg(svgWithUrlFunc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("external references");
    }
  });

  it("should reject oversized SVG", () => {
    const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg">
      <text>${"x".repeat(300 * 1024)}</text>
    </svg>`;
    const result = validateProjectSvg(largeSvg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too large");
    }
  });

  it("should accept internal url() references", () => {
    const svgWithInternalUrl = `<svg xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad1">
          <stop offset="0%" style="stop-color:rgb(255,255,0)"/>
        </linearGradient>
      </defs>
      <rect fill="url(#grad1)" width="100" height="100"/>
    </svg>`;
    const result = validateProjectSvg(svgWithInternalUrl);
    expect(result.ok).toBe(true);
  });

  it("should accept SVG with local href references", () => {
    const svgWithLocalHref = `<svg xmlns="http://www.w3.org/2000/svg">
      <defs>
        <symbol id="icon">
          <circle cx="50" cy="50" r="40"/>
        </symbol>
      </defs>
      <use href="#icon"/>
    </svg>`;
    const result = validateProjectSvg(svgWithLocalHref);
    expect(result.ok).toBe(true);
  });
});

describe("svgToDataUrl", () => {
  it("should convert SVG to data URL", () => {
    const svg = '<svg><circle cx="50" cy="50" r="40"/></svg>';
    const dataUrl = svgToDataUrl(svg);
    expect(dataUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(dataUrl).toContain("svg");
  });

  it("should properly encode special characters", () => {
    const svg = '<svg attr="value">text</svg>';
    const dataUrl = svgToDataUrl(svg);
    expect(dataUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(dataUrl).toContain("%22"); // encoded quotes
  });

  it("should handle empty SVG", () => {
    const dataUrl = svgToDataUrl("");
    expect(dataUrl).toBe("data:image/svg+xml,");
  });
});
