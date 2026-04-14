# Scene Node Schema

> **Developer reference.** This describes LumaBurn's internal scene graph data model.

---

## Overview

Every visual object on the canvas is represented as a **scene node** — a plain JavaScript object with a defined schema. All scene nodes are stored in `state.objects[]` as a recursive tree.

---

## Base Node Schema

All scene nodes share these fields:

```ts
interface SceneNode {
  // Identity
  id: string;            // UUID — unique, never changes after creation
  name: string;          // Human-readable label (shown in object list)
  type: string;          // Element type: "rect" | "circle" | "path" | "group" | "text" | "image" | "ellipse" | "line" | "polyline" | "polygon"

  // Transform (applied in this order: translate → rotate → scale)
  x: number;             // Translation X in mm
  y: number;             // Translation Y in mm
  scaleX: number;        // Horizontal scale factor (1 = 100%)
  scaleY: number;        // Vertical scale factor (1 = 100%)
  lockRatio: boolean;    // If true, scaleX/scaleY are kept equal during resize
  rotation: number;      // Rotation in degrees, around sourceBounds center

  // Source geometry
  markup: string;        // SVG string representation of the raw shape
  sourceBounds: SourceBounds;  // Bounding box of markup in local (unscaled) space

  // Operation assignment
  operationLayerId: string; // ID of assigned operation layer; "" = inherit from parent

  // Visual flags
  isHole: boolean;       // If true, acts as a boolean cut-out within its parent group

  // Editable primitives
  liveGeometry: LiveGeometry | null;  // Only present for primitives added via "Add Shape"

  // Children (groups only)
  children: SceneNode[];
}
```

---

## SourceBounds

```ts
interface SourceBounds {
  minX: number;     // Left edge of markup in local coordinates
  minY: number;     // Top edge of markup in local coordinates
  width: number;    // Width of markup in local coordinates
  height: number;   // Height of markup in local coordinates
  centerX: number;  // Horizontal center (minX + width/2)
  centerY: number;  // Vertical center (minY + height/2)
}
```

`sourceBounds` is used by the resize interaction to keep the center stable during scaling.

---

## LiveGeometry

Present only on nodes created via **Add Shape** (rectangle, circle, text). Enables direct numeric editing in the inspector.

```ts
// Rectangle
{ type: "rect"; width: number; height: number; rx: number }

// Circle
{ type: "circle" }

// Text
{ type: "text"; content: string }
```

---

## Operation Layer Schema

```ts
interface OperationLayer {
  id: string;
  name: string;
  mode: "line" | "score" | "fill";
  color: string;        // CSS color used for canvas rendering
  power: number;        // 0–100 (percentage of laserMax)
  feed: number;         // mm/min
  passes: number;       // Number of repetitions
  airAssist: boolean;
  enabled: boolean;
  lineStyle: "continuous" | "dashed";
  dashLength: number;   // mm (for dashed style)
  gapLength: number;    // mm (for dashed style)
}
```

---

## Transform Composition

The canvas renders nodes using `composeTransform(node)`:

```
translate(x, y) rotate(rotation, cx*sx, cy*sy) scale(scaleX, scaleY)
```

Where `cx`/`cy` come from `sourceBounds.centerX/centerY`.

This means:
- The rotation pivot is always the geometric center of the original shape
- Moving (`x/y`) happens before rotation and scaling in local space

---

## Key Invariants

1. **`operationLayerId === ""`** means inherit from the parent group. Only top-level nodes should have a non-empty ID in most workflows.
2. **`scaleX` and `scaleY` must both be > 0**. The UI clamps to a minimum of 0.001.
3. **`sourceBounds.centerX/Y` must be accurate** — incorrect values produce rotation off-center.
4. **`markup` must be valid SVG** — invalid markup produces silent render gaps.
5. **Groups have `markup === ""`** — only leaf nodes carry markup.

---

## Legacy `scale` Field

Older project files (pre-April 2026) may have a `scale` field instead of `scaleX`/`scaleY`. The `normalizeSceneNode()` function handles this automatically on project load:

```js
scaleX: Math.max(0.001, node.scaleX ?? node.scale ?? 1),
scaleY: Math.max(0.001, node.scaleY ?? node.scale ?? 1),
```
