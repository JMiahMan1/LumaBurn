import { multiplyMatrix, applyMatrixToPoint } from "./math.mjs";
export const DEFAULT_DEVICE_TIMEOUT_MS = 12000;
export const DEVICE_ACTIVITY_LIMIT = 80;

/**
 * Removes duplicates and empty values from an array of strings.
 * @param {string[]} values - Input array.
 * @returns {string[]}
 */
export function dedupeStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

/**
 * Normalizes a URL string to ensure it includes a protocol.
 * @param {string} value - Input URL or hostname.
 * @returns {string}
 */
export function normalizeDeviceUrl(value) {
  if (!value) {
    return "";
  }
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

export function normalizeDevicePath(basePath, filename) {
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${prefix}${filename}`.replace(/\/+/g, "/");
}

export function subnetFromDeviceUrl(value) {
  try {
    const parsed = new URL(normalizeDeviceUrl(value));
    const parts = parsed.hostname.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : "";
  } catch {
    return "";
  }
}

function parseCidr(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet < 0 || octet > 255) || prefix < 0 || prefix > 32) {
    return null;
  }
  return { octets, prefix };
}

function ipv4ToInt(octets) {
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function intToSubnet(value) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}`;
}

function expandCidrToSubnets(value, limit = 64) {
  const parsed = parseCidr(value);
  if (!parsed) {
    return [];
  }
  const address = ipv4ToInt(parsed.octets);
  const prefix = parsed.prefix;
  if (prefix >= 24) {
    return [intToSubnet(address & 0xffffff00)];
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = address & mask;
  const span = Math.min(limit, 2 ** Math.max(0, 24 - prefix));
  return Array.from({ length: span }, (_, index) => intToSubnet(start + index * 256));
}

export function expandManualScanToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return [];
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    return [trimmed];
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split(".");
    return [`${parts[0]}.${parts[1]}.${parts[2]}`];
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(trimmed)) {
    return expandCidrToSubnets(trimmed);
  }
  return [];
}

export function addAdjacentSubnets(subnets, radius = 2) {
  const expanded = [];
  subnets.forEach((subnet) => {
    expanded.push(subnet);
    const parts = subnet.split(".").map(Number);
    if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
      return;
    }
    for (let offset = 1; offset <= radius; offset += 1) {
      if (parts[2] - offset >= 0) {
        expanded.push(`${parts[0]}.${parts[1]}.${parts[2] - offset}`);
      }
      if (parts[2] + offset <= 255) {
        expanded.push(`${parts[0]}.${parts[1]}.${parts[2] + offset}`);
      }
    }
  });
  return dedupeStrings(expanded);
}

/**
 * Builds a prioritized list of IP subnets for device discovery.
 * @param {Object} options - Discovery options including manual ranges and known URLs.
 * @returns {string[]} Deduped list of subnet prefixes (e.g., "192.168.1").
 */
export function buildDiscoveryCandidates({
  manualScanRange = "",
  deviceUrl = "",
  discoveredSubnets = [],
  networkSubnets = [],
} = {}) {
  const manual = String(manualScanRange)
    .split(/[\s,;]+/)
    .flatMap((token) => expandManualScanToken(token));
  const deviceSubnet = subnetFromDeviceUrl(deviceUrl);
  const prioritized = dedupeStrings([
    ...manual,
    deviceSubnet,
    ...discoveredSubnets,
    ...networkSubnets,
    "192.168.1",
    "192.168.0",
    "10.0.0",
  ]);
  return addAdjacentSubnets(prioritized, manual.length ? 1 : 2);
}

