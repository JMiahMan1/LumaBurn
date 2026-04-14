# Operations & Layers

Operations define how the laser treats each shape — whether it cuts, scores, or engraves. Each shape on the canvas is assigned to exactly one operation layer.

---

## The Three Operation Modes

| Mode | G-code Effect | Typical Use |
|---|---|---|
| **Line (Cut)** | Follows stroke path at full speed/power | Cutting through wood, acrylic |
| **Score** | Follows stroke path at reduced power | Marking, folding lines, fine detail |
| **Fill (Engrave)** | Horizontal raster scan across filled area | Engraving, logos, photos |

---

## Default Operation Layers

LumaBurn starts with three preconfigured layers:

| Name | Color | Mode | Power | Speed |
|---|---|---|---|---|
| Cut 1 | 🟠 Orange | Line | 70% | 1800 mm/min |
| Score 1 | 🟢 Green | Score | 35% | 1800 mm/min |
| Fill 1 | 🔵 Blue | Fill | 40% | 2200 mm/min |

---

## Assigning Objects to Operations

1. Click the **Assign** tab on the right sidebar
2. Select one or more shapes on the canvas (they'll highlight)
3. Click an operation layer in the list — shapes snap to that layer's color

**Alternative methods:**
- Right-click canvas → Assign Operation → Cut / Score / Fill
- In the Objects list, click the colored dots next to any object row

---

## Editing an Operation's Settings

1. Click the **Edit** tab on the right sidebar
2. Select an object assigned to the operation, or click the operation layer in the Assign tab
3. The **Operation Settings** block shows:

| Field | Description |
|---|---|
| **Mode** | Line / Fill / Score |
| **Color** | Visual identifier for the layer |
| **Power (%)** | Laser power as a percentage of max S-value |
| **Speed (mm/min)** | Feed rate during burn moves |
| **Passes** | How many times to repeat the operation |

---

## Layer Order

The order in the **Operations** list determines burn order — **top layers fire first**. Conventionally:
- Put engrave/fill layers **first** (before cutting out the piece)
- Put cut layers **last** (so the piece doesn't shift before engraving is done)

Use **Move Up** / **Move Down** buttons to reorder.

---

## Enabling & Disabling Layers

Click **Toggle All** to cycle all layers between enabled and disabled. To toggle individual layers, click a layer item when no objects are selected.

Disabled layers:
- Are excluded from G-code generation
- Still show in the object list with a muted appearance
- Do not count toward job time estimates

---

## Adding & Removing Operations

- **Add Op** — Creates a new operation with a random color and default settings
- To remove an operation, all objects must first be reassigned. Then delete via future "Delete Op" feature (roadmap)

---

## Air Assist Per Layer

Each operation can enable air assist (`M8`/`M9` commands). Set this in **Machine Setup → Use Air Assist Commands** globally, or per operation via the Edit tab (when supported by the material preset).
