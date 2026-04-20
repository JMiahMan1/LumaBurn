# LumaBurn - Current Application Status

## 2026-04-18 Hardware Bring-Up Update

Status: Active M2Nano / OMTech K40 controller bring-up in progress

What was confirmed:

- The installed board is an `M2Nano`, confirmed from the board photo in `~/Downloads/20260417_132535.jpg`.
- The controller enumerates as CH341 USB device `1a86:5512`.
- This specific board comes up in `0xCE (ok)` without authentication.
- The first local auth experiments were harmful on this unit and could latch the controller into `0xCF` until power-cycled.

What changed in the repo:

- Added a Python hardware test harness under `tools/m2nano_py/`.
- Corrected the local packet CRC to match MeerK40t's `onewire_crc_lookup()` behavior.
- Reworked the test harness away from standalone `I\n` init assumptions and toward MeerK40t-style buffered rapid packets.
- Added a simplified LumaBurn-branded burn/cut validation asset at `assets/lumaburn-test-icon.svg`, matching the app icon's rounded badge, center beam, bed/grid, and `LumaBurn` wordmark.
- Added `tools/m2nano_py/10_burn_test_icon.py` to generate a conservative two-pass K40 validation job from that badge artwork.
- Added explicit vector speed controls to the Python harness using the same `CV...1` speed-code formula used in `src/core/m2-protocol.cjs` and the same `I -> CV...1 -> N -> LT -> S1E` program-mode sequence already present in `src/drivers/m2nano.cjs`.
- Added anchored bed placement support for the icon burn runner, including a lower-left placement mode with bed-boundary validation for `300 x 200 mm` K40 work areas.
- Added a Python-side busy-state recovery path that sends gate-off, `FNSE-`, `IS2P`, and `IPP` before a live icon job when the controller starts in `0xEE`.
- Logged findings, sources, and live outcomes in `V9_CONTROLLER_AUDIT.md`.

Live controller results after the protocol rewrite:

- Revised no-auth rapid-move packets were accepted:
  - `IB079S1PF`
  - `IT079S1PF`
- Revised no-auth legacy gate-and-move packets were accepted:
  - `IDS1PF`
  - `IBdS1PF`
  - `ITdS1PF`
  - `IUS1PF`
- All of the above stayed `0xCE -> 0xCE` at the controller level.

Current open point:

- Controller protocol acceptance is now confirmed, but the first full bottom-left badge job with explicit vector speeds timed out during live streaming. The next step is to test engrave-only and cut-only passes separately and tighten long-job flow control.
- Controller protocol acceptance is now confirmed, but both the first full bottom-left badge job and a follow-up engrave-only run timed out during live streaming. The latest instrumented run showed the controller was already `0xEE` (`busy`) before the artwork stream began and stalled immediately after `AT1` / `I`, so the next step is to add a more explicit controller reset/clear path or adjust flow control around persistent busy state.

Reference sources used for the bring-up rewrite:

- MeerK40t `meerk40t/ch341/libusb.py`
- MeerK40t `meerk40t/lihuiyu/controller.py`
- MeerK40t `meerk40t/lihuiyu/driver.py`
- MeerK40t `meerk40t/lihuiyu/laserspeed.py`

Date: 2026-04-14
Location: /home/jeremiah/Summers Drive/Code/LumaBurn
Status: Active development - Bug fix pass complete (>83% Branch Coverage, 98 tests)

———

## Project Overview

LumaBurn is a sophisticated browser-based laser job editor for GRBL-style diode lasers. It provides a complete
workflow for importing vector artwork (SVG), arranging layers on a machine bed, applying material and machine
presets, previewing toolpaths, and exporting G-code with ESP3D device integration.

Target Machines: Longer Ray5, Ortur Laser Master 3, xTool D1 Pro, and other GRBL-compatible diode lasers.

———

## Current State

### ✅ Working Features

- SVG import with intelligent background rectangle filtering
- Multi-select layer workflow with drag placement
- Machine and material presets with sensible defaults
- Layer ordering, duplication, centering, delete, step-and-repeat arrays
- Operation types: line (cut), score, and hatch fill
- Air assist toggling (M8/M9) per layer and globally
- Framing path generation for job footprint verification
- Project save/load in JSON format
- Real-time toolpath preview with distance and runtime estimates
- Configurable G-code header and footer
- ESP3D-aware network discovery with smart subnet scanning
- Device file browser, command sending, upload, and live streaming
- Queue-based streaming with [ESP700] forwarding per G-code line
- Controller activity log with error reporting
- Cross-platform packaging (Linux, macOS, Windows)
- Add Rectangle / Circle / Text shapes to canvas ✅ (regression fixed Apr 2026)
- Shape selection, drag-to-move, corner-resize, rotate ✅
- Correct scaleX/scaleY propagation for all scene node creation paths ✅
- Robust Test Suite (98 tests, >83% Branch Coverage) ✅

