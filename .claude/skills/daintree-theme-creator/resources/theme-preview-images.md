# Theme Preview Images

Built-in theme preview images are ecosystem portraits, not screenshots or generic wallpapers. Each pair should make the theme's location, palette, atmosphere, and defining interaction principle legible before the user applies it.

## Goal

Create a beautiful, distinctive miniature world that feels almost photographic but remains subtly idealized. The shared house style is a premium ecological diorama photographed with a macro lens: tactile materials, controlled depth of field, softly modeled forms, a curated central anchor, and atmospheric peripheral detail.

The image must reinforce the theme rather than merely illustrate its name. Use the theme's dominant surface family for most of the frame and reserve brighter or more chromatic colors for the same load-bearing signals the UI emphasizes. The image is not recolored at runtime, so palette alignment must be authored into the image.

The hero and thumbnail must both work as product UI:

- The hero establishes place and atmosphere across an unusually wide banner.
- The thumbnail identifies the theme instantly at a rendered size of 40×40.
- The thumbnail must be a focused square crop of the original high-resolution hero generation, preserving the exact same scene, subject, palette, and lighting.
- The focal subject must be simple enough to remain legible at thumbnail size without making the hero feel like an icon on a background.

## Asset Contract

| Asset | Repository path | File dimensions | UI treatment |
| --- | --- | --- | --- |
| Hero | `public/themes/<theme-id>.webp` | 1272×400 (3.18:1) | Displayed in a 200px-high `object-cover` region with a bottom caption scrim |
| Thumbnail | `public/themes/thumb/<theme-id>.webp` | 80×80 (1:1) | Rendered at 40×40 in `ThemeBrowser`, providing a 2× source for sharp displays |

These dimensions are repository invariants. Do not substitute a nearby ratio or commit a large source file under the final asset name.

## Art Direction

Use the existing files in `public/themes/` and `public/themes/thumb/` as direct style references. Inspect several, not just the nearest geographic analogue. Daintree, Galápagos, Namib, Arashiyama, and Redwoods are useful references for the recurring visual grammar: centered ecological anchor, layered depth, tactile foreground, softened distance, and realistic-but-not-quite-real rendering.

Aim for:

- A handcrafted miniature-diorama feel rather than straight documentary photography
- Macro or tilt-shift depth, with the subject crisp and the surrounding world gently softened
- Tactile, slightly rounded natural materials that read well after aggressive downscaling
- One clear focal anchor near the center, supported by quieter detail across the wide frame
- A polished 3D-render-meets-nature-photography finish without glossy plastic surfaces
- Beauty, restraint, and environmental atmosphere rather than spectacle
- A composition and silhouette that are original even when reference images guide style or lighting

Avoid:

- Pure documentary photography, generic concept art, flat landscape photography, or obvious stock-photo composition
- Multiple competing bright areas, decorative accent scatter, broad global illumination, or saturated neon
- Fantasy crystals, unexplained bioluminescence, sci-fi lighting, horror imagery, slime, anatomical textures, or creature-like mineral forms
- Visible people, equipment, text, labels, logos, borders, watermarks, or UI elements unless the brief explicitly requires them
- Visible fauna by default; small animals and insects become creepy or unreadable at thumbnail scale, so treat them as opt-in and obtain explicit approval before making them a focal element
- Copying a supplied reference's exact silhouette, camera angle, landmark arrangement, or lighting layout

## Palette and Attention

Start from the theme's palette and interaction idea, not from a generic image of the location. Most pixels should live near the theme's surface colors; use highlights sparingly and deliberately.

For a low-chrome or low-contrast theme, keep roughly 80–90% of the image in the quiet surface family. A single illuminated subject, waterline, flower, tree, pool, or mineral feature can carry the accent or status color. This mirrors Daintree's accent restraint: one load-bearing signal is more effective than many colorful details.

The Movile theme is the canonical example. Its UI reserves strong contrast for an agent waiting on the user and for errors, so its image uses profound near-black surroundings and one small ivory/sulfur-lit central formation. The beam is a visual metaphor for attention, not a reason to illuminate the entire cave.

