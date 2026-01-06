import { describe, it, expect } from "vitest";
import { validateProjectSvg, svgToDataUrl, validateSvg } from "../svg";

describe("validateProjectSvg (sanitizeSvg)", () => {
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

  it("should sanitize SVG with script tag (return ok with modified)", () => {
    const svgWithScript = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithScript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("script");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with foreignObject (return ok with modified)", () => {
    const svgWithForeignObject = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="100" height="100">
        <div>Hello</div>
      </foreignObject>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithForeignObject);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("foreignObject");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with onclick event handler (return ok with modified)", () => {
    const svgWithOnclick = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40" onclick="alert('xss')"/>
    </svg>`;
    const result = validateProjectSvg(svgWithOnclick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("onclick");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with onload event handler (return ok with modified)", () => {
    const svgWithOnload = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert('xss')">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithOnload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("onload");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with javascript: URL (return ok with modified)", () => {
    const svgWithJsUrl = `<svg xmlns="http://www.w3.org/2000/svg">
      <a xlink:href="javascript:alert('xss')">
        <circle cx="50" cy="50" r="40"/>
      </a>
    </svg>`;
    const result = validateProjectSvg(svgWithJsUrl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("javascript:");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with external href references (return ok with modified)", () => {
    const svgWithExternal = `<svg xmlns="http://www.w3.org/2000/svg">
      <image href="https://evil.com/image.svg"/>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithExternal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("https://evil.com");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with external xlink:href references (return ok with modified)", () => {
    const svgWithXlink = `<svg xmlns="http://www.w3.org/2000/svg">
      <use xlink:href="https://evil.com/sprites.svg#icon"/>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithXlink);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("https://evil.com");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
    }
  });

  it("should sanitize SVG with external url() in styles (return ok with modified)", () => {
    const svgWithUrlFunc = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect style="fill: url(https://evil.com/pattern)" width="100" height="100"/>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateProjectSvg(svgWithUrlFunc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain("https://evil.com");
      expect(result.svg).toContain("circle");
      expect(result.modified).toBe(true);
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

  it("should accept internal url() references without modification", () => {
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
    if (result.ok) {
      expect(result.modified).toBe(false);
    }
  });

  it("should accept SVG with local href references without modification", () => {
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
    if (result.ok) {
      expect(result.modified).toBe(false);
    }
  });
});

describe("validateSvg (strict validation)", () => {
  it("should return ok for clean SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateSvg(svg);
    expect(result.ok).toBe(true);
  });

  it("should return error for SVG with dangerous content", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <circle cx="50" cy="50" r="40"/>
    </svg>`;
    const result = validateSvg(svg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
    }
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