### 🔄 In Progress: Full SVG-to-Node Conversion

Goal: Replace markup-based rendering with structured node tree for true editing capabilities.

What's been added:

- svg-converter.mjs - Complete SVG DOM → node tree converter
  - Supports: g, path, rect, circle, ellipse, line, polyline, polygon, use, text, image, symbol, gradients,
    patterns, clip paths, masks
  - Full transform matrix composition (translate, scale, rotate, skew, matrix)
  - Bidirectional: nodeTreeToSvgString() reconstructs SVG from node tree
- Integrated into app.js with feature flag USE_NODE_TREE_CONVERSION = false
- Added convertNodeToSceneNode() helper to convert node tree to app's scene node format
- Module exports configured for ESM

Architecture shift:

- Old: Scene nodes store raw markup strings → inject into SVG directly
- New: Scene nodes have structured shape data (type, d, x, y, width, height, etc.) → render by constructing SVG
  elements or drawing to canvas
- Enables: per-element editing, boolean operations, text-to-paths, transform inheritance fixes

———

## Technical Stack

- Frontend: Vanilla JavaScript (ES modules), HTML5 Canvas, SVG
- Backend: Node.js HTTP server (static serving, device proxy)
- Core Logic: lumaburn-core.mjs (geometry parsing, G-code generation, optimization)
- Build: Custom script (scripts/build-packages.mjs) for cross-platform bundles
- Testing: Node.js native test runner (node:test)
- Dev Tools (newly added):
  - ESLint + Prettier for code quality/formatting
  - TypeScript for type checking (configured, not yet enforced)
  - Jest installed (currently unused, project uses node:test)

———

## File Structure

lumaburn/
├── app.js # UI layer, state, rendering (3367 lines)
├── lumaburn-core.mjs # Core algorithms (904 lines)
├── server.js # HTTP server + device proxy (431 lines)
├── svg-converter.mjs # NEW: SVG DOM → node tree converter (422 lines)
├── index.html # Entry point
├── styles.css # Styling (1022 lines)
├── package.json # Scripts, dependencies
├── PROJECT_STATUS.md # This file
├── test/
│ ├── core.test.mjs # Core logic tests (12 tests)
│ ├── package.test.mjs # Packaging tests
│ ├── svg-converter.test.mjs # NEW: converter tests (not yet passing)
│ └── fixtures/ # Sample .gc and .lbrn files
├── scripts/
│ └── build-packages.mjs
├── dist/ # Built packages (linux, macos, windows)
├── .eslintrc.js # ESLint configuration
├── .prettierrc # Prettier configuration
├── tsconfig.json # TypeScript configuration
└── jest.config.js # Jest configuration (unused)

———

## Testing Status

Command: npm test (uses node --test)

# tests 91

# suites 0

# pass 91

# fail 0

# duration_ms 1278.42

Branch Coverage: 82.93% (Surpassed 82% Milestone) ✅

Status: All existing tests pass ✅
Status: All tests pass (including new converter tests) ✅

———

## Key Architectural Decisions

### 1. Hybrid Conversion Approach

Instead of breaking backward compatibility, we added a feature flag USE_NODE_TREE_CONVERSION. The old markup-based
system remains fully functional while the new node tree system is developed and tested. This allows:

- Gradual rollout
- Easy regression testing
- Side-by-side comparison

### 2. Separate Converter Module

svg-converter.mjs is a standalone ES module that can be:

- Used in the browser during SVG import
- Tested independently with DOM mocking
- Reused in other contexts (e.g., command-line tools)

### 3. Node Tree Design

Node objects are lightweight data structures:

{
id, tagName, type, name,
attributes: { x, y, width, height, fill, stroke, ... },
transform: { matrix: {a,b,c,d,e,f}, transforms: [...] },
style: { fill, stroke, ... },
class,
children: [],
// Shape-specific: d (path), points (polygon), cx/cy/r (circle), etc.
}

