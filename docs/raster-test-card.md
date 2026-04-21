# Raster Test Card `assets/raster-test-card.svg` is a reusable raster benchmark for LumaBurn and other laser workflows.

The SVG is intentionally kept visually minimal so text does not overflow panel bounds; the detailed explanation for each
test lives in this file instead of inside the card. It is designed to answer the questions people usually care about
when validating raster support: - Does the grayscale ramp transition smoothly or band badly? - Do fine vertical features
hold, merge, or disappear? - Is text still readable at mixed sizes and fonts? - Do inverse/light-on-dark details survive
dithering? - Does a filled area burn evenly? - Does an embedded raster image survive the full import -> preview -> burn
path? - Do circles and diagonals stay crisp? ## Panels - `Grayscale Ramp` Tests tonal mapping and dither smoothness. -
`Fine Line + Gap Sweep` Tests minimum reproducible line width and minimum recoverable white gap spacing. - `Text
Legibility` Tests serif, sans, mono, and inverse `LumaBurn` text. - `Dot Fill + Checkers` Tests fill consistency and
periodic pattern breakup. - `Embedded PNG Laser Icon` Tests whether a true embedded PNG `<image

> `node survives the full raster pipeline with stable tones and preserved glow, beam, and grid detail. -`Circular
> Detail` Tests edge smoothness, diagonals, and symmetric geometry. ## Recommended Use - Raster the card at 2-3
> speed/power combinations. - Keep image scaling fixed between runs. - Compare the same output regions across settings.

- If testing a new driver path, compare packet flow and physical output against a known-good baseline. ## Why This
  Card Is Useful It is more informative than a random photo because it combines technical calibration features with a
  true embedded PNG raster region inside an SVG wrapper. That makes it useful both for engineering verification and for
  demoing raster quality to other users.
  </image>
