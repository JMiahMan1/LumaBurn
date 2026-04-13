/**
 * SVG-to-Node Conversion System
 * Converts SVG DOM into structured node objects for full editing
 */

export function convertSvgToNodes(svgElement, options = {}) {
  const defsMap = new Map();
  const defs = svgElement.querySelector('defs');
  if (defs) {
    for (const def of defs.children) {
      const defId = def.getAttribute('id');
      if (defId) defsMap.set(defId, def);
    }
  }

  const nodes = [];
  for (const child of svgElement.children) {
    if (child.tagName.toLowerCase() === 'defs') continue;
    const node = convertElement(child, defsMap, options);
    if (node) nodes.push(node);
  }

  return {
    nodes,
    viewBox: parseViewBox(svgElement.getAttribute('viewBox')),
    width: parseLength(svgElement.getAttribute('width')),
    height: parseLength(svgElement.getAttribute('height'))
  };
}

function convertElement(element, defsMap, options) {
  if (!element) return null;
  const tagName = element.tagName.toLowerCase();
  const base = createNodeBase(element);

  switch (tagName) {
    case 'g': return convertGroup(element, defsMap, options, base);
    case 'path': return convertPath(element, base);
    case 'rect': return convertRect(element, base);
    case 'circle': return convertCircle(element, base);
    case 'ellipse': return convertEllipse(element, base);
    case 'line': return convertLine(element, base);
    case 'polyline': return convertPolyline(element, base);
    case 'polygon': return convertPolygon(element, base);
    case 'use': return convertUse(element, defsMap, options, base);
    case 'text': return convertText(element, base);
    case 'image': return convertImage(element, base);
    default:
      base.type = 'group';
      base.name = tagName;
      base.children = [];
      for (const child of element.children) {
        const childNode = convertElement(child, defsMap, options);
        if (childNode) base.children.push(childNode);
      }
      return base.children.length ? base : null;
  }
}

function createNodeBase(element) {
  const id = element.getAttribute('data-node-id') || element.getAttribute('id') || generateUid();
  return {
    id,
    tagName: element.tagName.toLowerCase(),
    attributes: extractAttributes(element),
    transform: parseTransform(element.getAttribute('transform')),
    style: parseStyle(element.getAttribute('style')),
    class: element.getAttribute('class') || '',
    children: []
  };
}

function generateUid() {
  return 'node-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function extractAttributes(element) {
  const attrs = {};
  for (const attr of element.attributes) {
    const name = attr.name;
    if (!['transform', 'style', 'class', 'id'].includes(name)) {
      attrs[name] = attr.value;
    }
  }
  return attrs;
}

function parseStyle(styleStr) {
  if (!styleStr) return {};
  const style = {};
  styleStr.split(';').forEach(decl => {
    const [key, value] = decl.split(':').map(s => s && s.trim());
    if (key && value) style[key] = value;
  });
  return style;
}

function parseLength(value, defaultValue = 0) {
  if (value == null) return defaultValue;
  const num = parseFloat(value);
  return isNaN(num) ? defaultValue : num;
}

function parseViewBox(viewBoxStr) {
  if (!viewBoxStr) return null;
  const parts = viewBoxStr.trim().split(/[\s,]+/).map(parseFloat).filter(v => !isNaN(v));
  if (parts.length >= 4) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return null;
}

export function parseTransform(transformStr) {
  if (!transformStr) return null;
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  const regex = /([a-zA-Z]+)\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(transformStr)) !== null) {
    const type = match[1].toLowerCase();
    const args = match[2].split(/[\s,]+/).map(parseFloat).filter(v => !isNaN(v));

    switch (type) {
      case 'matrix':
        if (args.length >= 6) {
          matrix = multiplyMatrix(matrix, { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] });
        }
        break;
      case 'translate':
        const tx = args[0] || 0;
        const ty = args[1] || 0;
        matrix = multiplyMatrix(matrix, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
        break;
      case 'scale':
        const sx = args[0] || 1;
        const sy = args[1] !== undefined ? args[1] : sx;
        matrix = multiplyMatrix(matrix, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
        break;
      case 'rotate':
        let angle = args[0] || 0;
        let rx, ry;
        if (args.length >= 3) {
          rx = args[1];
          ry = args[2];
          const rad = angle * Math.PI / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const m = {
            a: cos, b: sin,
            c: -sin, d: cos,
            e: rx - cos * rx + sin * ry,
            f: ry - sin * rx - cos * ry
          };
          matrix = multiplyMatrix(matrix, m);
        } else {
          const rad = angle * Math.PI / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          matrix = multiplyMatrix(matrix, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
        }
        break;
      case 'skewx':
        const tanX = Math.tan((args[0] || 0) * Math.PI / 180);
        matrix = multiplyMatrix(matrix, { a: 1, b: 0, c: tanX, d: 1, e: 0, f: 0 });
        break;
      case 'skewy':
        const tanY = Math.tan((args[0] || 0) * Math.PI / 180);
        matrix = multiplyMatrix(matrix, { a: 1, b: tanY, c: 0, d: 1, e: 0, f: 0 });
        break;
    }
  }

  return { matrix, transforms: [] };
}

export function multiplyMatrix(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f
  };
}