### 4. Backward Compatibility

- convertNodeToSceneNode() generates markup strings using nodeTreeToSvgString() so the existing renderCanvasNode()
  works unchanged
- When the feature flag is enabled, loadSvgDocument() uses the new converter; otherwise falls back to
  filterImportGraphics() + createSceneNodeFromDom()

———

## Known Issues & Challenges

### 1. Test Fails for New Converter

test/svg-converter.test.mjs imports nodeTreeToSvgString but the module export syntax may be incorrect. Needs:

- Verify the function is exported
- Test file uses DOM methods (document.createElementNS) which may not be available in Node environment - needs
  mocking or browser environment

### 2. Transform Inheritance

The original system stored transforms per scene node as {x, y, scale, rotation} (simple). The new system uses full
2D transformation matrices. The convertNodeToSceneNode helper currently approximates scale/translation but may not
fully replicate matrix composition for nested transforms with rotation/skew. Needs thorough validation.

### 3. Rendering Performance

- Old system: injects raw markup strings → browser's SVG engine parses once
- New system: constructs SVG strings programmatically → may be slower for complex SVGs
- Need to benchmark and potentially cache generated markup

### 4. Pattern/Gradient Rendering

The converter parses gradients and patterns, but rendering them correctly in the canvas requires:

- <defs> section populated with gradient/pattern elements
- Proper fill="url(#id)" references
- Pattern userSpaceOnUse vs objectBoundingBox handled correctly

### 5. Text Rendering

Text nodes are kept as text elements. For laser engraving, text should ideally be converted to paths (requires
font loading and glyph outlining). This is a future enhancement.

———

## Development Roadmap

### Phase 1: Foundation (Current)

- [x] Create SVG converter module
- [x] Integrate with feature flag
- [x] Ensure existing tests still pass
- [x] Fix new converter tests
- [x] Enable USE_NODE_TREE_CONVERSION and validate visual rendering
- [x] Harden project branch coverage to >82% Milestone ✅

### Phase 2: Editing Capabilities

- [x] Break groups: explode grouped objects into selectable children (hierarchical ungroup implemented)
- [x] Add primitive shapes (Rect, Circle, Text) to the workspace
- [x] Context Menu: Integrate right-click context actions and global UI menu for editing nodes
- [x] Integrate standard selection logic so hierarchical SVG wrappers are highlighted rather than microscopic paths
- [x] Edit shape parameters: change rect dimensions, path points (basic)
- [x] Multiple Detailed Demo Vectors: Compare Cathedral, Cross, Seal
- [x] Core Menubar Navigation System

### Phase 3: Advanced Features

### Phase 4: TinkerDraft UX Overhaul

- [x] Implement Solid/Hole masking boolean hierarchy natively in the SVG representation.
- [x] Overhaul "Operation" logic to visually differentiate Solid vs Hole blocks via SVG attributes.
- [x] Perform non-destructive boolean logic under the `Luma-Group` paradigm securely tracking hidden data natively.
- [x] Develop smart bounding-box manipulating handles (Corner Scale, Top Rotate).
- [x] Code parametric UI sliders to mutate active standard geometries dynamically.

———

## How to Use

### Run the App

npm start

# Open http://localhost:4173

### Run Tests

npm test

### Lint & Format

npm run lint
npm run format

### Build Packages

npm run build

# Outputs to dist/LumaBurn-linux-x64, dist/LumaBurn-macos, dist/LumaBurn-windows

### Enable New Converter (Testing)

Edit app.js line ~30:

const USE_NODE_TREE_CONVERSION = true; // Switch to node tree conversion

———

## Configuration Reference

- Server port: PORT environment variable (default: 4173)
- Discovery timeout: DISCOVERY_TIMEOUT_MS = 1200 in server.js
- Discovery concurrency: DISCOVERY_CONCURRENCY = 48
- Smart scan limit: SMART_SCAN_LIMIT = 48
- Canvas gutter: CANVAS_GUTTER = { left: 40, right: 12, top: 38, bottom: 36 } in app.js

———

## Conclusion

The project is in a stable state with core features working. The SVG-to-Node conversion refactor is a foundational
change that will unlock advanced editing capabilities. The cautious, flag-driven approach ensures no regression
while allowing incremental development and testing.

Next immediate step: Resolve the test import issue and validate that enabling USE_NODE_TREE_CONVERSION produces
identical visual output to the old system for typical SVG imports.