export function inspectDeviceResponse(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { ok: false, confidence: "none", summary: "No response body was returned." };
  }

  try {
    const json = JSON.parse(raw);
    const status = String(json.status || json.s_tatus || json.result || json.state || "").toLowerCase();
    const detail = String(json.data || json.message || json.msg || json.statusText || json.error || raw).trim();
    if (status === "ok" || status === "success") {
      return { ok: true, confidence: "high", summary: detail || "Device responded with OK.", data: json };
    }
    if (status === "error" || status === "fail" || status === "failed") {
      return { ok: false, confidence: "high", summary: detail || "Device reported an error.", data: json };
    }
  } catch {
    // Plain text response.
  }

  if (
    /(?:^|\s|[^a-zA-Z0-9])(ok|start|started|queued|running|processing|uploaded|done|success|\[SD-RUN\]|\[ESP\d+\]|file\s+opened|stream\s+started|\[MSG:)/i.test(
      raw
    )
  ) {
    return { ok: true, confidence: "medium", summary: raw };
  }
  if (
    /(?:^|\s|[^a-zA-Z0-9])(error|fail|failed|invalid|unknown|busy|denied|missing|timeout|forbidden)(?:$|\s|[^a-zA-Z0-9])/i.test(
      raw
    )
  ) {
    return { ok: false, confidence: "high", summary: raw };
  }

  return { ok: false, confidence: "low", summary: raw };
}

