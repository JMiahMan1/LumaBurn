# Changelog

All notable changes to LumaBurn are documented here.

---

## [Unreleased] — April 2026

### Fixed
- **Critical: Rectangle / Circle / Text shapes not appearing** — `addBasicShape()` was calling `convertNodeToSceneNode()` with 8 arguments while the function only accepts 3. `operationLayerId` silently received `null` and `artworkBounds` received `0`. Shapes were created without an operation assignment and with broken bounds. Fixed the call site to pass the correct 3 arguments.
- **Scale regression in scene node creation** — `convertNodeToSceneNode()` returned a `scale` field instead of `scaleX`/`scaleY`. This caused resize, selection handles, and `objectWorldBounds` to behave incorrectly for nodes created from the SVG node-tree pipeline.
- **SVG import root node scale** — `loadSvgDocument()` created its root group with `scale: baseScale` (legacy single-axis). Updated to emit `scaleX`, `scaleY`, and `lockRatio: true`.
- **`createImportedSceneNodeFromMarkup` scale field** — Propagated the caller's `scaleX`/`scaleY` correctly instead of copying the legacy `scale` property verbatim.

### Added
- **Argument guard in `convertNodeToSceneNode`** — Throws clearly in development if called with more than 3 arguments (with console warning in production). Prevents silent data corruption from future caller mismatches.
- **Node schema contract tests** (`svg-converter.test.mjs`) — 4 new tests verify that every node from `convertSvgToNodes()` has correctly typed fields (`type: string`, numeric geometry, array children, object transform with a `matrix`). Future changes to `svg-converter.mjs` that break the schema will fail immediately.
- **`composeTransform` regression tests** (`math.test.mjs`) — Verifies that nodes using `scale` (legacy) and `scaleX/scaleY` (current) produce expected transform strings.
- **`objectWorldBounds` regression tests** (`math.test.mjs`) — Verifies independent X/Y scaling and backward compatibility with the legacy `scale` field.
- **Documentation portal** (`/docs/`) with 8 new pages:
  - `index.md` — Navigation hub
  - `quick-start.md` — 5-step guide from import to first burn
  - `workspace.md` — Full UI map
  - `svg-import.md` — Supported elements, filtering, and tips
  - `operations.md` — Layer modes, assignment, and ordering
  - `machine-setup.md` — Presets, profiles, G-code header/footer
  - `device-connection.md` — Discovery, streaming, and job control
  - `shortcuts.md` — All keyboard shortcuts
  - `troubleshooting.md` — Common problems and fixes
  - `scene-node-schema.md` — Internal data model for developers

### Test Coverage
- Tests: **91 → 98** (+7 regression and contract tests)
- Branch coverage: **82.93% → 83.37%**

---

## Earlier

> Detailed history prior to April 2026 not yet captured in this log.
> See `git log` for full commit history.
