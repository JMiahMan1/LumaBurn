# SVG Import

LumaBurn imports SVG files and converts them into scene nodes for editing and G-code export.

---

## What LumaBurn Imports

| SVG Element                  | Support      | Notes                                                        |
| ---------------------------- | ------------ | ------------------------------------------------------------ |
| `<path>`                     | ✅ Full      | All path commands                                            |
| `<rect>`                     | ✅ Full      | Including `rx/ry` corner radius                              |
| `<circle>`                   | ✅ Full      |                                                              |
| `<ellipse>`                  | ✅ Full      |                                                              |
| `<line>`                     | ✅ Full      |                                                              |
| `<polyline>`                 | ✅ Full      |                                                              |
| `<polygon>`                  | ✅ Full      |                                                              |
| `<g>` (group)                | ✅ Full      | Preserves hierarchy and transforms                           |
| `<use>`                      | ✅ Resolved  | Referenced elements are inlined                              |
| `<text>`                     | ✅ Content   | Text is captured as a label; path conversion via opentype.js |
| `<image>`                    | ✅ Raster    | PNG/JPG embedded as data URIs                                |
| `<defs>`, `<linearGradient>` | ⚠️ Preserved | Referenced in markup, not edited                             |
| `<clipPath>`, `<mask>`       | ⚠️ Skipped   | Not currently applied in render                              |
| `<foreignObject>`            | ❌ Skipped   | HTML content not supported                                   |

---

## Automatic Filtering

LumaBurn applies smart filtering to avoid importing design artifacts:

### Background Rectangle Removal

A `<rect>` that covers the entire document viewBox (within 1% tolerance) is treated as a page background and silently removed. This prevents white rectangles from appearing as cuts.

### Invisible Element Filtering

Elements are skipped if:

- `opacity` or `fill-opacity` is less than 0.001
- `fill` is `none` AND `stroke` is `none`

### Empty Group Collapse

Groups with zero visible children after filtering are removed rather than creating empty containers.

---

## Single SVG Import

**`File → Import Artwork…`** → select one `.svg` file.

LumaBurn:

1. Parses the SVG document using the browser's native DOM parser
2. Runs the node-tree converter (`svg-converter.mjs`) to build a typed node tree
3. Filters out background and invisible elements
4. Scales the artwork to fit ~72% of the bed area
5. Centers the result on the bed
6. Wraps all children in a single root group node

---

## Batch SVG Import

Select **multiple `.svg` files** at once. LumaBurn:

1. Arranges all SVGs in a grid (columns = ⌈√n⌉)
2. Scales all SVGs uniformly (based on the largest one)
3. Adds padding between cells

This is ideal for imports like sets of cut outlines or repeated labels.

---

## Additive Import

Importing new files does **not clear** the canvas. Each import adds to the existing workspace. This lets you layer multiple SVG sources before generating G-code.

---

## Supported Transform Attributes

LumaBurn resolves all standard SVG transform functions:

- `translate(x, y)`
- `scale(sx, sy)`
- `rotate(angle, cx, cy)`
- `skewX(angle)` / `skewY(angle)`
- `matrix(a, b, c, d, e, f)`
- Combinations: `translate(10 5) scale(2) rotate(45)`

---

## Tips for Best Results

1. **Flatten transforms** before exporting from Inkscape/Illustrator — complex nested transforms can occasionally produce unexpected positioning.
2. **Use `stroke` not `fill`** for cut paths — LumaBurn's laser uses the stroke (outline), not the fill, for cut paths.
3. **Remove invisible elements** — Hidden layers or `display:none` objects still bloat file size but are filtered on import.
4. **Export with viewBox** — Always include a `viewBox` attribute when saving SVGs. Without it, LumaBurn falls back to `width`/`height` attributes.
5. **Avoid very deep nesting** — Groups more than 5 levels deep may slow down the scene graph. Flatten them in your SVG editor.

---

## Troubleshooting Import Issues

See [Troubleshooting → Shapes Not Appearing](./troubleshooting.md#shapes-not-appearing-after-svg-import).