export function buildRunFileCommands(fullPath, { controllerFlavor = "" } = {}) {
  const normalizedPath = String(fullPath || "").trim();
  const basename = normalizedPath.split("/").filter(Boolean).at(-1) || normalizedPath;
  const rootRelative = normalizedPath.replace(/^\/(?:sd|ext)\//i, "/");
  const esp220Variants =
    String(controllerFlavor || "").toLowerCase() === "grbl-embedded"
      ? [
          normalizedPath ? `[ESP220]${normalizedPath}` : "",
          rootRelative && rootRelative !== normalizedPath ? `[ESP220]${rootRelative}` : "",
          basename ? `[ESP220]${basename}` : "",
        ]
      : [];
  return dedupeStrings([
    ...esp220Variants,
    normalizedPath ? `[ESP700] ${normalizedPath}` : "",
    normalizedPath ? `[ESP700]stream=${normalizedPath}` : "",
    normalizedPath ? `[ESP700] stream=${normalizedPath}` : "",
    basename && basename !== normalizedPath ? `[ESP700] ${basename}` : "",
    basename && basename !== normalizedPath ? `[ESP700]stream=${basename}` : "",
    basename && basename !== normalizedPath ? `[ESP700] stream=${basename}` : "",
  ]);
}

export function canUseControllerFileRun({ storageMode = "", uploadPath = "", browsePath = "" } = {}) {
  const effectivePath = String(uploadPath || browsePath || "").trim() || "/";
  return !(
    String(storageMode || "")
      .trim()
      .toLowerCase() === "direct" && effectivePath === "/"
  );
}

export function buildQueuedCommandVariants(line) {
  return [line, `[ESP500] ${line}`];
}

export function buildStopCommandPlans() {
  return [
    {
      id: "emergency-stop-burst",
      label: "Emergency stop burst",
      steps: [
        { command: "!" },
        { command: "M5" },
        { waitAfterMs: 25, command: "\u0018" },
        { waitAfterMs: 25, command: "M5" },
      ],
    },
  ];
}

export async function executeStopSequence({
  sendCommand,
  wait = async () => {},
  plans = buildStopCommandPlans(),
} = {}) {
  let lastError = null;

  for (const plan of plans) {
    const failedSteps = [];
    let succeededSteps = 0;

    try {
      for (const step of plan.steps) {
        try {
          await sendCommand(step.command, plan);
          succeededSteps += 1;
        } catch (error) {
          failedSteps.push({ command: step.command, error });
          lastError = error;
        }
        if (step.waitAfterMs) {
          await wait(step.waitAfterMs);
        }
      }

      if (succeededSteps > 0) {
        return {
          ...plan,
          partial: failedSteps.length > 0,
          failedSteps,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to stop the device.");
}

export function gcodeToQueueLines(gcode) {
  return String(gcode || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\s*;.*$/, "")
        .replace(/\s*\(.*\).*$/, "")
        .trim()
    )
    .filter(Boolean);
}

export function normalizePointForMachine(point, machine = {}) {
  const mode = machine.originMode || "upper-left";
  const height = machine.bedHeight || 0;
  return mode === "upper-left" ? point : { x: point.x, y: height - point.y };
}

export function denormalizePointFromMachine(point, machine = {}) {
  const mode = machine.originMode || "upper-left";
  const height = machine.bedHeight || 0;
  return mode === "upper-left" ? point : { x: point.x, y: height - point.y };
}

export function parseGcodeGeometry(gcode, machine = {}) {
  const lines = String(gcode || "").split(/\r?\n/);
  const polylines = [];
  let current = { x: 0, y: 0 };
  let currentPolyline = null;
  let motionMode = "G0";
  let absoluteMode = true;
  let unitScale = 1;
  let laserOn = false;

  lines.forEach((rawLine) => {
    const line = rawLine
      .replace(/\s*;.*$/, "")
      .replace(/\([^)]*\)/g, "")
      .trim();
    if (!line) {
      return;
    }
    const tokens = [...line.matchAll(/([A-Za-z])([+-]?(?:\d+(?:\.\d+)?|\.\d+))/g)];
    if (!tokens.length) {
      return;
    }

    let nextMode = motionMode;
    let xValue = null;
    let yValue = null;
    let iValue = 0;
    let jValue = 0;

    tokens.forEach(([, letterRaw, valueRaw]) => {
      const letter = letterRaw.toUpperCase();
      const value = Number(valueRaw);
      if (!Number.isFinite(value)) {
        return;
      }
      if (letter === "G") {
        if (value === 0 || value === 1 || value === 2 || value === 3) {
          nextMode = `G${value}`;
        }
        if (value === 20) {
          unitScale = 25.4;
        }
        if (value === 21) {
          unitScale = 1;
        }
        if (value === 90) {
          absoluteMode = true;
        }
        if (value === 91) {
          absoluteMode = false;
        }
      }
      if (letter === "M") {
        if (value === 3 || value === 4) {
          laserOn = true;
        }
        if (value === 5) {
          laserOn = false;
          currentPolyline = null;
        }
      }
      if (letter === "X") {
        xValue = value;
      }
      if (letter === "Y") {
        yValue = value;
      }
      if (letter === "I") {
        iValue = value;
      }
      if (letter === "J") {
        jValue = value;
      }
    });

    if (xValue === null && yValue === null) {
      motionMode = nextMode;
      return;
    }

    const target = {
      x: xValue === null ? current.x : absoluteMode ? xValue * unitScale : current.x + xValue * unitScale,
      y: yValue === null ? current.y : absoluteMode ? yValue * unitScale : current.y + yValue * unitScale,
    };

    if (nextMode === "G1" && laserOn) {
      const start = denormalizePointFromMachine(current, machine);
      const end = denormalizePointFromMachine(target, machine);
      if (!currentPolyline) {
        currentPolyline = [start, end];
        polylines.push(currentPolyline);
      } else {
        const last = currentPolyline[currentPolyline.length - 1];
        if (Math.abs(last.x - start.x) > 0.001 || Math.abs(last.y - start.y) > 0.001) {
          currentPolyline.push(start);
        }
        currentPolyline.push(end);
      }
    } else if ((nextMode === "G2" || nextMode === "G3") && laserOn) {
      const isCW = nextMode === "G2";
      const start = current;
      const end = target;
      const center = { x: start.x + iValue * unitScale, y: start.y + jValue * unitScale };
      const radius = Math.sqrt((start.x - center.x) ** 2 + (start.y - center.y) ** 2);
      const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
      let endAngle = Math.atan2(end.y - center.y, end.x - center.x);

      if (isCW && endAngle >= startAngle) {
        endAngle -= 2 * Math.PI;
      }
      if (!isCW && endAngle <= startAngle) {
        endAngle += 2 * Math.PI;
      }

      const segments = Math.max(1, Math.min(64, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 16))));
      for (let s = 1; s <= segments; s += 1) {
        const ang = startAngle + (endAngle - startAngle) * (s / segments);
        const p = denormalizePointFromMachine(
          {
            x: center.x + radius * Math.cos(ang),
            y: center.y + radius * Math.sin(ang),
          },
          machine
        );
        if (!currentPolyline) {
          currentPolyline = [denormalizePointFromMachine(start, machine), p];
          polylines.push(currentPolyline);
        } else {
          currentPolyline.push(p);
        }
      }
    } else {
      currentPolyline = null;
    }

    current = target;
    motionMode = nextMode;
  });

  const cleaned = polylines.map((polyline) => dedupePolyline(polyline)).filter((polyline) => polyline.length > 1);

  if (!cleaned.length) {
    return { polylines: [], bounds: null };
  }

  const xs = cleaned.flatMap((polyline) => polyline.map((point) => point.x));
  const ys = cleaned.flatMap((polyline) => polyline.map((point) => point.y));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    polylines: cleaned,
    bounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      minX,
      minY,
      centerX: minX + (maxX - minX) / 2,
      centerY: minY + (maxY - minY) / 2,
    },
  };
}

