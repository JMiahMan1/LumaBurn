# Raster Test Card

`assets/raster-test-card.svg` is a reusable raster benchmark for LumaBurn and other laser workflows.

It is designed to answer the questions people usually care about when validating raster support:

- Does the grayscale ramp transition smoothly or band badly?
- Do fine vertical features hold, merge, or disappear?
- Is text still readable at mixed sizes and fonts?
- Do inverse/light-on-dark details survive dithering?
- Does a filled area burn evenly?
- Does photo-like tone rendering break up or look natural?
- Do circles and diagonals stay crisp?

## Panels

- `Grayscale Ramp`
  Tests tonal mapping and dither smoothness.
- `Fine Line Sweep`
  Tests minimum reproducible feature width.
- `Text Legibility`
  Tests serif, sans, mono, and inverse `LumaBurn` text.
- `Dot Fill + Checkers`
  Tests fill consistency and periodic pattern breakup.
- `Photo-like Tone Area`
  Tests whether the raster pipeline can handle soft gradients and midtones.
- `Circular Detail`
  Tests edge smoothness, diagonals, and symmetric geometry.

## Recommended Use

- Raster the card at 2-3 speed/power combinations.
- Keep image scaling fixed between runs.
- Compare the same output regions across settings.
- If testing a new driver path, compare packet flow and physical output against a known-good baseline.

## Why This Card Is Useful

It is more informative than a random photo because it combines technical calibration features with a visually obvious tonal region. That makes it useful both for engineering verification and for demoing raster quality to other users.
