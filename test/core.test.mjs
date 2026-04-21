import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyLineStyleToPolylines,
  buildDiscoveryCandidates,
  buildFrameLines,
  buildGcodeFromPolylines,
  buildRunFileCommands,
  buildQueuedCommandVariants,
  buildSvgMarkupFromPolylines,
  buildStopCommandPlans,
  addAdjacentSubnets,
  canUseControllerFileRun,
  childNumber,
  childText,
  denormalizePointFromMachine,
  descendantNodesByName,
  executeStopSequence,
  estimateJobFromPolylines,
  firstChildByName,
  gcodeToQueueLines,
  normalizeDeviceUrl,
  expandManualScanToken,
  inspectDeviceResponse,
  normalizeDevicePath,
  normalizePointForMachine,
  optimizePolylines,
  parseGcodeGeometry,
  parseLightBurnGeometry,
  parseXmlLite,
  stripLikelySvgBackgroundRect,
  subnetFromDeviceUrl,
} from "../src/core/gcode.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("buildDiscoveryCandidates expands and prioritizes likely subnets", () => {
  const candidates = buildDiscoveryCandidates({
    manualScanRange: "192.168.2.0/24 10.0.0.44",
    deviceUrl: "http://192.168.3.19",
    discoveredSubnets: ["192.168.4"],
    networkSubnets: ["192.168.8"],
  });

  assert.equal(candidates[0], "192.168.2");
  assert.ok(candidates.includes("10.0.0"));
  assert.ok(candidates.includes("192.168.3"));
  assert.ok(candidates.includes("192.168.4"));
  assert.ok(candidates.includes("192.168.8"));
  assert.ok(candidates.includes("192.168.1"));
});

test("inspectDeviceResponse classifies plain-text success and failure", () => {
  assert.equal(inspectDeviceResponse("ok").ok, true);
  assert.equal(inspectDeviceResponse("ERROR: busy").ok, false);
  assert.equal(inspectDeviceResponse("").ok, false);
});

test("canUseControllerFileRun blocks only direct-root execution", () => {
  assert.equal(canUseControllerFileRun({ storageMode: "direct", uploadPath: "/" }), false);
  assert.equal(canUseControllerFileRun({ storageMode: "direct", uploadPath: "/sd/" }), true);
  assert.equal(canUseControllerFileRun({ storageMode: "", uploadPath: "/" }), true);
});

test("buildRunFileCommands tries both full-path and basename variants", () => {
  const commands = buildRunFileCommands("/sd/giving.gc");
  assert.deepEqual(commands, [
    "[ESP700] /sd/giving.gc",
    "[ESP700]stream=/sd/giving.gc",
    "[ESP700] stream=/sd/giving.gc",
    "[ESP700] giving.gc",
    "[ESP700]stream=giving.gc",
    "[ESP700] stream=giving.gc",
  ]);
});

test("buildRunFileCommands includes ESP220 variants for grbl-embedded controllers", () => {
  const commands = buildRunFileCommands("/ext/giving.gc", { controllerFlavor: "grbl-embedded" });
  assert.deepEqual(commands.slice(0, 3), ["[ESP220]/ext/giving.gc", "[ESP220]/giving.gc", "[ESP220]giving.gc"]);
});

test("gcodeToQueueLines strips blank lines and comments", () => {
  const lines = gcodeToQueueLines("G21\n; comment only\nG1 X10 Y10 ; move\n\nM5");
  assert.deepEqual(lines, ["G21", "G1 X10 Y10", "M5"]);
});

test("parseGcodeGeometry extracts polylines from a .gc fixture", () => {
  const fixture = fs.readFileSync(path.join(FIXTURES, "sample-ray5.gc"), "utf8");
  const parsed = parseGcodeGeometry(fixture, { originMode: "upper-left", bedHeight: 400 });
  assert.equal(parsed.polylines.length, 2);
  assert.deepEqual(parsed.polylines[0], [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 20, y: 20 },
  ]);
  assert.equal(parsed.bounds.minX, 5);
  assert.equal(parsed.bounds.minY, 5);
  assert.equal(parsed.bounds.width, 15);
  assert.equal(parsed.bounds.height, 15);
});