function formatSvgNumber(value) {
  const rounded = Math.round((Number(value) || 0) * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function boundsFromPolylines(polylines) {
  const valid = (Array.isArray(polylines) ? polylines : []).filter(
    (polyline) => Array.isArray(polyline) && polyline.length
  );
  if (!valid.length) {
    return null;
  }
  const xs = valid.flatMap((polyline) => polyline.map((point) => point.x));
  const ys = valid.flatMap((polyline) => polyline.map((point) => point.y));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0.001, maxX - minX),
    height: Math.max(0.001, maxY - minY),
    minX,
    minY,
    centerX: minX + (maxX - minX) / 2,
    centerY: minY + (maxY - minY) / 2,
  };
}

export function buildSvgMarkupFromPolylines(
  polylines,
  { stroke = "#111111", fill = "none", strokeWidth = 1, opacity = 1 } = {}
) {
  return (Array.isArray(polylines) ? polylines : [])
    .filter((polyline) => Array.isArray(polyline) && polyline.length >= 2)
    .map((polyline) => {
      const cleaned = dedupePolyline(polyline);
      const closed = cleaned.length > 2 && pointsMatch(cleaned[0], cleaned[cleaned.length - 1], 0.001);
      const points = closed ? cleaned.slice(0, -1) : cleaned;
      const d = points
        .map((point, index) => `${index ? "L" : "M"} ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`)
        .join(" ");
      return `<path d="${d}${closed ? " Z" : ""}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" vector-effect="non-scaling-stroke" />`;
    })
    .join("");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(source) {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
  let match = pattern.exec(source);
  while (match) {
    attributes[match[1]] = decodeXmlEntities(match[3] ?? match[4] ?? match[5] ?? "");
    match = pattern.exec(source);
  }
  return attributes;
}

export function parseXmlLite(source) {
  const root = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tokens =
    String(source || "").match(
      /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>|[^<]+/g
    ) || [];

  tokens.forEach((token) => {
    if (!token) {
      return;
    }
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) {
      return;
    }
    if (token.startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += token.slice(9, -3);
      return;
    }
    if (token.startsWith("</")) {
      if (stack.length > 1) {
        stack.pop();
      }
      return;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/>$/.test(token);
      const body = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
      if (!body) {
        return;
      }
      const nameMatch = body.match(/^([A-Za-z_][\w:.-]*)/);
      if (!nameMatch) {
        return;
      }
      const node = {
        name: nameMatch[1],
        attributes: parseXmlAttributes(body.slice(nameMatch[0].length)),
        children: [],
        text: "",
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
      return;
    }
    const trimmed = token.trim();
    if (trimmed) {
      stack[stack.length - 1].text += decodeXmlEntities(trimmed);
    }
  });

  return root.children[0] || null;
}

function childNodesByName(node, name) {
  return (Array.isArray(node?.children) ? node.children : []).filter((child) => child.name === name);
}

export function descendantNodesByName(node, name) {
  const matches = [];
  (Array.isArray(node?.children) ? node.children : []).forEach((child) => {
    if (child.name === name) {
      matches.push(child);
    }
    matches.push(...descendantNodesByName(child, name));
  });
  return matches;
}

export function firstChildByName(node, name) {
  return childNodesByName(node, name)[0] || null;
}

export function childText(node, name, fallback = "") {
  const child = firstChildByName(node, name);
  if (child) {
    return String(child.text || "").trim();
  }
  if (node?.attributes && name in node.attributes) {
    return String(node.attributes[name]).trim();
  }
  return fallback;
}

export function childNumber(node, name, fallback = 0) {
  const text = childText(node, name, "");
  if (text === "") {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function applyMatrix(point, matrix) {
  return applyMatrixToPoint(point, matrix);
}

function parseMatrixText(value) {
  const numbers = String(value || "")
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  if (numbers.length >= 6) {
    return { a: numbers[0], b: numbers[1], c: numbers[2], d: numbers[3], e: numbers[4], f: numbers[5] };
  }
  return identityMatrix();
}

function sampleEllipse(rx, ry, segments = 48) {
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry };
  });
}

