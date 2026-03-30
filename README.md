# LumaBurn

LumaBurn is a browser-based laser job editor aimed at the same workflow category as LightBurn: import vector artwork, arrange layers on a machine bed, apply material and machine presets, preview job paths, and export GRBL-style G-code.

## Current Feature Set

- SVG import into editable top-level laser layers
- Multi-select layer workflow with drag placement and inspector editing
- Machine presets including Longer Ray5 20W defaults
- Material presets for common cut, score, and engrave operations
- Layer ordering controls, duplication, centering, delete, and step-and-repeat arrays
- Line, score, and hatch-fill operations
- Layer and machine air-assist toggles with `M8` / `M9` output
- Framing path export for checking the job footprint on the machine
- Project save and load in JSON format
- Toolpath preview, distance estimates, and runtime estimation
- Configurable G-code header and footer
- ESP3D-aware network discovery across detected local/private subnets
- Device proxy for file listing, command sending, upload, and basic live job streaming
- Saved machine and device profiles in browser storage
- Queue-based streaming that uses ESP3D `[ESP500]` forwarding per G-code line
- Run and delete actions for files listed from the ESP3D storage view
- Visible controller activity log with explicit error reporting and fallback stream handling
- Smart discovery candidates derived from detected interfaces plus adjacent/private subnet hints
- Node-based unit tests and cross-platform package output directories for Linux, macOS, and Windows

## Run It

Install-free local run:

```bash
cd "LumaBurn"
npm start
```

Open `http://localhost:4173`.

## Engineering Scripts

```bash
npm test
npm run build
```

- `npm test` runs the Node unit tests.
- `npm run build` creates package directories in `dist/` for Linux, macOS, and Windows.

## Machine Target

The default profile is tuned for a GRBL-style diode laser workflow and is a reasonable baseline for the Longer Ray5 20W. You should still validate:

- Your machine origin convention
- The controller's expected `S` range
- Air assist command support
- Safe travel behavior if you use a Z axis
- Whether your ESP3D upload endpoint accepts the default multipart upload field names

## Current Gaps Versus LightBurn

This is now a much stronger laser editor, but it is still not a full commercial-grade replacement. Major missing areas are:

- Serial machine control and live streaming
- Camera alignment and print-and-cut workflows
- Bitmap import, dithering, and true raster scan engraving
- Node editing, boolean geometry tools, and text authoring
- Tabs, lead-ins, kerf compensation, and advanced cut planning
- True low-level serial feedback parsing from the controller stream instead of HTTP-level queued forwarding