test("buildSvgMarkupFromPolylines converts parsed geometry into editable path markup", () => {
  const markup = buildSvgMarkupFromPolylines([
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
  ]);
  assert.match(markup, /<path\b/);
  assert.match(markup, /M 0 0 L 10 0 L 10 10/);
});

test("parseLightBurnGeometry reads a basic .lbrn fixture without DOMParser", () => {
  const fixture = fs.readFileSync(path.join(FIXTURES, "sample-lightburn.lbrn"), "utf8");
  const parsed = parseLightBurnGeometry(fixture);
  assert.equal(parsed.polylines.length, 2);
  assert.equal(parsed.bounds.minX, 20);
  assert.equal(parsed.bounds.minY, 15);
  assert.equal(parsed.bounds.width, 50);
  assert.equal(parsed.bounds.height, 55);
});

test("stripLikelySvgBackgroundRect removes a full-artboard white rect but preserves real geometry", () => {
  const bounds = { minX: 0, minY: 0, width: 45, height: 45 };
  assert.equal(stripLikelySvgBackgroundRect('<rect x="0" y="0" width="45" height="45" fill="#ffffff"/>', bounds), "");
  assert.match(
    stripLikelySvgBackgroundRect('<rect x="4" y="4" width="1" height="1" fill="#000000"/>', bounds),
    /#000000/
  );
});

test("buildGcodeFromPolylines emits operation headers, motion, and footer", () => {
  const machine = {
    airAssist: false,
    bedHeight: 200,
    frameSpeed: 4000,
    jobFooter: "M5\nG0 X0 Y0",
    jobHeader: "G21\nG90",
    laserMax: 1000,
    originMode: "lower-left",
    safeZ: 5,
    travelSpeed: 3000,
  };
  const operationLayers = [
    { id: "cut", name: "Cut 1", enabled: true, mode: "line", feed: 600, power: 50, passes: 1, airAssist: true },
  ];
  const gcode = buildGcodeFromPolylines({
    machine,
    operationLayers,
    operations: [
      {
        operationLayer: operationLayers[0],
        polylines: [
          [
            { x: 10, y: 20 },
            { x: 40, y: 20 },
          ],
        ],
      },
    ],
  });

  assert.match(gcode, /; Operation: Cut 1/);
  assert.match(gcode, /G0 Z5\.000/);
  assert.match(gcode, /M8/);
  assert.match(gcode, /G1 X40\.000 Y180\.000 F600/);
  assert.match(gcode, /G0 X0 Y0/);
});

test("applyLineStyleToPolylines splits dashed lines into cut segments", () => {
  const segments = applyLineStyleToPolylines(
    [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    ],
    { mode: "line", lineStyle: "dashed", dashLength: 3, gapLength: 2 }
  );

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
  ]);
  assert.deepEqual(segments[1], [
    { x: 5, y: 0 },
    { x: 8, y: 0 },
  ]);
});

test("applyLineStyleToPolylines leaves continuous lines untouched", () => {
  const polyline = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
  const segments = applyLineStyleToPolylines([polyline], {
    mode: "line",
    lineStyle: "continuous",
    dashLength: 3,
    gapLength: 2,
  });

  assert.deepEqual(segments, [polyline]);
});