function samplePolygon(sides, rx, ry) {
  const count = Math.max(3, Math.round(sides) || 3);
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = ((index % count) / count) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry };
  });
}

function transformPolyline(polyline, matrix) {
  return polyline.map((point) => applyMatrix(point, matrix));
}

function parseVertexList(value) {
  return String(value || "")
    .split(/[|;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) =>
      entry
        .split(/[\s,]+/)
        .map(Number)
        .filter((part) => Number.isFinite(part))
    )
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ x: parts[0], y: parts[1] }));
}

function shapePolylines(shape, matrix, options = {}) {
  const type = String(shape.attributes.Type || childText(shape, "Type", ""))
    .trim()
    .toLowerCase();
  const localMatrix = multiplyMatrix(matrix, parseMatrixText(childText(shape, "XForm", "")));
  const recursiveShapes = childNodesByName(shape, "Shape");
  const descendantShapes = recursiveShapes.length ? recursiveShapes : descendantNodesByName(shape, "Shape");

  if (type === "group" || (!type && descendantShapes.length)) {
    return descendantShapes.flatMap((child) => shapePolylines(child, localMatrix, options));
  }

  if (type === "rect" || type === "rectangle") {
    const width = Math.max(0.001, childNumber(shape, "W", childNumber(shape, "Width", 0)));
    const height = Math.max(0.001, childNumber(shape, "H", childNumber(shape, "Height", 0)));
    return [
      transformPolyline(
        [
          { x: -width / 2, y: -height / 2 },
          { x: width / 2, y: -height / 2 },
          { x: width / 2, y: height / 2 },
          { x: -width / 2, y: height / 2 },
          { x: -width / 2, y: -height / 2 },
        ],
        localMatrix
      ),
    ];
  }

  if (type === "ellipse") {
    const rx = Math.max(0.001, childNumber(shape, "Rx", childNumber(shape, "R", 0)));
    const ry = Math.max(0.001, childNumber(shape, "Ry", rx));
    return [transformPolyline(sampleEllipse(rx, ry, options.ellipseSegments || 48), localMatrix)];
  }

  if (type === "polygon") {
    const sides = childNumber(shape, "N", childNumber(shape, "Sides", 6));
    const rx = Math.max(0.001, childNumber(shape, "Rx", childNumber(shape, "R", 0)));
    const ry = Math.max(0.001, childNumber(shape, "Ry", rx));
    return [transformPolyline(samplePolygon(sides, rx, ry), localMatrix)];
  }

  if (type === "line") {
    const vertices = parseVertexList(childText(shape, "VertList", ""));
    if (vertices.length >= 2) {
      return [transformPolyline(vertices, localMatrix)];
    }
  }

  if (type === "path" || type === "polyline" || type === "lines") {
    const vertices = parseVertexList(childText(shape, "VertList", ""));
    if (vertices.length >= 2) {
      const closed = String(childText(shape, "PrimList", ""))
        .toUpperCase()
        .includes("CLOSE");
      const polyline =
        closed && !pointsMatch(vertices[0], vertices[vertices.length - 1], 0.001)
          ? [...vertices, clonePoint(vertices[0])]
          : vertices;
      return [transformPolyline(polyline, localMatrix)];
    }
  }

  if (descendantShapes.length) {
    return descendantShapes.flatMap((child) => shapePolylines(child, localMatrix, options));
  }

  return [];
}

export function parseLightBurnGeometry(sourceText, options = {}) {
  const root = parseXmlLite(sourceText);
  if (!root) {
    throw new Error("The LightBurn file could not be parsed.");
  }
  const shapes = [];

  function visit(node, matrix = identityMatrix()) {
    if (!node) {
      return;
    }
    if (node.name === "Shape") {
      shapes.push(...shapePolylines(node, matrix, options));
      return;
    }
    childNodesByName(node, "Shape").forEach((child) => visit(child, matrix));
    (Array.isArray(node.children) ? node.children : [])
      .filter((child) => child.name !== "Shape")
      .forEach((child) => visit(child, matrix));
  }

  visit(root, identityMatrix());
  const polylines = shapes.map((polyline) => dedupePolyline(polyline)).filter((polyline) => polyline.length >= 2);
  return {
    polylines,
    bounds: boundsFromPolylines(polylines),
  };
}

