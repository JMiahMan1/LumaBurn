/**
 * Regression tests for OMTech K40 / M2Nano (1a86:5512):
 * - discovery must not list both a real tty and the synthetic USB_1a86_5512 alias
 * - serial commands for USB_1a86_5512 must reach the M2 stack (mock CH341), not a no-op shim
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mockUsbModule } from "./m2nano_mock.mjs";

const require = createRequire(import.meta.url);

function resolveServerModules() {
  return {
    serverPath: require.resolve("../server.cjs"),
    m2nanoPath: require.resolve("../src/drivers/m2nano.cjs"),
  };
}

function loadServerWithUsbMock() {
  const { serverPath, m2nanoPath } = resolveServerModules();
  delete require.cache[serverPath];
  delete require.cache[m2nanoPath];
  globalThis.__lumaburnUsbMock = mockUsbModule;
  return require("../server.cjs");
}

function loadServerWithoutUsbMock() {
  const { serverPath, m2nanoPath } = resolveServerModules();
  delete require.cache[serverPath];
  delete require.cache[m2nanoPath];
  delete globalThis.__lumaburnUsbMock;
  return require("../server.cjs");
}

test("buildUsbDiscoveryDevices: no synthetic USB_1a86_5512 when 1a86:5512 serial port exists", () => {
  const { buildUsbDiscoveryDevices } = loadServerWithoutUsbMock();
  const activePorts = [{ path: "/dev/ttyUSB0", vendorId: "1A86", productId: "5512", friendlyName: "USB-Serial CH341" }];
  const lsusb = "Bus 001 Device 002: ID 1a86:5512 QinHeng Electronics CH341 in EEPROM mode, UART";
  const devices = buildUsbDiscoveryDevices(activePorts, "linux", lsusb);
  const synthetic = devices.filter((d) => d.path === "USB_1a86_5512");
  assert.equal(synthetic.length, 0);
  assert.ok(devices.some((d) => d.path === "/dev/ttyUSB0"));
});

test("buildUsbDiscoveryDevices: synthetic USB_1a86_5512 once when lsusb shows K40 but no serial node", () => {
  const { buildUsbDiscoveryDevices } = loadServerWithoutUsbMock();
  const lsusb = "Bus 001 Device 002: ID 1a86:5512 QinHeng Electronics";
  const devices = buildUsbDiscoveryDevices([], "linux", lsusb);
  const synthetic = devices.filter((d) => d.path === "USB_1a86_5512");
  assert.equal(synthetic.length, 1);
});

test("buildUsbDiscoveryDevices: Ray5 (1a86:7523) on bus does not hide missing K40 serial (5512 still surfaces)", () => {
  const { buildUsbDiscoveryDevices } = loadServerWithoutUsbMock();
  const activePorts = [{ path: "/dev/ttyUSB0", vendorId: "1A86", productId: "7523", friendlyName: "Ray" }];
  const lsusb = "Bus 001 Device 003: ID 1a86:7523 ...\nBus 001 Device 004: ID 1a86:5512 ...";
  const devices = buildUsbDiscoveryDevices(activePorts, "linux", lsusb);
  const synthetic = devices.filter((d) => d.path === "USB_1a86_5512");
  assert.equal(synthetic.length, 1, "5512 on lsusb without enumerated 5512 serial should still add synthetic K40 row");
});

test("buildUsbDiscoveryDevices: non-linux fallback synthetic when no enumerated K40", () => {
  const { buildUsbDiscoveryDevices } = loadServerWithoutUsbMock();
  const devices = buildUsbDiscoveryDevices([], "darwin", "");
  assert.ok(devices.some((d) => d.path === "USB_1a86_5512"));
});

test("M2 mock: USB_1a86_5512 routes G-code through driver (not executeSerialCommand no-op)", async (t) => {
  const server = loadServerWithUsbMock();
  const { executeSerialCommand, peekSerialConnectionForTests, clearSerialConnectionsForTests } = server;

  t.after(async () => {
    await clearSerialConnectionsForTests();
    delete globalThis.__lumaburnUsbMock;
    const { serverPath, m2nanoPath } = resolveServerModules();
    delete require.cache[serverPath];
    delete require.cache[m2nanoPath];
  });

  const resG91 = await executeSerialCommand("USB_1a86_5512", "G91", 115200, "lihuiyu");
  assert.equal(resG91.statusCode, 200);

  const conn = peekSerialConnectionForTests("USB_1a86_5512");
  assert.ok(conn?.m2, "Expected M2Nano connection for synthetic K40 path");
  const afterG91 = conn.port.device.getPackets().length;
  assert.ok(afterG91 > 0, "Mock CH341 should receive packets from G91 routing");

  await executeSerialCommand("USB_1a86_5512", "G0 X1 Y0 F3000", 115200, "lihuiyu");
  assert.ok(
    conn.port.device.getPackets().length > afterG91,
    "Jog-style G0 should append more packets (regression guard against instant fake ok)"
  );

  await clearSerialConnectionsForTests();
});