## Scientific and Geographic Grounding

Research the real ecosystem before prompting. Establish the location's geology, water, vegetation, light conditions, distinctive forms, and any defining ecological mechanism. Prefer primary research or authoritative institutional sources when a claim materially affects the scene.

The result may be hyper-beautiful and stylized, but it should not accidentally replace the location's defining truth with a generic biome trope. Distinguish among:

- Documented features that should be represented faithfully
- Geologically or ecologically plausible forms that may be invented for composition
- Deliberate visual metaphors that should be named and made as plausible as possible

If a metaphor conflicts with literal conditions, preserve the core truth and give the metaphor a plausible interpretation. Movile has no natural sunlight and is accessed through an artificial shaft, so a narrow beam should read as controlled survey light rather than daylight. Its dark limestone, partially flooded galleries, black water, and warm sulfur-associated palette are grounded; a sculptural calcite centerpiece is plausible but not a documented landmark.

## Reference Images

Assign every input image a role in the prompt:

- **House-style reference:** Existing Daintree hero images establish diorama rendering, depth, polish, and composition.
- **Location reference:** Real photographs establish geology and spatial character but should not dictate exposure or documentary style.
- **User preference reference:** User-selected generations establish the qualities to retain, such as a central silhouette, warm reflection, or negative space.
- **Crop source:** The selected high-resolution hero source is the canonical input for the large square thumbnail crop.

Use references for visual grammar, not replication. Explicitly state what to preserve and what must be new. If two supplied files appear identical, compare their hashes or pixels and avoid double-weighting the same reference.

## Hero Workflow

1. Read the issue and theme palette, then state the image's visual rule in one sentence. Examples: “one warm tree in a quiet savanna” or “one illuminated mineral form in near-total darkness.”
2. Inspect the current hero and thumbnail assets, including their dimensions and enlarged thumbnail crops.
3. Select a small reference set covering house style, location facts, palette, and any user-approved composition.
4. Generate two or three genuinely different hero concepts. Issue one generation per concept with a distinct subject or composition; do not ask one batch to produce unrelated assets.
5. Keep candidate files versioned (`<theme-id>-v1.webp`, `<theme-id>-v2.webp`) until the user selects a winner. Do not overwrite or delete candidates without authorization.
6. Convert each selected high-resolution output to the exact hero contract with a centered cover crop:

```bash
magick source.png -resize '1272x400^' -gravity center -extent 1272x400 -strip -quality 82 public/themes/<theme-id>.webp
```

7. Inspect the final 1272×400 file, not only the generator output. Confirm that the crop preserves the focal subject, leaves useful side detail, and does not place critical information solely beneath the bottom caption scrim.

Image generators often approximate requested ratios. Always normalize the final file deterministically; never stretch the source to 1272×400.

## Thumbnail Workflow

Do not regenerate the scene for the thumbnail, stretch the panorama into a square, or derive the thumbnail from the compressed 1272×400 hero. Use the original high-resolution hero generation and focus its central area.

After the user selects the hero:

1. Keep the original high-resolution hero generation available.
2. Find the shorter source dimension and crop a square of that size around the hero's central focal subject. Start with centered gravity, then adjust the crop offset only when the subject is intentionally off-center.
3. Save and inspect this large square crop before downscaling. It must preserve the exact hero artwork, fill the square naturally, keep enough environmental context, and contain no stretching or regenerated detail.
4. Confirm the focal subject occupies enough of the square to remain distinct at the actual 40×40 rendered size. The subject will commonly occupy roughly 45–70% of the square width, depending on its silhouette.
5. Proportionally downscale the approved large square to the final 80×80 WebP.

For a 2086×754 source, the deterministic sequence is:

```bash
magick source.png -gravity center -crop 754x754+0+0 +repage square-source.png
magick square-source.png -resize 80x80 -strip -quality 88 public/themes/thumb/<theme-id>.webp
```

Replace `754` with the actual shorter edge of the selected source. The large square crop is an intermediate source and does not need to be committed unless the repository later adopts a source-art convention.

## Prompt Template

Use the available image-generation system with a structured prompt. Adapt the details to the theme rather than copying this template verbatim.