export function stripLikelySvgBackgroundRect(markup, artworkBounds = null) {
  const text = String(markup || "").trim();
  const rectMatch = text.match(/^<rect\b([^>]*)\/?>$/i);
  if (!rectMatch) {
    return text;
  }
  const attrs = parseXmlAttributes(rectMatch[1] || "");
  if (attrs.stroke || attrs.transform) {
    return text;
  }
  const fill = String(attrs.fill || "")
    .trim()
    .toLowerCase();
  if (!["#fff", "#ffffff", "white", "rgb(255,255,255)", "rgb(255, 255, 255)"].includes(fill)) {
    return text;
  }
  const opacity = (Number(attrs.opacity ?? 1) || 1) * (Number(attrs["fill-opacity"] ?? 1) || 1);
  if (opacity < 0.99) {
    return text;
  }
  const x = Number(attrs.x ?? 0) || 0;
  const y = Number(attrs.y ?? 0) || 0;
  const width = Number(attrs.width ?? 0) || 0;
  const height = Number(attrs.height ?? 0) || 0;
  const minX = Number(artworkBounds?.minX ?? artworkBounds?.x ?? 0) || 0;
  const minY = Number(artworkBounds?.minY ?? artworkBounds?.y ?? 0) || 0;
  const boundsWidth = Number(artworkBounds?.width ?? 0) || 0;
  const boundsHeight = Number(artworkBounds?.height ?? 0) || 0;
  const tolerance = 0.02;
  const matchesBounds =
    Math.abs(x - minX) <= tolerance &&
    Math.abs(y - minY) <= tolerance &&
    Math.abs(width - boundsWidth) <= tolerance &&
    Math.abs(height - boundsHeight) <= tolerance;
  return matchesBounds ? "" : text;
}

function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function format(value) {
  return round(value, 3).toFixed(3);
}

function formatFeed(value) {
  return Math.round(value);
}

export function polylineLength(polyline) {
  let total = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    total += Math.hypot(polyline[index].x - polyline[index - 1].x, polyline[index].y - polyline[index - 1].y);
  }
  return total;
}

function pointDistance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function pointsMatch(a, b, tolerance) {
  return pointDistance(a, b) <= tolerance;
}

function clonePoint(point) {
  return { x: point.x, y: point.y };
}

function dedupePolyline(polyline) {
  return (Array.isArray(polyline) ? polyline : []).filter((point, index, points) => {
    if (!index) {
      return true;
    }
    const previous = points[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 0.001;
  });
}

function simplifyPolyline(polyline, tolerance = 0.001) {
  const input = Array.isArray(polyline) ? polyline : [];
  if (input.length <= 2) {
    return input.map(clonePoint);
  }
  const simplified = [clonePoint(input[0])];

  for (let index = 1; index < input.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = input[index];
    const next = input[index + 1];
    if (pointDistance(previous, current) <= tolerance) {
      continue;
    }
    const abx = current.x - previous.x;
    const aby = current.y - previous.y;
    const bcx = next.x - current.x;
    const bcy = next.y - current.y;
    const cross = Math.abs(abx * bcy - aby * bcx);
    const dot = abx * bcx + aby * bcy;
    if (cross <= tolerance && dot >= 0) {
      continue;
    }
    simplified.push(clonePoint(current));
  }

  const end = input[input.length - 1];
  if (!pointsMatch(simplified[simplified.length - 1], end, tolerance)) {
    simplified.push(clonePoint(end));
  }
  return simplified.length >= 2 ? simplified : input.map(clonePoint);
}

function mergePolylinePair(a, b, tolerance) {
  if (a.length < 2 || b.length < 2) {
    return null;
  }
  const aStart = a[0];
  const aEnd = a[a.length - 1];
  const bStart = b[0];
  const bEnd = b[b.length - 1];

  if (pointsMatch(aEnd, bStart, tolerance)) {
    return [...a, ...b.slice(1)];
  }
  if (pointsMatch(aEnd, bEnd, tolerance)) {
    return [...a, ...b.slice(0, -1).reverse()];
  }
  if (pointsMatch(aStart, bEnd, tolerance)) {
    return [...b, ...a.slice(1)];
  }
  if (pointsMatch(aStart, bStart, tolerance)) {
    return [...b.slice().reverse(), ...a.slice(1)];
  }
  return null;
}

export function optimizePolylines(polylines, { joinTolerance = 0.05, simplifyTolerance = 0.001 } = {}) {
  const queue = (Array.isArray(polylines) ? polylines : [])
    .filter((polyline) => Array.isArray(polyline) && polyline.length >= 2)
    .map((polyline) => simplifyPolyline(polyline, simplifyTolerance));
  const optimized = [];

  while (queue.length) {
    let current = queue.shift();
    let merged = true;
    while (merged) {
      merged = false;
      for (let index = 0; index < queue.length; index += 1) {
        const combined = mergePolylinePair(current, queue[index], joinTolerance);
        if (!combined) {
          continue;
        }
        current = simplifyPolyline(combined, simplifyTolerance);
        queue.splice(index, 1);
        merged = true;
        break;
      }
    }
    optimized.push(current);
  }

  return optimized;
}

function interpolatePoint(a, b, distanceFromA, segmentLength) {
  if (segmentLength <= 0) {
    return { x: a.x, y: a.y };
  }
  const ratio = distanceFromA / segmentLength;
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
  };
}

