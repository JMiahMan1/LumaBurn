import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRasterRows,
  generateRasterGcode,
  applyAtkinsonDither,
  rasterizeImageToLumas,
} from "../src/core/raster.mjs";

// Mock Canvas for Node/JSDOM environment without 'canvas' package
if (typeof global.document === "undefined") {
  global.document = {
    createElement: (tag) => {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: (type) => ({
            translate: () => {},
            rotate: () => {},
            scale: () => {},
            drawImage: () => {},
            getImageData: (x, y, w, h) => ({
              data: new Uint8ClampedArray(w * h * 4),
            }),
          }),
        };
      }
      return {};
    },
  };
}

test("rasterizeImageToLumas branch coverage", () => {
  const worldBounds = { x: 0, y: 0, width: 10, height: 10 };
  const sourceBounds = { centerX: 5, centerY: 5, width: 10, height: 10 };
  const transform = { rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };
  const result = rasterizeImageToLumas({}, sourceBounds, worldBounds, transform, 10);
  assert.ok(result.lumas instanceof Float32Array);
  assert.ok(result.width > 0);
});

test("applyAtkinsonDither correctly dithers a grayscale gradient", () => {
  const lumas = new Float32Array([200, 150, 100, 150, 100, 50, 100, 50, 0]);
  const width = 3;
  const height = 3;
  const result = applyAtkinsonDither(lumas, width, height);
  assert.equal(result.length, 9);
  result.forEach((p) => assert.ok(p === 0 || p === 255));
});

test("generateRasterGcode converts pixel map to continuous horizontal G-code sweeps", () => {
  const mockDitheredMap = {
    width: 3,
    height: 3,
    lumas: new Float32Array([0, 255, 0, 255, 0, 255, 0, 0, 0]),
  };
  const bounds = { x: 0, y: 0, width: 30, height: 30 };
  const layer = { name: "Test Layer", feed: 2000, travelSpeed: 2000, power: 800 };
  const gcode = generateRasterGcode(mockDitheredMap, bounds, layer);

  assert.ok(gcode.some((l) => l.includes("; Raster Operation:")));
  assert.ok(gcode.includes("G0 F2000"));
  const text = gcode.join("\n");
  assert.match(text, /M[34] S800/);
  const offCount = gcode.filter((line) => line.includes("M5")).length;
  assert.ok(offCount > 1);
});

test("buildRasterRows emits bidirectional row order", () => {
  const rows = buildRasterRows(
    {
      width: 3,
      height: 2,
      lumas: new Float32Array([0, 255, 0, 255, 0, 255]),
    },
    { x: 10, y: 20, width: 30, height: 10 },
    { bidirectional: true }
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].direction, "right");
  assert.equal(rows[0].bitstring, "101");
  assert.equal(rows[1].direction, "left");
  assert.equal(rows[1].bitstring, "010");
});

test("generateRasterGcode uses serpentine travel when enabled", () => {
  const gcode = generateRasterGcode(
    {
      width: 2,
      height: 2,
      lumas: new Float32Array([0, 255, 255, 0]),
    },
    { x: 0, y: 0, width: 2, height: 2 },
    { name: "Raster", feed: 600, travelSpeed: 1200, power: 250, bidirectional: true }
  );

  const joined = gcode.join("\n");
  assert.match(joined, /G0 X0\.000 Y0\.000/);
  assert.match(joined, /G0 X2\.000 Y1\.000/);
  assert.match(joined, /M4 S250/);
});

test("generateRasterGcode respects lower-left machine origins", () => {
  const gcode = generateRasterGcode(
    {
      width: 2,
      height: 1,
      lumas: new Float32Array([0, 0]),
    },
    { x: 10, y: 20, width: 2, height: 1 },
    { name: "Raster", feed: 600, travelSpeed: 1200, power: 250, bidirectional: true },
    { originMode: "lower-left", bedHeight: 100 }
  );

  const joined = gcode.join("\n");
  assert.match(joined, /G0 X10\.000 Y80\.000/);
  assert.match(joined, /G1 X12\.000 Y80\.000 F600/);
});

test("applyAtkinsonDither binary output check", () => {
  const lumas = new Float32Array([128, 128, 128, 128]);
  const dithered = applyAtkinsonDither(lumas, 2, 2);
  dithered.forEach((v) => assert.ok(v === 0 || v === 255));
});

test("generateRasterGcode boundary conditions", () => {
  const mockMap = {
    width: 2,
    height: 1,
    lumas: new Float32Array([0, 0]),
  };
  const bounds = { x: 0, y: 0, width: 2, height: 1 };
  const layer = { travelSpeed: 1000, feed: 500, power: 100 };
  const gcode = generateRasterGcode(mockMap, bounds, layer);
  assert.ok(gcode.filter((l) => l.startsWith("G0 X0")).length > 0);
  assert.ok(gcode.filter((l) => l.includes("G1 X2.000")).length > 0);
  assert.ok(gcode.includes("M5"));
});

test("generateRasterGcode 1x1 image", () => {
  const mockMap = { width: 1, height: 1, lumas: new Float32Array([0]) };
  const gcode = generateRasterGcode(mockMap, { x: 0, y: 0, width: 1, height: 1 }, { power: 100 });
  assert.ok(gcode.some((l) => l.includes("M3 S100") || l.includes("M4 S100")));
});
