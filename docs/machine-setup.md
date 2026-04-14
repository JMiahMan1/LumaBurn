# Machine Setup

Configure LumaBurn to match your laser machine's capabilities and behavior.

---

## Machine Presets

LumaBurn ships with presets for common diode lasers:

| Preset | Bed Size | Travel Speed | Laser Max S |
|---|---|---|---|
| Longer Ray5 20W | 400 × 400 mm | 4000 mm/min | 1000 |
| Ortur Laser Master 3 | 400 × 400 mm | 5000 mm/min | 1000 |
| xTool D1 Pro 20W | 430 × 390 mm | 4500 mm/min | 1000 |

Select a preset from **Machine Preset** in the left sidebar. All fields update automatically.

> **Note**: Presets are starting points. Verify travel speed and S-value limits against your machine's actual firmware settings.

---

## Machine Fields

| Field | Description |
|---|---|
| **Bed Width / Height (mm)** | Physical work area of your machine |
| **Travel Speed (mm/min)** | Speed of non-cutting rapids (`G0` moves) |
| **Frame Feed (mm/min)** | Speed used when streaming the framing path |
| **Laser Max S** | Maximum S-value the controller accepts (typically 1000) |
| **Sample Step (mm)** | Arc interpolation resolution for curved geometry |
| **Rapid Z Safe (mm)** | Z lift height for safe travel (0 = ignore Z axis) |
| **Origin** | `Lower Left` (most GRBL machines) or `Upper Left` |
| **Air Assist** | Enables `M8`/`M9` air assist commands globally |
| **Show Toolpath Preview** | Overlays computed toolpath on the canvas |
| **Snap Moves** | Enables grid snap during drag |
| **Grid Snap (mm)** | Snap granularity |

---

## Saving Machine Profiles

Once you've tuned settings for your machine:

1. Fill in all machine fields correctly
2. Click **Save Profile** in the Machine section
3. The profile appears in the **Saved Machine Profile** dropdown
4. Click **Set Default** to auto-load it on startup

---

## G-code Header & Footer

Customize the G-code preamble and teardown in the **G-code** section at the bottom of the workspace.

**Default header:**
```gcode
; LumaBurn G-code
$32=1 ; Ensure Laser Mode is active
G21   ; millimeters
G90   ; absolute positioning
M5    ; laser off
```

**Default footer:**
```gcode
M5
G0 X0 Y0
```

> **Important**: `$32=1` enables GRBL Laser Mode. Without it, the laser may not fire at the correct power level during moves. Most diode laser controllers require this.

---

## Material Presets

Apply a material preset to auto-fill power/speed for the selected operation layer:

| Preset | Mode | Power | Speed | Passes |
|---|---|---|---|---|
| No Material Preset | — | 65% | 1800 | 1 |
| 3mm Birch Cut | Line | 100% | 420 | 2 |
| 3mm Basswood Cut | Line | 95% | 500 | 2 |
| Black Acrylic Score | Score | 28% | 1500 | 1 |
| Leather Engrave | Fill | 35% | 2200 | 1 |

> Presets are starting points — test on scrap material first. Wood density, moisture, and coating all affect actual cut performance.

---

## Origin Convention

GRBL machines typically home to lower-left (X=0, Y=0 = front-left corner). LumaBurn's canvas matches this by default.

- **Lower Left**: Y increases from front to back. Most diode laser machines.
- **Upper Left**: Y increases from top to bottom. Some CO₂ and enclosed machines.

If your job cuts in the wrong location or is mirrored, check the origin setting first.