function slicePolylineByDistance(polyline, startDistance, endDistance) {
  if (!Array.isArray(polyline) || polyline.length < 2 || endDistance <= startDistance) {
    return [];
  }
  const points = [];
  let traveled = 0;

  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1];
    const b = polyline[index];
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    const segmentStart = traveled;
    const segmentEnd = traveled + segmentLength;
    if (segmentLength <= 0) {
      traveled = segmentEnd;
      continue;
    }
    if (segmentEnd < startDistance) {
      traveled = segmentEnd;
      continue;
    }
    if (segmentStart > endDistance) {
      break;
    }

    const localStart = Math.max(startDistance, segmentStart);
    const localEnd = Math.min(endDistance, segmentEnd);
    if (localStart > localEnd) {
      traveled = segmentEnd;
      continue;
    }

    const startPoint = interpolatePoint(a, b, localStart - segmentStart, segmentLength);
    const endPoint = interpolatePoint(a, b, localEnd - segmentStart, segmentLength);
    if (!points.length || points.at(-1).x !== startPoint.x || points.at(-1).y !== startPoint.y) {
      points.push(startPoint);
    }
    if (localEnd > localStart) {
      points.push(endPoint);
    }
    traveled = segmentEnd;
  }

  return points.length >= 2 ? points : [];
}

export function applyLineStyleToPolylines(polylines, operationLayer = {}) {
  const input = Array.isArray(polylines) ? polylines : [];
  if (operationLayer.mode === "fill" || operationLayer.lineStyle !== "dashed") {
    return input;
  }
  const dashLength = Math.max(0.1, Number(operationLayer.dashLength) || 3);
  const gapLength = Math.max(0, Number(operationLayer.gapLength) || 1);
  const cycleLength = dashLength + gapLength;
  if (cycleLength <= dashLength) {
    return input;
  }

  return input.flatMap((polyline) => {
    const total = polylineLength(polyline);
    if (total <= dashLength) {
      return [polyline];
    }
    const segments = [];
    for (let offset = 0; offset < total; offset += cycleLength) {
      const segment = slicePolylineByDistance(polyline, offset, Math.min(offset + dashLength, total));
      if (segment.length >= 2) {
        segments.push(segment);
      }
    }
    return segments.length ? segments : [polyline];
  });
}

export function buildFrameLines(bounds, machine) {
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y },
  ].map((point) => normalizePointForMachine(point, machine));

  return [
    "; Framing path",
    "G21",
    "G90",
    "M5",
    `G0 X${format(corners[0].x)} Y${format(corners[0].y)} F${formatFeed(machine.frameSpeed)}`,
    "M4 S1",
    ...corners.slice(1).map((point) => `G1 X${format(point.x)} Y${format(point.y)} F${formatFeed(machine.frameSpeed)}`),
    "M5",
  ];
}

