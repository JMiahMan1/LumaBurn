# Quick Start

Go from zero to a finished laser job in 5 steps.

---

## Prerequisites

- A laser machine with GRBL firmware (e.g. Longer Ray5, Ortur LM3, xTool D1 Pro)
- LumaBurn running locally (`npm start` → open `http://localhost:4173`)
- An SVG file of your design, or use the built-in demo

---

## Step 1 — Import Your Artwork

**`File → Import Artwork…`** and select your `.svg` file.

LumaBurn will:
- Parse the SVG and place all visible shapes on the canvas
- Automatically filter out background rectangles that match the document size
- Scale and center the artwork to fit your bed

> **Tip**: Multiple SVGs can be imported at once — LumaBurn arranges them in a grid automatically.

Don't have an SVG yet? Use **`File → Load Interactive Tutorial`** to load the built-in demo.

---

## Step 2 — Arrange Your Design

Click any shape to select it. A dashed orange border and corner handles appear.

| Action | How |
|---|---|
| Move | Click and drag the shape |
| Scale | Drag a corner handle |
| Rotate | Drag the circular handle above the selection |
| Multi-select | Shift-click or drag a marquee |
| Nudge | Arrow keys (1 mm), Shift+Arrow (10 mm) |

Use **Center Selection** or **Home Selection** from the View menu to snap artwork to the bed.

---

## Step 3 — Assign Operations

Click the **Assign** tab on the right sidebar.

Three default operations are pre-configured:

| Operation | Mode | Typical Use |
|---|---|---|
| **Cut 1** | Line | Cut all the way through material |
| **Score 1** | Score | Draw a fine line on the surface |
| **Fill 1** | Fill | Engrave/raster a solid area |

**To assign**: Select shapes on the canvas, then click an operation in the list. The shape takes that operation's color.

Fine-tune power and speed in the **Edit** tab → **Operation Settings**.

---

## Step 4 — Choose a Machine & Material Preset

In the **Machine** panel (left sidebar):

1. Pick your machine from **Machine Preset** (Longer Ray5 is the default)
2. Optionally pick a **Material Preset** (e.g. "3mm Birch Cut") — this auto-fills power/speed

> **Important**: Always verify the power and speed for your specific material and machine before running.

---

## Step 5 — Frame, Then Run

### Frame First (Strongly Recommended)
Click **Device → Stream Frame** to trace the job boundary with the laser off. Confirm the laser moves where you expect on your material.

### Run the Job
1. Enter your ESP3D controller URL in the **Device** tab (e.g. `http://192.168.1.50`)
2. Click **Scan Network** to auto-discover it
3. Click **Run Job** to stream G-code line-by-line to the device

---

## What's Next?

- [Workspace Overview](./workspace.md) — Learn every panel in detail
- [Operations & Layers](./operations.md) — Advanced layer ordering and tuning
- [Keyboard Shortcuts](./shortcuts.md) — Work faster with hotkeys