function convertPath(element, base) {
  base.type = 'path';
  base.name = element.getAttribute('id') || 'Path';
  base.d = element.getAttribute('d') || '';
  return base;
}

function convertRect(element, base) {
  base.type = 'rect';
  base.name = element.getAttribute('id') || 'Rectangle';
  base.x = parseLength(element.getAttribute('x'), 0);
  base.y = parseLength(element.getAttribute('y'), 0);
  base.width = parseLength(element.getAttribute('width'), 0);
  base.height = parseLength(element.getAttribute('height'), 0);
  base.rx = parseLength(element.getAttribute('rx'));
  base.ry = parseLength(element.getAttribute('ry'));
  return base;
}

function convertCircle(element, base) {
  base.type = 'circle';
  base.name = element.getAttribute('id') || 'Circle';
  base.cx = parseLength(element.getAttribute('cx'), 0);
  base.cy = parseLength(element.getAttribute('cy'), 0);
  base.r = parseLength(element.getAttribute('r'), 0);
  return base;
}

function convertEllipse(element, base) {
  base.type = 'ellipse';
  base.name = element.getAttribute('id') || 'Ellipse';
  base.cx = parseLength(element.getAttribute('cx'), 0);
  base.cy = parseLength(element.getAttribute('cy'), 0);
  base.rx = parseLength(element.getAttribute('rx'), 0);
  base.ry = parseLength(element.getAttribute('ry'), 0);
  return base;
}

function convertLine(element, base) {
  base.type = 'line';
  base.name = element.getAttribute('id') || 'Line';
  base.x1 = parseLength(element.getAttribute('x1'), 0);
  base.y1 = parseLength(element.getAttribute('y1'), 0);
  base.x2 = parseLength(element.getAttribute('x2'), 0);
  base.y2 = parseLength(element.getAttribute('y2'), 0);
  return base;
}

function convertPolyline(element, base) {
  base.type = 'polyline';
  base.name = element.getAttribute('id') || 'Polyline';
  base.points = parsePoints(element.getAttribute('points'));
  return base;
}

function convertPolygon(element, base) {
  base.type = 'polygon';
  base.name = element.getAttribute('id') || 'Polygon';
  base.points = parsePoints(element.getAttribute('points'));
  return base;
}

