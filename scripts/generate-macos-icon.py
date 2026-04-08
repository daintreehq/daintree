#!/usr/bin/env python3
"""Generate a macOS-compliant app icon with Apple superellipse mask and drop shadow.

Usage: python3 scripts/generate-macos-icon.py <source-1024x1024.png> [output.png]

The source image should be a full-bleed 1024x1024 PNG (square, no transparency needed).
This script applies:
  1. Apple's superellipse mask (n=5) at 824x824 centered on a 1024x1024 canvas
  2. Standard macOS drop shadow (directional + ambient)

The output is a 1024x1024 RGBA PNG ready for iconutil conversion to .icns.
"""

import sys
import numpy as np
from PIL import Image, ImageFilter

CANVAS = 1024
# Apple HIG: icon artwork is 824x824 centered on 1024x1024 canvas
ICON_SIZE = 824
PADDING = (CANVAS - ICON_SIZE) // 2  # 100px each side
SUPERELLIPSE_N = 5.0

# macOS drop shadow parameters (approximation of Apple's standard)
SHADOW_DIRECTIONAL = {"opacity": 0.30, "blur": 12, "offset_y": 12}
SHADOW_AMBIENT = {"opacity": 0.15, "blur": 4, "offset_y": 2}


def generate_superellipse_mask(size: int, icon_size: int, n: float) -> Image.Image:
    """Generate an Apple superellipse (squircle) mask."""
    center = size / 2
    a = icon_size / 2

    y_coords, x_coords = np.ogrid[:size, :size]
    # Superellipse formula: |x/a|^n + |y/a|^n <= 1
    dist = (np.abs(x_coords - center) / a) ** n + (np.abs(y_coords - center) / a) ** n

    # Anti-alias the edge: smooth transition over ~1.5px
    mask = np.clip(1.0 - (dist - 1.0) * a * 0.7, 0.0, 1.0)
    return Image.fromarray((mask * 255).astype(np.uint8), mode="L")


def add_shadow(
    img: Image.Image, opacity: float, blur: int, offset_y: int
) -> Image.Image:
    """Add a drop shadow layer behind the image."""
    # Extract alpha as shadow shape
    alpha = img.split()[3]

    # Create shadow from alpha
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    shadow_alpha = alpha.copy()

    # Apply opacity
    shadow_alpha = Image.fromarray(
        (np.array(shadow_alpha) * opacity).astype(np.uint8), mode="L"
    )

    # Apply blur
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(radius=blur))

    # Create shadow image
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    black = Image.new("RGB", img.size, (0, 0, 0))
    shadow = Image.merge("RGBA", (*black.split(), shadow_alpha))

    # Offset shadow
    offset_shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    offset_shadow.paste(shadow, (0, offset_y))

    # Composite: shadow behind image
    return Image.alpha_composite(offset_shadow, img)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <source-1024x1024.png> [output.png]")
        sys.exit(1)

    source_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "icon-masked.png"

    # Load and ensure 1024x1024
    source = Image.open(source_path).convert("RGBA")
    if source.size != (CANVAS, CANVAS):
        source = source.resize((CANVAS, CANVAS), Image.LANCZOS)

    # Generate superellipse mask
    mask = generate_superellipse_mask(CANVAS, ICON_SIZE, SUPERELLIPSE_N)

    # Apply mask to source
    masked = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    masked.paste(source, (0, 0), mask)

    # Add shadows (ambient first, then directional, so directional is more prominent)
    result = add_shadow(masked, **SHADOW_AMBIENT)
    result = add_shadow(result, **SHADOW_DIRECTIONAL)

    result.save(output_path, "PNG")
    print(f"Created macOS icon: {output_path} ({CANVAS}x{CANVAS})")


if __name__ == "__main__":
    main()
