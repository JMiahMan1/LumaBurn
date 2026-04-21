import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mockUsbModule } from "./m2nano_mock.mjs";

const require = createRequire(import.meta.url);

function resolveModules() {
  return {
    serverPath: require.resolve("../server.cjs"),
    m2nanoPath: require.resolve("../src/drivers/m2nano.cjs"),
  };
}

function loadServerFresh() {
  const { serverPath, m2nanoPath } = resolveModules();
  delete require.cache[serverPath];
  delete require.cache[m2nanoPath];
  delete globalThis.__lumaburnGrblDriverClass;
  delete globalThis.__lumaburnUsbMock;
  return require("../server.cjs");
}

function loadServerWithUsbMock() {
  const { serverPath, m2nanoPath } = resolveModules();
  delete require.cache[serverPath];
  delete require.cache[m2nanoPath];
  globalThis.__lumaburnUsbMock = mockUsbModule;
  return require("../server.cjs");
}

class MockGrblRasterDriver {
  constructor(path, baudRate) {
    this.path = path;
    this.baudRate = baudRate;
    this.isOpen = false;
    this.latestStatus = "Idle";
    this.pos = { x: 0, y: 0, z: 0 };
    this.commands = [];
    this.rasterRows = [];
    this.port = {
      on: () => {},
      close: (cb) => {
        if (cb) cb();
      },
    };
  }

  async open() {
    this.isOpen = true;
  }

  async write(data) {
    this.commands.push(data);
  }

  async command(cmd) {
    this.commands.push(cmd);
    return "ok";
  }

  async sendRasterRow(bitstring, stepSize, speed, powerScale, options = {}) {
    this.rasterRows.push({ bitstring, stepSize, speed, powerScale, options });
    return "ok";
  }

  async close() {
    this.isOpen = false;
  }
}

test("executeSerialRasterJob routes GRBL raster rows to the GRBL driver", async (t) => {
  const { SerialPort } = require("serialport");
  const origList = SerialPort.list;
  SerialPort.list = async () => [
    { path: "/dev/__grbl_raster__", vendorId: "1A86", productId: "7523", friendlyName: "Ray5 raster stub" },
  ];

  const server = loadServerFresh();
  globalThis.__lumaburnGrblDriverClass = MockGrblRasterDriver;
  const { executeSerialRasterJob, peekSerialConnectionForTests, clearSerialConnectionsForTests } = server;

  t.after(async () => {
    await clearSerialConnectionsForTests();
    SerialPort.list = origList;
    delete globalThis.__lumaburnGrblDriverClass;
    const { serverPath, m2nanoPath } = resolveModules();
    delete require.cache[serverPath];
    delete require.cache[m2nanoPath];
  });

  await executeSerialRasterJob(
    "USB_1a86_7523",
    {
      travelSpeed: 3000,
      speed: 1800,
      powerScale: 420,
      rows: [
        { startX: 10, y: 20, bitstring: "1010", stepX: 0.2, rowAdvance: -0.1, direction: "right" },
        { startX: 10.8, y: 19.9, bitstring: "0101", stepX: 0.2, rowAdvance: -0.1, direction: "left" },
      ],
    },
    115200,
    "grbl"
  );

  const conn = peekSerialConnectionForTests("USB_1a86_7523");
  assert.ok(conn && !conn.m2);
  assert.ok(conn.port.commands.includes("M5"));
  assert.ok(conn.port.commands.includes("G90"));
  assert.ok(conn.port.commands.some((cmd) => cmd.includes("G0 X10.000 Y20.000 F3000")));
  assert.equal(conn.port.rasterRows.length, 2);
  assert.deepEqual(conn.port.rasterRows[0], {
    bitstring: "1010",
    stepSize: 0.2,
    speed: 1800,
    powerScale: 420,
    options: { direction: "right", rowAdvance: -0.1 },
  });
});

test("executeSerialRasterJob routes OMTech raster rows through the M2Nano driver lifecycle", async (t) => {
  const server = loadServerWithUsbMock();
  const { executeSerialRasterJob, peekSerialConnectionForTests, clearSerialConnectionsForTests } = server;

  t.after(async () => {
    await clearSerialConnectionsForTests();
    delete globalThis.__lumaburnUsbMock;
    const { serverPath, m2nanoPath } = resolveModules();
    delete require.cache[serverPath];
    delete require.cache[m2nanoPath];
  });

  await executeSerialRasterJob(
    "USB_1a86_5512",
    {
      travelSpeed: 2400,
      speedMmPerSec: 20,
      powerPercent: 32,
      rows: [
        { startX: 5, y: 7, bitstring: "101", stepX: 4, rowAdvance: 4, direction: "right" },
        { startX: 17, y: 11, bitstring: "010", stepX: 4, rowAdvance: 4, direction: "left" },
      ],
    },
    115200,
    "lihuiyu"
  );

  const conn = peekSerialConnectionForTests("USB_1a86_5512");
  assert.ok(conn?.m2, "Expected M2Nano raster routing");
  assert.equal(conn.port.programModeActive, false, "Raster job should exit program mode after completion");
  assert.ok(conn.port.device.getPackets().length > 0, "Mock CH341 should receive raster packets");
});
