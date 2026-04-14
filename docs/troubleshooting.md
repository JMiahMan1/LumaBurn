# Troubleshooting

Common problems and how to fix them.

---

## Shapes Not Appearing After SVG Import

**Symptom**: You import an SVG but the canvas remains empty or shows "No supported graphic elements found."

**Causes & Fixes**:

1. **All elements have `display:none` or `opacity:0`** — LumaBurn filters invisible elements. Make all paths visible in your SVG editor before exporting.
2. **Everything is inside a background rect** — LumaBurn automatically removes white/transparent rects that match the document size. If all your design was _inside_ such a rect as a clipping group, it may be filtered. Flatten the structure in Inkscape/Illustrator before importing.
3. **SVG uses unsupported features** — Embedded HTML `<foreignObject>` or non-standard namespaces are skipped. Use standard SVG paths and shapes.

---

## "No Burn Geometry Found" Error (G-code Import)

**Symptom**: Importing a `.gcode` file returns this error.

**Fix**: The file must contain linear moves (`G0`/`G1`) with S-values or laser-mode commands. A file with only `M3`/`M5` and no moves produces no polylines.

---

## Canvas Shapes Have No Selection Handles

**Symptom**: You can see shapes on the canvas but clicking them does nothing.

**Cause**: The interaction mode may not be "Select".

**Fix**: Click the **Select / Move** button in the workspace toolbar, or press `Escape`.

---

## Inspector Shows No X/Y/Width/Height Values

**Symptom**: The Edit tab inspector fields are empty after clicking a shape.

**Cause**: The selected node has zero-size bounds (e.g. a single point path, or a group with no measureable children).

**Fix**: Select a leaf shape (a rect, circle, or path) rather than an empty group.

---

## Device Not Found on Scan

**Symptom**: Clicking "Scan Network" returns nothing.

**Causes & Fixes**:

1. **ESP3D is on a different subnet** — Enter the IP manually in the Controller URL field (e.g. `http://192.168.4.1`).
2. **Firewall blocking port 80** — Ensure your machine and computer are on the same local network with no firewall between them.
3. **ESP3D WebUI version mismatch** — LumaBurn probes `/files?action=list&path=/sd/`. If your ESP3D version uses a different API path, enter the controller URL manually.

---

## Job Streaming Stops Mid-Way

**Symptom**: The activity log shows some lines sent, then stops.

**Cause**: The controller returned an `error:` or `ALARM:` response.

**Fix**:

1. Click **Unlock** (`$X`) in the Device panel to clear GRBL's alarm state.
2. Click **Home** (`$H`) if your machine requires homing.
3. Check the **Recent Activity** log for the specific error code.

---

## G-code Preview is Empty

**Symptom**: The G-code preview textarea shows nothing.

**Causes**:

1. No enabled operation layers (all are toggled off) — click **Toggle All** in the Assign tab.
2. No objects on the canvas.
3. Objects are assigned to a layer with 0 power or 0 speed — check the Edit tab.

---

## Safety Reminder

> **Always wear appropriate laser safety eyewear** for your laser's wavelength (450nm for most blue diode lasers). Never leave a running laser unattended.