```text
Use case: stylized-concept
Asset type: Daintree built-in theme hero with a center-focused square-crop thumbnail
Input images: identify each image as house-style, location, user-preference, or edit-target reference
Primary request: describe the ecosystem and the theme's single visual rule
Scene/backdrop: describe the real environment and what recedes into quiet detail
Subject: define one central natural anchor with a simple silhouette
Style/medium: premium handcrafted ecological diorama, near-photoreal stylized 3D render, macro or tilt-shift nature photography
Composition/framing: full-bleed 3.18:1 hero; centered anchor that remains strong in a square crop of the original source; balanced side detail; no letterboxing
Lighting/mood: tie the light distribution to the theme's attention hierarchy
Color palette: dominant surface family, restrained focal highlight, minimal secondary accent
Materials/textures: tactile location-specific materials that survive downscaling
Constraints: preserve scientific and geographic invariants; no people, text, logos, watermark, or unrequested visible fauna
Avoid: documentary flatness, copied composition, competing highlights, fantasy lighting, horror, slime, creature-like forms, and theme-inconsistent colors
```

Compose the hero with the later square crop in mind. The high-resolution source must contain a strong central square region; do not depend on image regeneration to repair an unsuitable thumbnail composition.

## Review Gates

Before promoting an image pair, verify:

- Hero is exactly 1272×400 WebP
- Thumbnail is exactly 80×80 WebP and was downscaled from a large square crop of the original high-resolution hero generation, not the compressed hero
- Hero and thumbnail preserve the exact same artwork and focal subject
- Thumbnail reads at 40×40 without relying on fine detail
- Hero crop works in the 200px-high picker and keeps important content clear of the caption scrim
- Overall palette matches the theme without runtime recoloring
- One focal signal dominates; secondary accents remain subordinate
- Art matches the existing realistic-but-stylized miniature-diorama family
- Scene remains beautiful and inviting rather than creepy, slimy, grotesque, or horror-coded
- No accidental animals, faces, eyes, text, logos, watermarks, or malformed details
- Real-location claims are grounded, and any metaphorical departure is understood rather than accidental
- Reference images influenced style and structure without being copied
- Candidate files are removed only after the winner is approved; the final pair uses unversioned filenames

Verify dimensions and file type mechanically:

```bash
identify public/themes/<theme-id>.webp public/themes/thumb/<theme-id>.webp
```

Then inspect both files visually. Enlarge the 80×80 asset for artifact review, but also judge it at its actual 40×40 rendered size.

## Common Failure Modes

- **Too photographic:** The scene looks like documentary cave or landscape photography. Reinforce miniature scale, tactile sculpting, macro depth, curated forms, and subtle idealization.
- **Too fantastical:** Neon, crystals, glowing organisms, or impossible lighting replace the real ecosystem. Restate the scientific invariants and use restrained natural materials.
- **Too creepy:** Small creatures, eggs, tendrils, microbial membranes, fungi, and wet organic textures become horror-coded. Remove visible fauna and communicate life through water, condensation, mineral seams, environmental motion, or lushness where geographically appropriate.
- **Too bright:** A broad light source reveals the entire environment and destroys the theme's attention hierarchy. Limit illumination spatially and quantify the quiet-to-bright balance in the prompt.
- **Too many focal points:** Several bright objects compete at both hero and thumbnail sizes. Reduce the scene to one central anchor.
- **Thumbnail is stretched or reinvented:** Squashing the panorama or regenerating a square changes the scene identity. Crop a large square directly from the original high-resolution hero, then downscale proportionally.
- **Thumbnail subject is tiny:** Return to the original source and use a tighter square crop centered on the anchor, while retaining enough context to preserve the scene.
- **Reference copied too closely:** Change silhouette, camera angle, geometry, or subject arrangement while retaining only the approved art-direction qualities.
- **Generator ratio is approximate:** Normalize with a cover resize and centered extent; never distort the output.
- **Candidate clutter remains:** Promote the approved image to `<theme-id>.webp`, create its final square crop and thumbnail, and remove versioned candidates only when the user authorizes cleanup.
