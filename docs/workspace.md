# Workspace Overview

LumaBurn's interface is organized into four main zones.

---

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  Menu Bar: File · Edit · View                           │
├──────────────┬──────────────────────────┬───────────────┤
│              │  Workspace Toolbar        │               │
│  Left        ├──────────────────────────┤  Right        │
│  Sidebar     │                          │  Sidebar      │
│              │      Canvas              │               │
│  Machine     │      (SVG editor)        │  Device /     │
│  Arrange     │                          │  Assign /     │
│  Add Shape   │                          │  Edit /       │
│              │                          │  Stats        │
├──────────────┼──────────────────────────┤               │
│              │  G-code / Output Preview │               │
└──────────────┴──────────────────────────┴───────────────┘
```

---

## Menu Bar

| Menu     | Key Items                                                                       |
| -------- | ------------------------------------------------------------------------------- |
| **File** | Import Artwork, Load/Save Project, Export G-code, Generate Frame, Load Tutorial |
| **Edit** | Group, Ungroup, Flatten All Groups, Duplicate, Delete                           |
| **View** | Center Selection, Move to Home, Reset Workspace                                 |

---

## Left Sidebar

### Machine Setup

Configure your laser machine. See [Machine Setup](./machine-setup.md).

### Arrange

Layout tools: grid snap, step-and-repeat arrays, center/home buttons.

### Add Shape

Insert primitive shapes directly onto the canvas:

- **Rectangle** — 50×50mm rect, centered on the bed
- **Circle** — 50mm diameter circle, centered on the bed
- **Text** — "LumaBurn" text, editable in the Edit tab

---

## Canvas

The main editing area. The white rectangle represents your machine bed.

### Visual Cues

| Element             | Meaning                                 |
| ------------------- | --------------------------------------- |
| Orange/coral shapes | Assigned to Cut operation               |
| Green shapes        | Assigned to Score operation             |
| Blue shapes         | Assigned to Fill operation              |
| Dashed border       | Selected object                         |
| Corner circles      | Scale handles                           |
| Top circle          | Rotate handle                           |
| Grid                | 10mm minor, 50mm mid, 100mm major lines |
| Origin marker       | Machine home (0,0) position             |

### Workspace Toolbar (above canvas)

| Button               | Action                                    |
| -------------------- | ----------------------------------------- |
| **Select / Move**    | Activate selection mode (default)         |
| **Hide/Show Grid**   | Toggle the grid overlay                   |
| **Snap On/Off**      | Toggle grid snapping                      |
| **Center Selection** | Center selected objects on the bed        |
| **Home Selection**   | Move selection to machine origin area     |
| **Save Workspace**   | Persist current layout to browser storage |
| **Delete Saved**     | Clear the auto-saved workspace            |

---

## Right Sidebar

The right sidebar has four tabs:

### Device

Connect to your ESP3D laser controller. See [Device Connection](./device-connection.md).

### Assign

- **Operations** panel — view and assign laser operations to selected shapes
- **Objects** panel — tree view of all imported shapes with quick-assign color dots

### Edit

- **Inspector** — X, Y, Width, Height, Scale, Rotation for selected object
- **Operation Settings** — Mode, Color, Power, Speed, Passes for the assigned layer
- **Shape Property** — Live geometry editing for rects (width/height/corner radius) and text

### Stats

- Enabled layer count
- Cut distance estimate
- Travel distance estimate
- Estimated job runtime

---

## G-code Section (bottom of canvas)

- **Header / Footer** textareas — Customize your G-code preamble and teardown
- **Generated G-code** — Live preview of the output. Updates on every canvas change.

---

## Context Menu

Right-click any shape on the canvas for quick access to:

- Group / Ungroup / Flatten All
- Duplicate / Delete
- Assign to Cut / Score / Fill

---

## Project Status Indicator

The small chip next to the "LumaBurn" title shows **Saved** (green dot) when the workspace has been persisted to browser storage.
