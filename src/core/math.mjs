/**
 * Ensures a value is a finite number, otherwise returns a fallback.
 * @param {any} value - Input value to check.
 * @param {number} fallback - Value to return if input is invalid.
 * @returns {number}
 */
export function numericOr(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/**
 * Combines two transformation objects or matrices.
 * @param {Object} p - Parent transform.
 * @param {Object} n - Child (node) transform.
 * @returns {Object} Combined matrix or transform object.
 */
export function combineTransforms(p, n) {
  if (!p && !n) {
    return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  }
  if (!p) {
    return { ...n };
  }
  if (!n) {
    return { ...p };
  }

  const pMatrix = p.matrix || (typeof p.a === "number" ? p : transformToMatrix(p));
  const nMatrix = n.matrix || (typeof n.a === "number" ? n : transformToMatrix(n));

  if (p.matrix || n.matrix || typeof p.a === "number" || typeof n.a === "number") {
    return multiplyMatrix(pMatrix, nMatrix);
  }

  const psX = p.scaleX ?? p.scale ?? 1;
  const psY = p.scaleY ?? p.scale ?? 1;
  const nsX = n.scaleX ?? n.scale ?? 1;
  const nsY = n.scaleY ?? n.scale ?? 1;
  return {
    x: (p.x || 0) + (n.x || 0) * psX,
    y: (p.y || 0) + (n.y || 0) * psY,
    scaleX: psX * nsX,
    scaleY: psY * nsY,
    rotation: (p.rotation || 0) + (n.rotation || 0),
  };
}

export function transformToMatrix(tNode) {
  if (!tNode) {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  const target = tNode.matrix || tNode;
  if (typeof target.a === "number") {
    return target;
  }
  const sx = target.scaleX ?? target.scale ?? 1;
  const sy = target.scaleY ?? target.scale ?? 1;
  const angle = ((target.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    a: sx * cos,
    b: sx * sin,
    c: sy * -sin,
    d: sy * cos,
    e: tNode.x || 0,
    f: tNode.y || 0,
  };
}

/**
 * Multiplies two affine transformation matrices.
 * @param {Object} m1 - Matrix A.
 * @param {Object} m2 - Matrix B.
 * @returns {Object} Resulting matrix.
 */
export function multiplyMatrix(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/**
 * Applies a transformation matrix to a point.
 * @param {Object} p - Point {x, y}.
 * @param {Object} m - Matrix.
 * @returns {Object} Transformed point.
 */
export function applyMatrixToPoint(p, m) {
  return {
    x: p.x * m.a + p.y * m.c + m.e,
    y: p.x * m.b + p.y * m.d + m.f,
  };
}

/**
 * Neatly rounds a float to precision strings for UI display.
 * @param {number|string} value - Input number.
 * @returns {string}
 */
export function formatCompact(value) {
  if (typeof value !== "number") {
    return value;
  }
  const s = value.toFixed(2);
  if (s.endsWith(".00")) {
    return s.slice(0, -3);
  }
  if (s.endsWith("0") && s.includes(".")) {
    return s.slice(0, -1);
  }
  return s;
}

export function pointsMatch(p1, p2, precision = 3) {
  if (!p1 || !p2) {
    return false;
  }
  return round(p1.x, precision) === round(p2.x, precision) && round(p1.y, precision) === round(p2.y, precision);
}

export function format(value) {
  return round(value, 3).toFixed(3);
}

export function round(val, precision = 2) {
  const m = Math.pow(10, precision);
  return Math.round(val * m) / m;
}

export function composeTransform(node) {
  const sx = node.scaleX ?? node.scale ?? 1;
  const sy = node.scaleY ?? node.scale ?? 1;
  const cx = (node.sourceBounds?.centerX || 0) * sx;
  const cy = (node.sourceBounds?.centerY || 0) * sy;
  return `translate(${node.x || 0} ${node.y || 0}) rotate(${node.rotation || 0} ${cx} ${cy}) scale(${sx} ${sy})`;
}

export function transformPointByTransform(px, py, sourceBounds, transform) {
  let x = px,
    y = py,
    sb = sourceBounds,
    t = transform;
  if (typeof px === "object" && px !== null) {
    x = px.x;
    y = px.y;
    t = py;
    sb = sourceBounds;
  }
  const sx = t?.scaleX ?? t?.scale ?? 1;
  const sy = t?.scaleY ?? t?.scale ?? 1;
  const tx = t?.x ?? t?.e ?? 0;
  const ty = t?.y ?? t?.f ?? 0;
  const scaledX = x * sx;
  const scaledY = y * sy;
  const cx = (sb?.centerX || 0) * sx;
  const cy = (sb?.centerY || 0) * sy;
  const angle = ((t?.rotation || 0) * Math.PI) / 180;
  const dx = scaledX - cx;
  const dy = scaledY - cy;
  return {
    x: tx + cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: ty + cy + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

export function normalizeSourceBounds(bounds) {
  return {
    minX: bounds?.minX ?? 0,
    minY: bounds?.minY ?? 0,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
    centerX: bounds?.centerX ?? 0,
    centerY: bounds?.centerY ?? 0,
  };
}

export function unionBounds(bounds) {
  const list = (Array.isArray(bounds) ? bounds : bounds ? [bounds] : []).filter(
    (b) => b !== null && typeof b === "object" && (b.width !== undefined || b.minX !== undefined)
  );

  if (!list.length) {
    return { x: 0, y: 0, minX: 0, minY: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  }
  const xs = list.flatMap((b) => {
    const bx = b.x !== undefined ? b.x : b.minX !== undefined ? b.minX : 0;
    return [bx, bx + (b.width || 0)];
  });
  const ys = list.flatMap((b) => {
    const by = b.y !== undefined ? b.y : b.minY !== undefined ? b.minY : 0;
    return [by, by + (b.height || 0)];
  });
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(0.001, Math.max(...xs) - minX);
  const height = Math.max(0.001, Math.max(...ys) - minY);
  const result = normalizeSourceBounds({ minX, minY, width, height });
  return {
    ...result,
    x: minX,
    y: minY,
  };
}

export function objectWorldBounds(node, parentTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }) {
  if (!node) {
    return { x: 0, y: 0, minX: 0, minY: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  }
  const transform = combineTransforms(parentTransform, node);
  const transformMatrix =
    typeof transform.a === "number" ? transform : combineTransforms({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, transform);

  if (node.type === "group" || node.children?.length) {
    const childrenBounds = (node.children || [])
      .map((child) => objectWorldBounds(child, transformMatrix))
      .filter((b) => b && b.width > 0 && b.height > 0);
    return childrenBounds.length
      ? unionBounds(childrenBounds)
      : { x: 0, y: 0, width: 0, height: 0, ...normalizeSourceBounds({}) };
  }

  const sb = normalizeSourceBounds(node.sourceBounds);
  if (sb.width === 0 && sb.height === 0) {
    return { x: 0, y: 0, width: 0, height: 0, ...sb };
  }

  const p1 = applyMatrixToPoint({ x: sb.minX, y: sb.minY }, transformMatrix);
  const p2 = applyMatrixToPoint({ x: sb.minX + sb.width, y: sb.minY }, transformMatrix);
  const p3 = applyMatrixToPoint({ x: sb.minX + sb.width, y: sb.minY + sb.height }, transformMatrix);
  const p4 = applyMatrixToPoint({ x: sb.minX, y: sb.minY + sb.height }, transformMatrix);

  const xs = [p1.x, p2.x, p3.x, p4.x];
  const ys = [p1.y, p2.y, p3.y, p4.y];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    ...normalizeSourceBounds({ minX, minY, width: maxX - minX, height: maxY - minY }),
    x: minX,
    y: minY,
    maxX,
    maxY,
  };
}

export function parseTransform(transformStr) {
  if (!transformStr) {
    return null;
  }
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  const regex = /([a-zA-Z]+)\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(transformStr)) !== null) {
    const type = match[1].toLowerCase();
    const args = match[2]
      .split(/[\s,]+/)
      .map(parseFloat)
      .filter((v) => !isNaN(v));

    switch (type) {
      case "matrix":
        if (args.length >= 6) {
          matrix = multiplyMatrix(matrix, { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] });
        }
        break;
      case "translate": {
        const tx = args[0] || 0;
        const ty = args[1] || 0;
        matrix = multiplyMatrix(matrix, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
        break;
      }
      case "scale": {
        const sx = args[0] || 1;
        const sy = args[1] !== undefined ? args[1] : sx;
        matrix = multiplyMatrix(matrix, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
        break;
      }
      case "rotate": {
        const angle = args[0] || 0;
        let rx, ry;
        if (args.length >= 3) {
          rx = args[1];
          ry = args[2];
          const rad = (angle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const m = {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: rx - cos * rx + sin * ry,
            f: ry - sin * rx - cos * ry,
          };
          matrix = multiplyMatrix(matrix, m);
        } else {
          const rad = (angle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const m = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
          matrix = multiplyMatrix(matrix, m);
        }
        break;
      }
      case "skewx": {
        const tanX = Math.tan(((args[0] || 0) * Math.PI) / 180);
        matrix = multiplyMatrix(matrix, { a: 1, b: 0, c: tanX, d: 1, e: 0, f: 0 });
        break;
      }
      case "skewy": {
        const tanY = Math.tan(((args[0] || 0) * Math.PI) / 180);
        matrix = multiplyMatrix(matrix, { a: 1, b: tanY, c: 0, d: 1, e: 0, f: 0 });
        break;
      }
    }
  }

  return { matrix, transforms: [] };
}
