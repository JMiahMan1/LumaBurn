import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCompact,
  round,
  unionBounds,
  combineTransforms,
  composeTransform,
  transformPointByTransform,
  normalizeSourceBounds,
  parseTransform,
  transformToMatrix,
  objectWorldBounds,
  numericOr,
  applyMatrixToPoint,
} from "../src/core/math.mjs";

test("multiplyMatrix correctly applies transformations", () => {
  const m2 = parseTransform("matrix(1,0,0,1,10,10) translate(5,5)").matrix;
  const p1 = transformPointByTransform({ x: 0, y: 0 }, m2);
  assert.strictEqual(p1.x, 15);
  assert.strictEqual(p1.y, 15);
});

test("unionBounds correctly handles degenerate bounds", () => {
  const b1 = { minX: 0, minY: 0, width: 10, height: 10 };
  const b2 = { minX: 5, minY: 5, width: 0, height: 0 }; // Point
  const u1 = unionBounds([b1, b2]);
  assert.strictEqual(u1.minX, 0);
  assert.strictEqual(u1.width, 10);

  const u2 = unionBounds([null, b1]);
  assert.strictEqual(u2.width, 10);

  const u3 = unionBounds([b1, null]);
  assert.strictEqual(u3.width, 10);
});

test("formatCompact neatly rounds floats to precision strings", () => {
  assert.equal(formatCompact(1.2345), "1.23");
  assert.equal(formatCompact(1.0001), "1");
  assert.equal(formatCompact(1.5), "1.5");
  assert.equal(formatCompact(0.0), "0");
  assert.equal(formatCompact("not a number"), "not a number");
});

test("round and format functions", () => {
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(round(1.2356, 2), 1.24);
});

test("unionBounds correctly expands to fit all inner bounds", () => {
  const b1 = { x: 0, y: 0, width: 10, height: 10 };
  const b2 = { x: -5, y: -5, width: 20, height: 20 };
  const b3 = { x: 20, y: 20, width: 2, height: 2 };

  const union = unionBounds([b1, b2, b3]);
  assert.equal(union.x, -5);
  assert.equal(union.y, -5);
  // Max X = 20 + 2 = 22. Min X = -5. Width = 27
  assert.equal(union.width, 27);
  assert.equal(union.height, 27);

  const empty = unionBounds([]);
  assert.equal(empty.x, 0);
  assert.equal(empty.width, 0);

  const single = unionBounds([{ x: 10, y: 10, width: 5, height: 5 }]);
  assert.equal(single.x, 10);
  assert.equal(single.width, 5);
});

