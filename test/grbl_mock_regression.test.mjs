/**
 * Regression tests for GRBL serial routing (Longer Ray5 / CH340 1a86:7523, etc.):
 * - hardware VID:PID decides M2 vs GRBL, not URL protocol=lihuiyu alone
 * - optional mock GRBL driver for CI without a real laser
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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

/** Drop-in for GRBLDriver when `globalThis.__lumaburnGrblDriverClass` is set. */
class MockGrblDriver {
  constructor(path, baudRate) {
    this.path = path;
    this.baudRate = baudRate;
    this.isOpen = false;
    this.latestStatus = "Idle";
    this.pos = { x: 0, y: 0, z: 0 };
    this.writes = [];
    this.commands = [];
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
    this.writes.push(data);
  }

  async command(cmd) {
    this.commands.push(cmd);
    return "ok";
  }

  async close() {
    this.isOpen = false;
  }
}

test("classifySerialHardware: Ray5 CH340 (1a86:7523) is never M2Nano", () => {
  const { classifySerialHardware } = loadServerFresh();
  const ports = [{ path: "/dev/ttyUSB77", vendorId: "1A86", productId: "7523", friendlyName: "CH340" }];
  assert.equal(classifySerialHardware("/dev/ttyUSB77", ports).isM2Nano, false);
  const usb = classifySerialHardware("USB_1a86_7523", ports);
  assert.equal(usb.isM2Nano, false);
  assert.equal(usb.matchedPort?.path, "/dev/ttyUSB77");
});

test("classifySerialHardware: K40 CH341 (1a86:5512) is M2Nano", () => {
  const { classifySerialHardware } = loadServerFresh();
  const ports = [{ path: "/dev/ttyK40", vendorId: "1A86", productId: "5512" }];
  assert.equal(classifySerialHardware("/dev/ttyK40", ports).isM2Nano, true);
  assert.equal(classifySerialHardware("USB_1a86_5512", ports).isM2Nano, true);
});

test("buildUsbDiscoveryDevices: single listing for enumerated 1a86:7523 + matching lsusb", () => {
  const { buildUsbDiscoveryDevices } = loadServerFresh();
  const activePorts = [
    { path: "/dev/ttyACM0", vendorId: "1A86", productId: "7523", friendlyName: "USB-Enhanced-SERIAL CH340" },
  ];
  const devices = buildUsbDiscoveryDevices(activePorts, "linux", "Bus 001 Device 004: ID 1a86:7523 QinHeng CH340");
  assert.equal(devices.filter((d) => d.path === "/dev/ttyACM0").length, 1, "One row per enumerated GRBL serial device");
  assert.equal(
    devices.some((d) => d.path === "USB_1a86_7523"),
    false,
    "No synthetic USB_1a86_7523 row (not part of discovery contract)"
  );
});

test("GRBL stack: USB_1a86_7523 routes commands through mock driver even with protocol=lihuiyu", async (t) => {
  const { SerialPort } = require("serialport");
  const origList = SerialPort.list;
  SerialPort.list = async () => [
    { path: "/dev/__grbl_stub__", vendorId: "1A86", productId: "7523", friendlyName: "Ray5 stub" },
  ];

  const server = loadServerFresh();
  // Register mock after reload: `loadServerFresh` clears this global by design.
  globalThis.__lumaburnGrblDriverClass = MockGrblDriver;
  const { executeSerialCommand, peekSerialConnectionForTests, clearSerialConnectionsForTests } = server;

  t.after(async () => {
    await clearSerialConnectionsForTests();
    SerialPort.list = origList;
    delete globalThis.__lumaburnGrblDriverClass;
    const { serverPath, m2nanoPath } = resolveModules();
    delete require.cache[serverPath];
    delete require.cache[m2nanoPath];
  });

  await executeSerialCommand("USB_1a86_7523", "G91", 115200, "lihuiyu");
  const conn = peekSerialConnectionForTests("USB_1a86_7523");
  assert.ok(conn && !conn.m2, "Expected GRBL connection, not M2Nano");
  const drv = conn.port;
  assert.ok(drv.commands.includes("G91"), "Mock GRBL should receive G91 (not M2 binary path)");

  await executeSerialCommand("USB_1a86_7523", "G0 X1 F3000", 115200, "lihuiyu");
  assert.ok(
    drv.commands.some((c) => String(c).includes("G0")),
    "Follow-up motion should use GRBL command()"
  );

  await clearSerialConnectionsForTests();
});