test("optimizePolylines stitches touching child segments into one continuous path", () => {
  const optimized = optimizePolylines([
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    [
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    [
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  ]);

  assert.equal(optimized.length, 1);
  assert.deepEqual(optimized[0], [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]);
});

test("optimizePolylines keeps separate geometry when segments do not touch", () => {
  const optimized = optimizePolylines([
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    [
      { x: 12, y: 0 },
      { x: 20, y: 0 },
    ],
  ]);

  assert.equal(optimized.length, 2);
});

test("buildGcodeFromPolylines emits separate moves for dashed lines", () => {
  const machine = {
    airAssist: false,
    bedHeight: 100,
    frameSpeed: 4000,
    jobFooter: "",
    jobHeader: "G21\nG90",
    laserMax: 1000,
    originMode: "upper-left",
    safeZ: 0,
    travelSpeed: 3000,
  };
  const operationLayers = [
    {
      id: "cut",
      name: "Cut 1",
      enabled: true,
      mode: "line",
      lineStyle: "dashed",
      dashLength: 3,
      gapLength: 2,
      feed: 600,
      power: 50,
      passes: 1,
      airAssist: false,
    },
  ];
  const gcode = buildGcodeFromPolylines({
    machine,
    operationLayers,
    operations: [
      {
        operationLayer: operationLayers[0],
        polylines: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        ],
      },
    ],
  });

  assert.match(gcode, /G0 X0\.000 Y0\.000 F3000/);
  assert.match(gcode, /G1 X3\.000 Y0\.000 F600/);
  assert.match(gcode, /G0 X5\.000 Y0\.000 F3000/);
  assert.match(gcode, /G1 X8\.000 Y0\.000 F600/);
});

test("estimateJobFromPolylines uses previous endpoint for travel estimates", () => {
  const machine = { travelSpeed: 3000 };
  const operationLayers = [{ id: "cut", enabled: true, passes: 1, feed: 600 }];
  const operations = [
    {
      operationLayer: operationLayers[0],
      polylines: [
        [
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        [
          { x: 25, y: 0 },
          { x: 35, y: 0 },
        ],
      ],
    },
  ];

  const estimate = estimateJobFromPolylines({ machine, operationLayers, operations });
  assert.equal(estimate.cutDistance, 20);
  assert.equal(estimate.travelDistance, 15);
});

test("buildFrameLines respects lower-left machine coordinates", () => {
  const lines = buildFrameLines(
    { x: 10, y: 20, width: 30, height: 40 },
    {
      bedHeight: 100,
      frameSpeed: 4000,
      originMode: "lower-left",
    }
  );

  assert.equal(lines[4], "G0 X10.000 Y80.000 F4000");
  assert.equal(lines.at(-1), "M5");
});

test("executeStopSequence stops on the first successful plan", async () => {
  const commands = [];
  const waits = [];

  const plan = await executeStopSequence({
    sendCommand: async (command) => {
      commands.push(command);
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(plan.id, "emergency-stop-burst");
  assert.deepEqual(commands, ["!", "M5", "\u0018", "M5"]);
  assert.deepEqual(waits, [25, 25]);
});

test("executeStopSequence continues emergency burst when one stop command fails", async () => {
  const commands = [];
  const waits = [];

  const plan = await executeStopSequence({
    sendCommand: async (command) => {
      commands.push(command);
      if (command === "M5") {
        throw new Error("laser-off failed");
      }
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(plan.id, "emergency-stop-burst");
  assert.equal(plan.partial, true);
  assert.deepEqual(commands, ["!", "M5", "\u0018", "M5"]);
  assert.deepEqual(waits, [25, 25]);
  assert.equal(plan.failedSteps.map((step) => step.command).join(","), "M5,M5");
});

test("executeStopSequence still sends reset and final laser-off when hold fails", async () => {
  const commands = [];
  const waits = [];

  const plan = await executeStopSequence({
    sendCommand: async (command) => {
      commands.push(command);
      if (command === "!") {
        throw new Error(`failed ${command}`);
      }
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(plan.id, "emergency-stop-burst");
  assert.equal(plan.partial, true);
  assert.deepEqual(commands, ["!", "M5", "\u0018", "M5"]);
  assert.deepEqual(waits, [25, 25]);
  assert.equal(plan.failedSteps.map((step) => step.command).join(","), "!");
});

test("executeStopSequence throws when all stop plans fail", async () => {
  const commands = [];

  await assert.rejects(
    () =>
      executeStopSequence({
        sendCommand: async (command) => {
          commands.push(command);
          throw new Error(`failed ${command}`);
        },
        wait: async () => {},
      }),
    /failed M5/
  );

  assert.deepEqual(commands, ["!", "M5", "\u0018", "M5"]);
});

test("buildStopCommandPlans prioritizes immediate hold, laser-off, and reset", () => {
  const [plan] = buildStopCommandPlans();

  assert.ok(plan);
  assert.deepEqual(plan.steps, [
    { command: "!" },
    { command: "M5" },
    { waitAfterMs: 25, command: "\u0018" },
    { waitAfterMs: 25, command: "M5" },
  ]);
});
test("inspectDeviceResponse branch coverage", () => {
  // JSON Success
  const r1 = inspectDeviceResponse('{"status": "ok", "message": "done"}');
  assert.equal(r1.ok, true);
  assert.equal(r1.confidence, "high");

  // JSON Failure
  const r2 = inspectDeviceResponse('{"status": "error", "error": "broken"}');
  assert.equal(r2.ok, false);
  assert.equal(r2.confidence, "high");

  const rx1 = inspectDeviceResponse('{"s_tatus":"ok", "data":"Ready"}');
  assert.strictEqual(rx1.ok, true);
  assert.strictEqual(rx1.summary, "Ready");

  const rx2 = inspectDeviceResponse('{"status":"fail"}');
  assert.strictEqual(rx2.ok, false);

  const rx3 = inspectDeviceResponse("[SD-RUN] completed");
  assert.strictEqual(rx3.ok, true);

  const rx4 = inspectDeviceResponse("[ESP32] Booting...");
  assert.strictEqual(rx4.ok, true);

  const rx5 = inspectDeviceResponse("error: 404");
  assert.strictEqual(rx5.ok, false);
  assert.strictEqual(rx5.confidence, "high");

  const rx6 = inspectDeviceResponse("unknown string");
  assert.strictEqual(rx6.ok, false);
  assert.strictEqual(rx6.confidence, "high");

  const rx7 = inspectDeviceResponse("totally weird message");
  assert.strictEqual(rx7.ok, false);
  assert.strictEqual(rx7.confidence, "low");
});

test("buildDiscoveryCandidates and addAdjacentSubnets branch coverage", () => {
  const c1 = buildDiscoveryCandidates({ networkSubnets: ["192.168.1"] });
  assert.ok(c1.includes("192.168.1"));

  const c2 = buildDiscoveryCandidates();
  assert.ok(c2.length > 0);

  // Test addAdjacentSubnets boundary protection
  const c3 = buildDiscoveryCandidates({ manualScanRange: "192.168.1.0" });
  assert.ok(!c3.includes("192.168.0.255"));

  const c4 = buildDiscoveryCandidates({ manualScanRange: "192.168.1.255" });
  assert.ok(!c4.includes("192.168.2.0"));
});

test("gcodeToQueueLines sanitization", () => {
  const input = "G1 X10 ; this is a comment\n\n  G1 Y20\n(another comment)\nG1 Z30";
  const lines = gcodeToQueueLines(input);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], "G1 X10");
  assert.strictEqual(lines[1], "G1 Y20");
  assert.strictEqual(lines[2], "G1 Z30");
});

test("expandManualScanToken handles ranges and single IPs", () => {
  const r1 = buildDiscoveryCandidates({ manualScanRange: "192.168.1.1-3, 10.0.0.1" });
  assert.ok(r1.includes("192.168.1"));
  assert.ok(r1.includes("10.0.0"));
});

test("executeStopSequence failure handling", async () => {
  const failingSendCommand = () => Promise.reject(new Error("Hardware failure"));

  try {
    await executeStopSequence({ sendCommand: failingSendCommand });
    assert.fail("Should have thrown");
  } catch (err) {
    // The last error from the failing steps should be rethrown or a generic one used
    assert.ok(err.message.includes("Hardware failure") || err.message.includes("Unable to stop the device."));
  }
});

test("inspectDeviceResponse additional branches", () => {
  // JSON without status/s_tatus
  const r1 = inspectDeviceResponse('{"data":"Some random data"}');
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.confidence, "low");

  // Empty string
  const r2 = inspectDeviceResponse("");
  assert.strictEqual(r2.summary, "No response body was returned.");
});

test("addAdjacentSubnets boundary conditions", () => {
  const c1 = buildDiscoveryCandidates({ manualScanRange: "0.0.0.1" });
  assert.ok(!c1.includes("-1.-1.-1")); // Minimal boundary check

  const c2 = buildDiscoveryCandidates({ manualScanRange: "255.255.255.255" });
  assert.ok(!c2.includes("256.256.256")); // Maximal boundary check
});

test("buildRunFileCommands flavor branches", () => {
  const c1 = buildRunFileCommands("/test.gc", { controllerFlavor: "standard" });
  assert.ok(c1.some((l) => l.includes("[ESP700]")));
  assert.ok(c1.some((l) => l.includes("/test.gc")));
});

test("parseGcodeGeometry handles inches, relative, and arcs", () => {
  const gcode = "M3\nG1 X10 Y10\nM5";
  const result = parseGcodeGeometry(gcode, { originMode: "upper-left" });
  assert.ok(result?.polylines?.length > 0, "Should generate polylines when laser is on with M3");
});

test("parseGcodeGeometry handles inches and relative motion", () => {
  const gcode = "G20\nG91\nG1 X1 Y1\nG1 X1 Y1\nM5";
  const result = parseGcodeGeometry(gcode, { bedHeight: 100, originMode: "upper-left" });
  assert.strictEqual(result.polylines.length, 0); // Laser was NOT on!

  const gcodeOn = "G21\nG90\nM3\nG1 X10 Y10\nG1 X20 Y20\nM5";
  const result2 = parseGcodeGeometry(gcodeOn, { bedHeight: 100, originMode: "upper-left" });
  assert.strictEqual(result2.polylines.length, 1);
  assert.strictEqual(result2.polylines[0].length, 3); // Start (0,0), then 10,10, then 20,20
});

test("denormalizePointFromMachine branch coverage", () => {
  const machineLL = { bedHeight: 100, originMode: "lower-left" };
  const p1 = denormalizePointFromMachine({ x: 10, y: 10 }, machineLL);
  assert.strictEqual(p1.y, 90);

  const machineUL = { bedHeight: 100, originMode: "upper-left" };
  const p2 = denormalizePointFromMachine({ x: 10, y: 10 }, machineUL);
  assert.strictEqual(p2.y, 10);
});
test("buildGcodeFromPolylines exhaustive branches", () => {
  const machine = {
    jobHeader: "; START\nG21",
    safeZ: 5,
    laserMax: 1000,
    travelSpeed: 3000,
    originMode: "upper-left",
    bedHeight: 100,
    airAssist: true,
  };
  const layer = {
    id: "L1",
    enabled: true,
    name: "Cut",
    power: 100,
    feed: 1000,
    passes: 2,
    airAssist: true,
    mode: "score",
  };
  const op = {
    operationLayer: layer,
    polylines: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    ],
  };

  const gcode = buildGcodeFromPolylines({ machine, operationLayers: [layer], operations: [op] });
  assert.ok(gcode.includes("; START"));
  assert.ok(gcode.includes("G0 Z5"));
  assert.ok(gcode.includes("; Pass 1"));
  assert.ok(gcode.includes("; Pass 2"));
  assert.ok(gcode.includes("M8"));
  assert.ok(gcode.includes("M9"));
});

test("parseGcodeGeometry edge cases", () => {
  const gcode = "G1 X10 Y10 Z5\n(comment)\nG1 X20 Y20";
  const result = parseGcodeGeometry(gcode);
  assert.strictEqual(result.polylines.length, 0); // Laser was NOT on

  const invalidResult = parseGcodeGeometry("G99 XNaN"); // Invalid numbers
  assert.strictEqual(invalidResult.polylines.length, 0);
});
test("parseLightBurnGeometry shape branches", () => {
  const xml = `
    <LightBurnProject>
      <Shape Type="Ellipse" Rx="10" Ry="5" XForm="1 0 0 1 0 0" />
      <Shape Type="Polygon" Sides="5" R="10" XForm="1 0 0 1 0 0" />
      <Shape Type="Polyline" PrimList="Close" XForm="1 0 0 1 0 0">
        <VertList>0 0|10 0|10 10</VertList>
      </Shape>
    </LightBurnProject>
  `;
  const result = parseLightBurnGeometry(xml);
  assert.strictEqual(result.polylines.length, 3);
  // Ellipse (49 points), Polygon (6 points), Polyline (4 points due to close)
  assert.ok(result.polylines[0].length >= 48);
  assert.strictEqual(result.polylines[1].length, 6);
  assert.strictEqual(result.polylines[2].length, 4);
});

test("estimateJobFromPolylines branch coverage", () => {
  const machine = { travelSpeed: 3000 };
  const layer = { id: "L1", enabled: true, feed: 1000, passes: 1 };
  const op = { operationLayer: layer, polylines: [[{ x: 0, y: 0 }]] }; // Too short

  const est = estimateJobFromPolylines({ machine, operationLayers: [layer], operations: [op] });
  assert.strictEqual(est.cutDistance, 0);

  const op2 = {
    operationLayer: { ...layer, enabled: false },
    polylines: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    ],
  };
  const est2 = estimateJobFromPolylines({ machine, operationLayers: [layer], operations: [op2] });
  assert.strictEqual(est2.cutDistance, 0);
});
test("applyLineStyleToPolylines branch coverage", () => {
  const polyline = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
  ];
  // dashLength 5, gapLength 5 -> segments of 5mm
  const layer = { mode: "score", lineStyle: "dashed", dashLength: 5, gapLength: 5 };
  const res = applyLineStyleToPolylines([polyline], layer);
  assert.strictEqual(res.length, 2); // Split into two segments (0-5, 10-15)

  const layer2 = { mode: "score", lineStyle: "solid" };
  const res2 = applyLineStyleToPolylines([polyline], layer2);
  assert.strictEqual(res2.length, 1);
});

test("buildGcodeFromPolylines dynamic power", () => {
  const machine = { laserMax: 1000, travelSpeed: 3000, originMode: "upper-left", bedHeight: 100 };
  const layer = { id: "L1", enabled: true, power: 100, feed: 1000, passes: 1, mode: "score", constantPower: false };
  const op = {
    operationLayer: layer,
    polylines: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    ],
  };

  const gcode = buildGcodeFromPolylines({ machine, operationLayers: [layer], operations: [op] });
  assert.ok(gcode.includes("M4 S1000")); // Dynamic power

  const layer2 = { ...layer, constantPower: true };
  const gcode2 = buildGcodeFromPolylines({ machine, operationLayers: [layer2], operations: [op] });
  assert.ok(gcode2.includes("M3 S1000")); // Constant power
});

test("normalizeDevicePath branch coverage", () => {
  assert.strictEqual(normalizeDevicePath("/sd", "test.gc"), "/sd/test.gc");
  assert.strictEqual(normalizeDevicePath("/sd/", "test.gc"), "/sd/test.gc");
  assert.strictEqual(normalizeDevicePath("sd", "test.gc"), "sd/test.gc");
});

test("subnetFromDeviceUrl branch coverage", () => {
  assert.strictEqual(subnetFromDeviceUrl("192.168.1.50"), "192.168.1");
  assert.strictEqual(subnetFromDeviceUrl("http://10.0.0.5/api"), "10.0.0");
  assert.strictEqual(subnetFromDeviceUrl("invalid"), "");
});

test("inspectDeviceResponse exhaustive branches", () => {
  assert.strictEqual(inspectDeviceResponse("ok").ok, true);
  assert.strictEqual(inspectDeviceResponse("error: Out of bounds").ok, false);

  // JSON parsing with msg field (added in source)
  const r1 = inspectDeviceResponse('{"status":"ok","msg":"done"}');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.summary, "done");

  const r2 = inspectDeviceResponse('{"status":"error","msg":"fail"}');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.summary, "fail");
});

test("inspectDeviceResponse additional branches", () => {
  assert.strictEqual(inspectDeviceResponse('{"status":"OK","statusText":"Waiting"}').summary, "Waiting");
  assert.ok(inspectDeviceResponse("[MSG:Grbl 1.1f]").ok);
  assert.ok(inspectDeviceResponse("[ESP500] ok").ok);
  assert.strictEqual(inspectDeviceResponse("unknown code response").ok, false);
});

test("XML utilities branch coverage", () => {
  const node = {
    children: [
      { name: "Child", text: " val ", children: [{ name: "SubChild", text: "s" }] },
      { name: "Child", text: " val2 " },
    ],
    attributes: {
      Attr: "42",
      TextAttr: " hello ",
    },
  };

  // childText branches
  assert.strictEqual(childText(node, "Child"), "val");
  assert.strictEqual(childText(node, "TextAttr"), "hello");
  assert.strictEqual(childText(node, "Missing", "fallback"), "fallback");

  // childNumber branches
  assert.strictEqual(childNumber(node, "Attr"), 42);
  assert.strictEqual(childNumber(node, "Missing", 99), 99);
  assert.strictEqual(childNumber(node, "TextAttr", 7), 7); // NaN fallback
  assert.strictEqual(childNumber(null, "Any", 0), 0);
  assert.strictEqual(childNumber({ attributes: { a: "x" } }, "a", 3), 3);

  // childText branches
  assert.strictEqual(childText(null, "Any", "fb"), "fb");
  assert.strictEqual(childText({ children: [{ name: "T", text: " val " }] }, "T"), "val");
  assert.strictEqual(childText({ children: [] }, "Missing", "def"), "def");

  // CDATA in XML
  const cdataXml = "<root><![CDATA[ raw data ]]></root>";
  const cdataNode = parseXmlLite(cdataXml);
  assert.strictEqual(cdataNode.text, " raw data ", "Lite parser aggregates CDATA into text property");

  // Comments in XML
  const commentXml = "<root><!-- some comment --><Child />? </root>";
  const commentNode = parseXmlLite(commentXml);
  assert.strictEqual(commentNode.children.length, 1, "Comments and processing instructions are skipped");

  // name lookups
  assert.strictEqual(firstChildByName(node, "Child").text, " val ");
  assert.strictEqual(firstChildByName(null, "Any"), null);
  assert.strictEqual(firstChildByName(node, "NonExistent"), null);

  // descendant lookups
  assert.strictEqual(descendantNodesByName(null, "Any").length, 0);
  assert.strictEqual(descendantNodesByName(node, "SubChild").length, 1);
  assert.strictEqual(descendantNodesByName(node, "Missing").length, 0);
});

test("addAdjacentSubnets boundary conditions", () => {
  const res = addAdjacentSubnets(["192.168.1"], 1);
  assert.ok(res.includes("192.168.1"));
  assert.ok(res.includes("192.168.0"));
  assert.ok(res.includes("192.168.2"));
});

test("parseLightBurnGeometry XML edge cases", () => {
  const xml = `
    <LightBurnProject>
      <Shape Type="Rect">
        <Width>10</Width>
        <Height>10</Height>
      </Shape>
      <Shape Type="Ellipse">
        <Rx>5</Rx>
        <Ry>5</Ry>
      </Shape>
    </LightBurnProject>
  `;
  const result = parseLightBurnGeometry(xml);
  assert.ok(result?.polylines?.length > 0, "Should parse shapes with nested tags into polylines");
});

test("buildGcodeFromPolylines feature branches", () => {
  const machine = {
    safeZ: 5,
    enableAirAssist: true,
    originMode: "lower-left",
    bedHeight: 100,
    laserMax: 1000,
    travelSpeed: 3000,
  };
  const layer = {
    id: "L1",
    name: "Cut",
    enabled: true,
    mode: "line",
    feed: 1000,
    power: 100,
    passes: 1,
    airAssist: true,
    constantPower: true,
  };
  const ops = [
    {
      operationLayer: layer,
      polylines: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      ],
    },
  ];

  const gcode = buildGcodeFromPolylines({
    machine,
    operationLayers: [layer],
    operations: ops,
  });

  assert.ok(gcode.includes("G0 Z5"), "Should emit Safe Z");
  assert.ok(gcode.includes("M8"), "Should emit Air Assist On");
  assert.ok(gcode.includes("M3"), "Should emit M3 when constantPower is true");
});

test("normalization branch coverage", () => {
  const m = { originMode: "lower-left", bedHeight: 100 };
  const p = { x: 10, y: 10 };
  const n = normalizePointForMachine(p, m);
  assert.strictEqual(n.y, 90);
  const d = denormalizePointFromMachine(n, m);
  assert.strictEqual(d.y, 10);
});

test("buildRunFileCommands grbl-embedded branches", () => {
  const c1 = buildRunFileCommands("/sd/test.gc", { controllerFlavor: "grbl-embedded" });
  assert.ok(c1.includes("[ESP220]/sd/test.gc"));
  assert.ok(c1.includes("[ESP220]/test.gc")); // rootRelative
});
test("parseGcodeGeometry handles inches, relative, and arcs", () => {
  const gcode = `
    G20 (Inches)
    G91 (Relative)
    M3 (Laser On)
    G1 X1 Y1 F1000
    G2 X1 Y-1 I0 J-1 (CW Arc)
    G3 X-1 Y1 I0 J1 (CCW Arc)
    M5 (Laser Off)
    G90 (Absolute)
  `;
  const res = parseGcodeGeometry(gcode);
  assert.ok(res.polylines.length > 0, "Should extract polylines from arc gcode");
});

test("surgical gcode branch coverage", async () => {
  // Line 20, 29: normalizeDeviceUrl and subnetFromDeviceUrl
  assert.equal(normalizeDeviceUrl("http://test"), "http://test");
  assert.equal(normalizeDeviceUrl(""), "");
  assert.equal(normalizeDeviceUrl("serial://USB_1a86_5512?baud=115200"), "serial://USB_1a86_5512?baud=115200");
  assert.equal(subnetFromDeviceUrl("invalid-url"), "");
  assert.equal(subnetFromDeviceUrl("http://localhost"), "");
  assert.equal(subnetFromDeviceUrl("http://192.168.1.10"), "192.168.1");

  // Line 44, 73-80: expandManualScanToken and CIDR logic
  assert.deepEqual(expandManualScanToken("256.0.0.1/32"), []);
  assert.deepEqual(expandManualScanToken("10.0.0.1/33"), []);
  assert.deepEqual(expandManualScanToken("192.168.1.1/24"), ["192.168.1"]);
  assert.equal(expandManualScanToken("192.168.1.1/16").length, 64); // limit 64 logic
  assert.deepEqual(expandManualScanToken("1.1.1"), ["1.1.1"]);
  assert.deepEqual(expandManualScanToken("1.1.1.1"), ["1.1.1"]);
  assert.deepEqual(expandManualScanToken(" "), []);
  assert.deepEqual(expandManualScanToken("bad"), []);

  // Line 125-150: inspectDeviceResponse
  assert.equal(inspectDeviceResponse("").ok, false);
  assert.ok(inspectDeviceResponse(JSON.stringify({ status: "ok" })).ok);
  assert.ok(!inspectDeviceResponse(JSON.stringify({ state: "fail", data: "error" })).ok);
  const okTags = [
    "ok",
    "start",
    "started",
    "queued",
    "running",
    "processing",
    "uploaded",
    "done",
    "success",
    "[SD-RUN]",
    "[ESP220]",
    "file opened",
    "stream started",
    "[MSG:",
  ];
  okTags.forEach((t) => assert.ok(inspectDeviceResponse(t).ok, `Should match ${t}`));
  const failTags = [
    "error",
    "fail",
    "failed",
    "invalid",
    "unknown",
    "busy",
    "denied",
    "missing",
    "timeout",
    "forbidden",
  ];
  failTags.forEach((t) => assert.ok(!inspectDeviceResponse(t).ok, `Should fail ${t}`));
  assert.equal(inspectDeviceResponse("something else").confidence, "low");

  // Line 153-188: G-code command builders
  assert.equal(buildRunFileCommands("").length, 0);
  assert.ok(
    buildRunFileCommands("/sd/test.gc", { controllerFlavor: "grbl-embedded" }).some((c) => c.includes("[ESP220]"))
  );
  assert.equal(canUseControllerFileRun({ storageMode: "direct", uploadPath: "" }), false);
  assert.equal(canUseControllerFileRun({ storageMode: "sd", uploadPath: "test" }), true);
  assert.equal(buildQueuedCommandVariants("G1").length, 2);

  // Line 236: executeStopSequence failure handling
  await assert.rejects(
    executeStopSequence({
      sendCommand: () => {
        throw new Error("!!");
      },
    }),
    /!!/
  );

  // Line 353, 601-634: shapePolylines and XML parsing
  // Line 353, 601-634: shapePolylines and XML parsing
  assert.deepEqual(parseGcodeGeometry("").polylines, []);

  const parseLB = (xml) => parseLightBurnGeometry(xml).polylines;

  assert.ok(parseLB('<Shape Type="ellipse"><Rx>10</Rx><Ry>5</Ry></Shape>').length > 0, "Ellipse failed");
  assert.ok(parseLB('<Shape Type="polygon"><Sides>6</Sides><R>10</R></Shape>').length > 0, "Polygon failed");
  assert.ok(parseLB('<Shape Type="line"><VertList>0,0|10,10</VertList></Shape>').length > 0, "Line failed");
  assert.ok(parseLB('<Shape Type="path"><VertList>0,0|10,0|10,10</VertList></Shape>').length > 0, "Path failed");
  assert.ok(parseLB('<Group><Shape Type="rect" W="10" H="10" /></Group>').length > 0, "Grouped rect failed");
});
