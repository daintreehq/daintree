#!/bin/bash
# Icon Generation Script for Daintree
# Usage: ./scripts/generate-icons.sh <source-image.png>
#
# Requires:
# - Source image should be at least 1024x1024 PNG (full-bleed square)
# - Python 3 with Pillow and NumPy (pip3 install Pillow numpy)
# - macOS: iconutil (built-in)
# - Windows: ImageMagick (brew install imagemagick)
#
# This script generates platform-appropriate icons:
# - build/icon.icns  (macOS) — Apple superellipse mask + drop shadow baked in
# - build/icon.ico   (Windows) — rounded corners with transparency
# - build/icon.png   (Linux) — rounded corners with transparency, no shadow
#
# macOS Note: The .icns file must have the squircle shape, transparent corners,
# and drop shadow pre-baked. macOS does NOT auto-mask .icns files — only Assets.car
# (compiled via actool) gets auto-masked. The .icns is used for DMG volume icons,
# older macOS versions, and contexts where Assets.car isn't recognized.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_IMAGE="${1:-icon-source.png}"
BUILD_DIR="build"

if [ ! -f "$SOURCE_IMAGE" ]; then
    echo "Error: Source image not found: $SOURCE_IMAGE"
    echo "Usage: $0 <source-image.png>"
    exit 1
fi

mkdir -p "$BUILD_DIR"

echo "Generating icons from: $SOURCE_IMAGE"

# Check for required tools
if ! python3 -c "from PIL import Image; import numpy" 2>/dev/null; then
    echo "Error: Python 3 with Pillow and NumPy required."
    echo "Install with: pip3 install Pillow numpy"
    exit 1
fi

if ! command -v iconutil &> /dev/null; then
    echo "Warning: iconutil not found (macOS only). Skipping icns generation."
    SKIP_ICNS=true
fi

if ! command -v magick &> /dev/null && ! command -v convert &> /dev/null; then
    echo "Warning: ImageMagick not found. Skipping ico generation."
    echo "Install with: brew install imagemagick"
    SKIP_ICO=true
fi

# Determine ImageMagick command (v7 uses 'magick', v6 uses 'convert')
if command -v magick &> /dev/null; then
    MAGICK="magick"
else
    MAGICK="convert"
fi

# --- Linux icon (rounded corners, transparent, no shadow) ---
echo "Generating Linux icon with rounded corners..."
python3 -c "
from PIL import Image, ImageDraw
import numpy as np

src = Image.open('$SOURCE_IMAGE').convert('RGBA')
if src.size != (1024, 1024):
    src = src.resize((1024, 1024), Image.LANCZOS)

# Apply rounded rectangle mask (~18% radius for Fluent-style rounding)
size = 1024
radius = int(size * 0.18)  # ~184px

mask = Image.new('L', (size, size), 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=255)

# Anti-alias: render mask at 4x then downscale
mask_hires = Image.new('L', (size * 4, size * 4), 0)
draw_hires = ImageDraw.Draw(mask_hires)
draw_hires.rounded_rectangle([(0, 0), (size * 4 - 1, size * 4 - 1)], radius=radius * 4, fill=255)
mask = mask_hires.resize((size, size), Image.LANCZOS)

result = Image.new('RGBA', (size, size), (0, 0, 0, 0))
result.paste(src, (0, 0), mask)
result.save('$BUILD_DIR/icon.png', 'PNG')
print('  Created: $BUILD_DIR/icon.png (rounded, transparent)')
"

# --- macOS icon (.icns with superellipse mask + drop shadow) ---
if [ -z "$SKIP_ICNS" ]; then
    echo "Generating macOS icon with Apple superellipse mask..."

    # Step 1: Apply superellipse mask and drop shadow to source
    MASKED_ICON="$BUILD_DIR/.icon-masked-1024.png"
    python3 "$SCRIPT_DIR/generate-macos-icon.py" "$SOURCE_IMAGE" "$MASKED_ICON"

    # Step 2: Generate iconset from masked source
    ICONSET_DIR="$BUILD_DIR/icon.iconset"
    mkdir -p "$ICONSET_DIR"

    # Generate all required sizes from the masked 1024x1024
    python3 -c "
from PIL import Image
import os

src = Image.open('$MASKED_ICON').convert('RGBA')
iconset = '$ICONSET_DIR'

sizes = [
    ('icon_16x16.png', 16),
    ('icon_16x16@2x.png', 32),
    ('icon_32x32.png', 32),
    ('icon_32x32@2x.png', 64),
    ('icon_128x128.png', 128),
    ('icon_128x128@2x.png', 256),
    ('icon_256x256.png', 256),
    ('icon_256x256@2x.png', 512),
    ('icon_512x512.png', 512),
    ('icon_512x512@2x.png', 1024),
]

for name, size in sizes:
    resized = src.resize((size, size), Image.LANCZOS)
    resized.save(os.path.join(iconset, name), 'PNG')

print('  Generated iconset with', len(sizes), 'sizes')
"

    # Step 3: Compile .icns
    iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
    rm -rf "$ICONSET_DIR"
    rm -f "$MASKED_ICON"
    echo "  Created: $BUILD_DIR/icon.icns"
fi

# --- Windows icon (.ico, rounded corners with transparency) ---
# Windows 11 Fluent Design prefers floating/rounded icons over full-bleed squares.
# We apply the same rounded rectangle as Linux, then pack into .ico.
if [ -z "$SKIP_ICO" ]; then
    echo "Generating Windows icon with rounded corners..."

    # Generate a rounded 256x256 PNG first (largest .ico layer uses PNG compression)
    python3 -c "
from PIL import Image, ImageDraw
import os

src = Image.open('$SOURCE_IMAGE').convert('RGBA')

sizes = [256, 128, 64, 48, 32, 24, 16]
ico_frames = []

for size in sizes:
    resized = src.resize((size, size), Image.LANCZOS)

    # Apply rounded rectangle mask (~18% radius)
    radius = max(int(size * 0.18), 2)

    # Anti-alias: render mask at 4x then downscale
    scale = min(4, max(1, 256 // size))
    mask_size = size * scale
    mask_hires = Image.new('L', (mask_size, mask_size), 0)
    draw = ImageDraw.Draw(mask_hires)
    draw.rounded_rectangle([(0, 0), (mask_size - 1, mask_size - 1)], radius=radius * scale, fill=255)
    mask = mask_hires.resize((size, size), Image.LANCZOS)

    result = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    result.paste(resized, (0, 0), mask)
    ico_frames.append(result)

# Save as .ico with all sizes
ico_frames[0].save(
    '$BUILD_DIR/icon.ico',
    format='ICO',
    sizes=[(f.width, f.height) for f in ico_frames],
    append_images=ico_frames[1:]
)
print('  Created: $BUILD_DIR/icon.ico (rounded, transparent)')
"
fi

echo ""
echo "Icon generation complete!"
echo "Files created in $BUILD_DIR/:"
ls -la "$BUILD_DIR/"*.{icns,ico,png} 2>/dev/null || true