test("combineTransforms handles various inputs", () => {
  // Identity
  const empty = combineTransforms(null, null);
  assert.equal(empty.scaleX, 1);
  assert.equal(empty.x, 0);

  // Single inputs
  const p = { x: 10, y: 10, scale: 2 };
  const n = { x: 5, y: 5, rotation: 90 };
  const combined = combineTransforms(p, n);
  // Using transform logic: (10 + 5*2) = 20
  assert.strictEqual(combined.x, 20);
  assert.strictEqual(combined.scaleX, 2);
  assert.strictEqual(combined.rotation, 90);

  assert.deepEqual(combineTransforms(null, null), { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  assert.deepEqual(combineTransforms(p, null), p);
  assert.deepEqual(combineTransforms(null, n), n);
});

test("composeTransform and transformPointByTransform branch coverage", () => {
  const node = { x: 10, y: 10, scale: 2, rotation: 45, sourceBounds: { centerX: 5, centerY: 5 } };
  const s = composeTransform(node);
  assert.ok(s.includes("scale(2 2)"));
  assert.ok(s.includes("rotate(45 10 10)")); // 5 * 2 = 10

  const nodeNoScale = { x: 0, y: 0 }; // Should fallback to scale 1
  const s2 = composeTransform(nodeNoScale);
  assert.ok(s2.includes("scale(1 1)"));

  const pt = transformPointByTransform({ x: 0, y: 0 }, { x: 10, y: 10, scale: 1, rotation: 0 });
  assert.equal(pt.x, 10);
  assert.equal(pt.y, 10);
});

test("parseTransform handles various SVG string formats", () => {
  const t1 = parseTransform("translate(10, 20)");
  assert.strictEqual(t1.matrix.e, 10);
  assert.strictEqual(t1.matrix.f, 20);

  const t2 = parseTransform("scale(2, 3)");
  assert.strictEqual(t2.matrix.a, 2);
  assert.strictEqual(t2.matrix.d, 3);

  const t3 = parseTransform("rotate(90)");
  assert.ok(Math.abs(t3.matrix.a) < 0.001);
  assert.strictEqual(t3.matrix.b, 1);

  const t4 = parseTransform("skewX(45)");
  assert.ok(Math.abs(t4.matrix.c - 1) < 0.001);

  const t5 = parseTransform("matrix(1, 0.5, -0.5, 1, 100, 200)");
  assert.strictEqual(t5.matrix.b, 0.5);
  assert.strictEqual(t5.matrix.e, 100);

  const t6 = parseTransform("rotate(90, 50, 50)");
  assert.ok(Math.abs(t6.matrix.e - 100) < 0.001);

  assert.strictEqual(parseTransform(""), null);
});

test("objectWorldBounds handles groups and empty definitions", () => {
  const group = {
    type: "group",
    children: [
      { type: "rect", sourceBounds: { x: 0, y: 0, width: 10, height: 10 }, x: 5, y: 5 },
      { type: "rect", sourceBounds: { x: 0, y: 0, width: 10, height: 10 }, x: 15, y: 15 },
    ],
  };
  const bounds = objectWorldBounds(group);
  assert.strictEqual(bounds.x, 5);
  assert.strictEqual(bounds.y, 5);
  assert.strictEqual(bounds.width, 20);
  assert.strictEqual(bounds.height, 20);

  const emptyGroup = { type: "group", children: [] };
  const b = objectWorldBounds(emptyGroup);
  assert.strictEqual(b.width, 0);
  assert.strictEqual(b.height, 0);
});

test("combineTransforms edge cases", () => {
  assert.deepStrictEqual(combineTransforms(null, null), { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  const t = { x: 10, y: 10 };
  assert.deepStrictEqual(combineTransforms(null, t), t);
  assert.deepStrictEqual(combineTransforms(t, null), t);

  const m1 = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 };
  const m2 = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 };
  const combined = combineTransforms({ matrix: m1 }, { matrix: m2 });
  assert.strictEqual(combined.e, 15);
});

test("round and numericOr branch coverage", () => {
  assert.strictEqual(round(1.2345, 2), 1.23);
  assert.strictEqual(round(1.2, 0), 1);
  assert.strictEqual(numericOr("", 5), 5);
  assert.strictEqual(numericOr(undefined, 3), 3);
});

test("combineTransforms with single-sided matrix", () => {
  const m1 = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 };
  const res1 = combineTransforms({ matrix: m1 }, { x: 5, y: 5 });
  assert.strictEqual(res1.e, 15);

  const res2 = combineTransforms({ x: 5, y: 5 }, { matrix: m1 });
  assert.strictEqual(res2.e, 15);
});

test("normalizeSourceBounds and unionBounds branch coverage", () => {
  const b = normalizeSourceBounds(null);
  assert.equal(b.minX, 0);
  assert.equal(b.width, 0);

  // unionBounds with mixed x/minX
  const u = unionBounds([
    { minX: 10, minY: 10, width: 5, height: 5 },
    { x: 20, y: 20, width: 5, height: 5 },
  ]);
  assert.equal(u.x, 10);
  assert.equal(u.width, 15);
});
test("objectWorldBounds branch coverage for mixed groups", () => {
  const rect = {
    type: "rect",
    sourceBounds: { minX: 0, minY: 0, width: 10, height: 10 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  };
  const path = {
    type: "path",
    sourceBounds: { minX: 10, minY: 10, width: 10, height: 10 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  };
  const group = {
    type: "group",
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 },
    children: [rect, path],
  };
  const bounds = objectWorldBounds(group);
  assert.strictEqual(bounds.x, 10);
  assert.strictEqual(bounds.y, 10);
  assert.strictEqual(bounds.width, 20);
  assert.strictEqual(bounds.height, 20);
});

test("objectWorldBounds handles specialized types", () => {
  assert.strictEqual(
    objectWorldBounds({ type: "image", sourceBounds: { minX: 0, minY: 0, width: 5, height: 5 } }).width,
    5
  );
  assert.strictEqual(
    objectWorldBounds({ type: "text", sourceBounds: { minX: 0, minY: 0, width: 10, height: 2 } }).width,
    10
  );
  assert.strictEqual(objectWorldBounds({ type: "unknown" }).width, 0);
});

test("unionBounds branch coverage", () => {
  // Empty
  const empty = unionBounds([]);
  assert.strictEqual(empty.width, 0);
  assert.strictEqual(empty.x, 0);

  // Single null/undefined check
  const single = unionBounds([{ x: 10, y: 10, width: 5, height: 5 }]);
  assert.strictEqual(single.x, 10);
  assert.strictEqual(single.width, 5);
});

test("numericOr correctly handles fallbacks", () => {
  assert.equal(numericOr(10, 5), 10);
  assert.equal(numericOr("20", 5), 20);
  assert.equal(numericOr(null, 5), 5);
  assert.equal(numericOr(undefined, 5), 5);
  assert.equal(numericOr("NaN", 5), 5);
});

test("applyMatrixToPoint correctly multiplies point and matrix", () => {
  const p = { x: 10, y: 20 };
  const m = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 }; // Translate 5, 5
  const result = applyMatrixToPoint(p, m);
  assert.equal(result.x, 15);
  assert.equal(result.y, 25);
});

test("surgical math branch coverage", () => {
  // transformToMatrix all branches (Identity, partials, full)
  assert.equal(transformToMatrix(null).a, 1);
  assert.equal(transformToMatrix({}).a, 1);
  assert.equal(transformToMatrix({ a: 2 }).a, 2);
  assert.equal(transformToMatrix({ scaleX: 2 }).a, 2);
  assert.equal(transformToMatrix({ matrix: { a: 3 } }).a, 3);
  const t = transformToMatrix({ x: 10, y: 10 });
  assert.equal(t.e, 10);
  assert.equal(t.f, 10);
  assert.equal(transformToMatrix({ rotation: 90 }).a < 0.001, true); // cos(90)
});

// ── Regression tests for scaleX/scaleY vs legacy `scale` field (bug fixed 2026-04) ──

test("composeTransform: scaleX/scaleY and legacy scale produce correct output", () => {
  const sourceBounds = { centerX: 25, centerY: 25 };
  const withNewFields = { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 0, sourceBounds };
  const withLegacyField = { x: 10, y: 20, scale: 2, rotation: 0, sourceBounds };

  // New-style: scaleX=2 scaleY=3  -> scale(2 3)
  assert.ok(
    composeTransform(withNewFields).includes("scale(2 3)"),
    "scaleX/scaleY must appear independently in transform"
  );

  // Legacy fallback: no scaleX/scaleY -> uses scale for both -> scale(2 2)
  assert.ok(
    composeTransform(withLegacyField).includes("scale(2 2)"),
    "legacy scale field must produce isotropic transform"
  );
});

test("objectWorldBounds: scaleX/scaleY correctly scales bounds independently", () => {
  const sourceBounds = { minX: 0, minY: 0, width: 50, height: 50, centerX: 25, centerY: 25 };
  const node = {
    x: 0,
    y: 0,
    scaleX: 2,
    scaleY: 1,
    rotation: 0,
    sourceBounds,
    children: [],
  };
  const bounds = objectWorldBounds(node);
  assert.ok(Math.abs(bounds.width - 100) < 1, `expected width ~100, got ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 50) < 1, `expected height ~50, got ${bounds.height}`);
});

test("objectWorldBounds: legacy scale field gives same result as matching scaleX==scaleY", () => {
  const sourceBounds = { minX: 0, minY: 0, width: 40, height: 40, centerX: 20, centerY: 20 };
  const newNode = { x: 5, y: 5, scaleX: 3, scaleY: 3, rotation: 0, sourceBounds, children: [] };
  const legacyNode = { x: 5, y: 5, scale: 3, rotation: 0, sourceBounds, children: [] };

  const nb = objectWorldBounds(newNode);
  const lb = objectWorldBounds(legacyNode);

  assert.ok(Math.abs(nb.width - lb.width) < 0.01, "widths must match between scale and scaleX/scaleY");
  assert.ok(Math.abs(nb.height - lb.height) < 0.01, "heights must match");
  assert.ok(Math.abs(nb.x - lb.x) < 0.01, "x positions must match");
});