export function buildGcodeFromPolylines({ machine, operationLayers, operations, previewOnly = false }) {
  const enabledOps = operationLayers.filter((layer) => layer.enabled);
  const hasGeometry = operations.some((entry) => entry.polylines.some((polyline) => polyline.length > 1));
  if (!enabledOps.length || !hasGeometry) {
    return "; No enabled geometry";
  }

  const lines = [];
  if (machine.jobHeader?.trim()) {
    lines.push(...machine.jobHeader.split("\n"));
  }
  if (machine.safeZ > 0) {
    lines.push(`G0 Z${format(machine.safeZ)}`);
  }

  enabledOps.forEach((operationLayer) => {
    const operation = operations.find((entry) => entry.operationLayer.id === operationLayer.id);
    if (!operation || !operation.polylines.length) {
      return;
    }
    lines.push(`; Operation: ${operationLayer.name}`);
    lines.push(
      `; Mode: ${operationLayer.mode} Feed: ${operationLayer.feed} Power: ${operationLayer.power}% Passes: ${operationLayer.passes}`
    );
    const powerValue = Math.round((operationLayer.power / 100) * machine.laserMax);
    for (let pass = 0; pass < operationLayer.passes; pass += 1) {
      lines.push(`; Pass ${pass + 1}`);
      if (machine.airAssist || operationLayer.airAssist) {
        lines.push("M8");
      }
      applyLineStyleToPolylines(operation.polylines, operationLayer).forEach((entry) => {
        const polyline = Array.isArray(entry) ? entry : entry.points;
        if (!polyline || polyline.length < 2) {
          return;
        }

        const brightness = entry.brightness || 0;
        const contrast = entry.contrast ?? 100;
        const effectivePower = Math.max(0, Math.min(100, (operationLayer.power * (contrast / 100)) + brightness));
        const polylinePowerValue = Math.round((effectivePower / 100) * machine.laserMax);

        const start = normalizePointForMachine(polyline[0], machine);
        lines.push("M5 ; Safety Off");
        lines.push(`G0 X${format(start.x)} Y${format(start.y)} F${formatFeed(machine.travelSpeed)}`);
        lines.push(`${operationLayer.constantPower ? "M3" : "M4"} S${polylinePowerValue}`);
        polyline.slice(1).forEach((point) => {
          const next = normalizePointForMachine(point, machine);
          lines.push(`G1 X${format(next.x)} Y${format(next.y)} F${formatFeed(operationLayer.feed)}`);
        });
        lines.push("M5");
      });
      if (machine.airAssist || operationLayer.airAssist) {
        lines.push("M9");
      }
    }
  });

  if (machine.jobFooter?.trim()) {
    lines.push(...machine.jobFooter.split("\n"));
  }
  if (!previewOnly) {
    lines.push("");
  }
  return lines.join("\n");
}

export function estimateJobFromPolylines({ machine, operationLayers, operations }) {
  let cutDistance = 0;
  let travelDistance = 0;
  let runtimeSeconds = 0;
  let currentPoint = { x: 0, y: 0 };

  operations.forEach((operation) => {
    if (!operation.operationLayer.enabled) {
      return;
    }
    applyLineStyleToPolylines(operation.polylines, operation.operationLayer).forEach((polyline) => {
      if (polyline.length < 2) {
        return;
      }
      const start = polyline[0];
      const lineDistance = polylineLength(polyline);
      const travel = Math.hypot(start.x - currentPoint.x, start.y - currentPoint.y);
      travelDistance += travel;
      runtimeSeconds += (travel / Math.max(machine.travelSpeed, 1)) * 60;
      cutDistance += lineDistance * operation.operationLayer.passes;
      runtimeSeconds +=
        ((lineDistance * operation.operationLayer.passes) / Math.max(operation.operationLayer.feed, 1)) * 60;
      currentPoint = polyline[polyline.length - 1];
    });
  });

  return {
    enabledLayers: operationLayers.filter((layer) => layer.enabled).length,
    cutDistance,
    travelDistance,
    runtimeSeconds,
  };
}
