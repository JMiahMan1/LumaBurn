import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mockUsbModule } from "./m2nano_mock.mjs";

const require = createRequire(import.meta.url);
globalThis.__lumaburnUsbMock = mockUsbModule;

// Now require the driver
const M2NanoDriver = require("../src/drivers/m2nano.cjs");

test("M2Nano Driver: Initialization and Handshake", async (t) => {
  const driver = new M2NanoDriver();

  await t.test("Open and Init", async () => {
    await driver.open();
    assert.strictEqual(driver.isOpen, true);
    assert.strictEqual(driver.lastStatus, 0xce);
  });

  await t.test("Handshake with key M2NANO", async () => {
    // Handshake happens during initCH341 (called by open)
    // We can verify if the mock received the handshake packet
    const packets = driver.device.getPackets();
    const hasHandshake = packets.some((p) => p[1] === 0x41); // 'A'
    assert.ok(hasHandshake, "Should have sent handshake packet");
  });
});

test("M2Nano Driver: Packetization and Stream", async (t) => {
  const driver = new M2NanoDriver();
  await driver.open();
  driver.device.clearPackets();

  await t.test("Single command stream", async () => {
    await driver.sendStream("I\n");
    const packets = driver.device.getPackets();
    assert.strictEqual(packets.length, 1);
    assert.strictEqual(packets[0][1], 0x49); // 'I'
  });

  await t.test("Multi-command stream", async () => {
    driver.device.clearPackets();
    await driver.sendStream("I\nDA\nD0\n");
    const packets = driver.device.getPackets();
    assert.strictEqual(packets.length, 3);
    assert.strictEqual(packets[0][1], 0x49); // 'I'
    assert.strictEqual(packets[1][1], 0x44); // 'D'
    assert.strictEqual(packets[1][2], 0x41); // 'A'
    assert.strictEqual(packets[2][1], 0x44); // 'D'
    assert.strictEqual(packets[2][2], 0x30); // '0'
  });

  await t.test("Long distance encoding (z-padding)", async () => {
    driver.device.clearPackets();
    await driver.sendStream("Bzz123\n");
    const packets = driver.device.getPackets();
    assert.strictEqual(packets.length, 1);
    assert.ok(packets[0].toString().includes("Bzz123"));
  });
});

test("M2Nano Driver: Speed Code Generation", (t) => {
  const driver = new M2NanoDriver();

  const code10 = driver.buildSpeedCode(10);
  assert.ok(code10.startsWith("CV"), "Should start with CV");
  assert.strictEqual(code10.length, 9, "Should be 9 chars long (CV + 3 + 3 + 1)");

  const code175 = driver.buildSpeedCode(175);
  assert.notStrictEqual(code10, code175, "Different speeds should have different codes");
});

test("M2Nano Driver: Error Recovery", async (t) => {
  const driver = new M2NanoDriver();
  await driver.open();

  await t.test("Handle busy state", async () => {
    driver.device.setStatus(0xee); // BUSY

    // Start a stream in a promise
    const streamPromise = driver.sendStream("I\n");

    // After 50ms, set status to OK
    setTimeout(() => {
      driver.device.setStatus(0xce);
    }, 50);

    const results = await streamPromise;
    assert.strictEqual(results[0].after, 0xce);
  });
});

test("M2Nano Driver: Raster Job Lifecycle", async (t) => {
  const driver = new M2NanoDriver();
  await driver.open();
  driver.device.clearPackets();

  await t.test("beginRasterJob enters program mode once", async () => {
    await driver.beginRasterJob(75, 30);
    await driver.beginRasterJob(75, 30);
    const payloads = driver.device
      .getPackets()
      .map((packet) => Buffer.from(packet.slice(1, 31)).toString("ascii").replace(/\0/g, ""));
    const programEntries = payloads.filter((entry) => entry.includes("CV"));
    assert.strictEqual(programEntries.length, 1);
    assert.strictEqual(driver.programModeActive, true);
  });

  await t.test("sendRasterRow honors leftward scan direction", async () => {
    driver.device.clearPackets();
    await driver.sendRasterRow("101", 4, 75, 30, { direction: "left", rowAdvance: 2 });
    const payloads = driver.device
      .getPackets()
      .map((packet) => Buffer.from(packet.slice(1, 31)).toString("ascii").replace(/\0/g, ""));
    assert.ok(
      payloads.some((entry) => entry.includes("T")),
      "Expected a leftward move command"
    );
    assert.ok(
      payloads.some((entry) => entry.includes("Rb")),
      "Expected row advance after scan"
    );
  });

  await t.test("finishRasterJob exits program mode", async () => {
    await driver.finishRasterJob();
    assert.strictEqual(driver.programModeActive, false);
    const payloads = driver.device
      .getPackets()
      .map((packet) => Buffer.from(packet.slice(1, 31)).toString("ascii").replace(/\0/g, ""));
    assert.ok(payloads.some((entry) => entry.includes("FNSE-")));
  });
});

test("M2Nano Driver: Captures centered raster packet sequence on mock CH341", async () => {
  const driver = new M2NanoDriver();
  await driver.open();

  const startX = driver.buildDistance(120);
  const startY = driver.buildDistance(80);
  driver.device.clearPackets();

  await driver.sendStream(`IB${startX}R${startY}S1P\n`);
  await driver.beginRasterJob(60, 12);
  await driver.sendRasterRow("1010", 4, 60, 12, { direction: "right", rowAdvance: 4 });
  await driver.sendRasterRow("0101", 4, 60, 12, { direction: "left", rowAdvance: 4 });
  await driver.finishRasterJob();

  const payloads = driver.device.getPayloadStrings();

  assert.ok(payloads[0].startsWith(`IB${startX}R${startY}S1P`), "Expected centered pre-position packet first");
  assert.ok(
    payloads.some((entry) => entry.startsWith("CV2152451")),
    "Expected program mode speed packet for 60 mm/s"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("N")),
    "Expected program mode N packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("LT")),
    "Expected LT axis declaration packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("S1E")),
    "Expected program mode entry packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("IAT") || entry.startsWith("IA")),
    "Expected AT power packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("IDS1PF")),
    "Expected legacy gate-on packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("IUS1PF")),
    "Expected legacy gate-off packet"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("IBdS1PF")),
    "Expected rightward 4-step raster move"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("ITdS1PF")),
    "Expected leftward 4-step raster move"
  );
  assert.ok(
    payloads.some((entry) => entry.startsWith("IRdS1PF")),
    "Expected row-advance packet"
  );
  assert.ok(payloads.at(-1).startsWith("FNSE-"), "Expected program mode exit packet last");
});
