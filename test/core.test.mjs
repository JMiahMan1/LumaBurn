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
  buildSvgMarkupFromPolylines,
  buildStopCommandPlans,
  canUseControllerFileRun,
  executeStopSequence,
  estimateJobFromPolylines,
  gcodeToQueueLines,
  inspectDeviceResponse,
  optimizePolylines,
  parseGcodeGeometry,
  parseLightBurnGeometry,
  stripLikelySvgBackgroundRect,
} from "../lumaburn-core.mjs";

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
  assert.deepEqual(commands.slice(0, 3), [
    "[ESP220]/ext/giving.gc",
    "[ESP220]/giving.gc",
    "[ESP220]giving.gc",
  ]);
});

test("gcodeToQueueLines strips blank lines and comments", () => {
  const lines = gcodeToQueueLines("G21\n; comment only\nG1 X10 Y10 ; move\n\nM5");
  assert.deepEqual(lines, ["G21", "G1 X10 Y10", "M5"]);
});

test("parseGcodeGeometry extracts polylines from a .gc fixture", () => {
  const fixture = fs.readFileSync(path.join(FIXTURES, "sample-ray5.gc"), "utf8");
  const parsed = parseGcodeGeometry(fixture, { originMode: "upper-left", bedHeight: 400 });
  assert.equal(parsed.polylines.length, 2);
  assert.deepEqual(parsed.polylines[0], [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }]);
  assert.equal(parsed.bounds.minX, 5);
  assert.equal(parsed.bounds.minY, 5);
  assert.equal(parsed.bounds.width, 15);
  assert.equal(parsed.bounds.height, 15);
});

test("buildSvgMarkupFromPolylines converts parsed geometry into editable path markup", () => {
  const markup = buildSvgMarkupFromPolylines([
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
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
  assert.match(stripLikelySvgBackgroundRect('<rect x="4" y="4" width="1" height="1" fill="#000000"/>', bounds), /#000000/);
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
    operations: [{
      operationLayer: operationLayers[0],
      polylines: [[{ x: 10, y: 20 }, { x: 40, y: 20 }]],
    }],
  });

  assert.match(gcode, /; Operation: Cut 1/);
  assert.match(gcode, /G0 Z5\.000/);
  assert.match(gcode, /M8/);
  assert.match(gcode, /G1 X40\.000 Y180\.000 F600/);
  assert.match(gcode, /G0 X0 Y0/);
});

test("applyLineStyleToPolylines splits dashed lines into cut segments", () => {
  const segments = applyLineStyleToPolylines(
    [[{ x: 0, y: 0 }, { x: 10, y: 0 }]],
    { mode: "line", lineStyle: "dashed", dashLength: 3, gapLength: 2 },
  );

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], [{ x: 0, y: 0 }, { x: 3, y: 0 }]);
  assert.deepEqual(segments[1], [{ x: 5, y: 0 }, { x: 8, y: 0 }]);
});

test("applyLineStyleToPolylines leaves continuous lines untouched", () => {
  const polyline = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const segments = applyLineStyleToPolylines(
    [polyline],
    { mode: "line", lineStyle: "continuous", dashLength: 3, gapLength: 2 },
  );

  assert.deepEqual(segments, [polyline]);
});

test("optimizePolylines stitches touching child segments into one continuous path", () => {
  const optimized = optimizePolylines([
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 10, y: 0 }, { x: 10, y: 10 }],
    [{ x: 10, y: 10 }, { x: 0, y: 10 }],
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
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 12, y: 0 }, { x: 20, y: 0 }],
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
    { id: "cut", name: "Cut 1", enabled: true, mode: "line", lineStyle: "dashed", dashLength: 3, gapLength: 2, feed: 600, power: 50, passes: 1, airAssist: false },
  ];
  const gcode = buildGcodeFromPolylines({
    machine,
    operationLayers,
    operations: [{
      operationLayer: operationLayers[0],
      polylines: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]],
    }],
  });

  assert.match(gcode, /G0 X0\.000 Y0\.000 F3000/);
  assert.match(gcode, /G1 X3\.000 Y0\.000 F600/);
  assert.match(gcode, /G0 X5\.000 Y0\.000 F3000/);
  assert.match(gcode, /G1 X8\.000 Y0\.000 F600/);
});

test("estimateJobFromPolylines uses previous endpoint for travel estimates", () => {
  const machine = { travelSpeed: 3000 };
  const operationLayers = [
    { id: "cut", enabled: true, passes: 1, feed: 600 },
  ];
  const operations = [{
    operationLayer: operationLayers[0],
    polylines: [
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      [{ x: 25, y: 0 }, { x: 35, y: 0 }],
    ],
  }];

  const estimate = estimateJobFromPolylines({ machine, operationLayers, operations });
  assert.equal(estimate.cutDistance, 20);
  assert.equal(estimate.travelDistance, 15);
});

test("buildFrameLines respects lower-left machine coordinates", () => {
  const lines = buildFrameLines({ x: 10, y: 20, width: 30, height: 40 }, {
    bedHeight: 100,
    frameSpeed: 4000,
    originMode: "lower-left",
  });

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
      if (command === "M5") throw new Error("laser-off failed");
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
      if (command === "!") throw new Error(`failed ${command}`);
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
    () => executeStopSequence({
      sendCommand: async (command) => {
        commands.push(command);
        throw new Error(`failed ${command}`);
      },
      wait: async () => {},
    }),
    /failed M5/,
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