function convertUse(element, defsMap, options, base) {
  base.type = 'use';
  base.name = element.getAttribute('id') || 'Use';
  const href = (element.getAttribute('href') || element.getAttribute('xlink:href') || '').replace(/^#/, '');
  if (href) {
    base.href = href;
    if (options.resolveUseElements && defsMap.has(href)) {
      const referenced = defsMap.get(href);
      if (referenced) {
        const refNode = convertElement(referenced, defsMap, { ...options, resolveUseElements: false });
        if (refNode) {
          // Merge referenced attributes (use attributes override)
          base.attributes = { ...refNode.attributes, ...base.attributes };
          base.children = refNode.children || [];
          base.type = refNode.type;
          // Copy type-specific data
          copyTypeData(refNode, base);
        }
      }
    }
  }
  return base;
}

function copyTypeData(source, target) {
  const typeFields = ['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'href', 'content', 'fontSize', 'fontFamily'];
  for (const field of typeFields) {
    if (source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

function convertText(element, base) {
  base.type = 'text';
  base.name = element.getAttribute('id') || 'Text';
  base.x = parseLength(element.getAttribute('x'), 0);
  base.y = parseLength(element.getAttribute('y'), 0);
  base.content = element.textContent || '';
  base.fontSize = parseLength(element.getAttribute('font-size'), 12);
  base.fontFamily = element.getAttribute('font-family') || 'sans-serif';
  return base;
}

function convertImage(element, base) {
  base.type = 'image';
  base.name = element.getAttribute('id') || 'Image';
  base.href = (element.getAttribute('href') || element.getAttribute('xlink:href') || '').replace(/^#/, '');
  base.x = parseLength(element.getAttribute('x'), 0);
  base.y = parseLength(element.getAttribute('y'), 0);
  base.width = parseLength(element.getAttribute('width'), 0);
  base.height = parseLength(element.getAttribute('height'), 0);
  return base;
}

function convertGroup(element, defsMap, options, base) {
  base.type = 'group';
  base.name = element.getAttribute('id') || element.getAttribute('inkscape:label') || 'Group';
  base.children = [];
  for (const child of element.children) {
    const childNode = convertElement(child, defsMap, options);
    if (childNode) base.children.push(childNode);
  }
  return base;
}

function parsePoints(pointsStr) {
  if (!pointsStr) return [];
  const nums = pointsStr.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) {
    if (i + 1 < nums.length) {
      pts.push({ x: nums[i], y: nums[i + 1] });
    }
  }
  return pts;
}

// Convert node back to SVG string for rendering
export function nodeTreeToSvgString(node, parentTransform = null, parentStyles = {}) {
  const childMatrix = node.transform ? (node.transform.matrix || node.transform) : null;
  const transform = combineTransforms(parentTransform, childMatrix);
  const attrs = { ...node.attributes };

  if (transform && (transform.e !== 0 || transform.f !== 0 || transform.a !== 1 || transform.d !== 1)) {
    attrs.transform = `matrix(${transform.a.toFixed(6)} ${transform.b.toFixed(6)} ${transform.c.toFixed(6)} ${transform.d.toFixed(6)} ${transform.e.toFixed(6)} ${transform.f.toFixed(6)})`;
  }

  const mergedStyle = { ...parentStyles, ...node.style };
  if (Object.keys(mergedStyle).length > 0) {
    attrs.style = Object.entries(mergedStyle).map(([k, v]) => `${k}:${v}`).join(';');
  }

  if (node.class) attrs.class = node.class;

  let inner = '';
  switch (node.type) {
    case 'text':
      inner = escapeXml(node.content || '');
      break;
    case 'path':
      if (node.d) attrs.d = node.d;
      break;
    case 'rect':
      if (node.width !== undefined) attrs.width = node.width;
      if (node.height !== undefined) attrs.height = node.height;
      if (node.x !== undefined) attrs.x = node.x;
      if (node.y !== undefined) attrs.y = node.y;
      if (node.rx !== undefined) attrs.rx = node.rx;
      if (node.ry !== undefined) attrs.ry = node.ry;
      break;
    case 'circle':
      if (node.cx !== undefined) attrs.cx = node.cx;
      if (node.cy !== undefined) attrs.cy = node.cy;
      if (node.r !== undefined) attrs.r = node.r;
      break;
    case 'ellipse':
      if (node.cx !== undefined) attrs.cx = node.cx;
      if (node.cy !== undefined) attrs.cy = node.cy;
      if (node.rx !== undefined) attrs.rx = node.rx;
      if (node.ry !== undefined) attrs.ry = node.ry;
      break;
    case 'line':
      if (node.x1 !== undefined) attrs.x1 = node.x1;
      if (node.y1 !== undefined) attrs.y1 = node.y1;
      if (node.x2 !== undefined) attrs.x2 = node.x2;
      if (node.y2 !== undefined) attrs.y2 = node.y2;
      break;
    case 'polyline':
    case 'polygon':
      if (node.points && node.points.length > 0) {
        attrs.points = node.points.map(p => `${p.x},${p.y}`).join(' ');
      }
      break;
    case 'image':
      if (node.href) attrs.href = node.href;
      if (node.width !== undefined) attrs.width = node.width;
      if (node.height !== undefined) attrs.height = node.height;
      if (node.x !== undefined) attrs.x = node.x;
      if (node.y !== undefined) attrs.y = node.y;
      break;
    case 'use':
      if (node.href) attrs.href = node.href;
      break;
  }

  const attrParts = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== '') {
      attrParts.push(`${key}="${escapeXml(String(value))}"`);
    }
  }

  const openTag = `<${node.tagName}${attrParts.length ? ' ' + attrParts.join(' ') : ''}>`;

  if (node.children && node.children.length > 0) {
    const childrenSvg = node.children.map(child => nodeTreeToSvgString(child, transform, mergedStyle)).join('');
    return `${openTag}${inner}${childrenSvg}</${node.tagName}>`;
  } else {
    return `${openTag}${inner}</${node.tagName}>`;
  }
}

function combineTransforms(parent, child) {
  if (!parent && !child) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!parent) return child ? { ...child } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!child) return parent;
  return multiplyMatrix(parent, child);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
