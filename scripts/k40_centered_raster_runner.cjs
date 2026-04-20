#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = {
    input: "raster_data_final.json",
    bedWidthMm: 300,
    bedHeightMm: 200,
    stepsPerMm: 39.37,
    stepSizeSteps: 4,
    speedMmPerSec: 75,
    powerPercent: 10,
    dryRun: true,
    mock: false,
    homeFirst: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--input" && next) {
      options.input = next;
      index += 1;
    } else if (arg === "--bed-width-mm" && next) {
      options.bedWidthMm = Number(next);
      index += 1;
    } else if (arg === "--bed-height-mm" && next) {
      options.bedHeightMm = Number(next);
      index += 1;
    } else if (arg === "--steps-per-mm" && next) {
      options.stepsPerMm = Number(next);
      index += 1;
    } else if (arg === "--step-size-steps" && next) {
      options.stepSizeSteps = Number(next);
      index += 1;
    } else if (arg === "--speed-mm-s" && next) {
      options.speedMmPerSec = Number(next);
      index += 1;
    } else if (arg === "--power-percent" && next) {
      options.powerPercent = Number(next);
      index += 1;
    } else if (arg === "--live") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--home-first") {
      options.homeFirst = true;
    }
  }

  return options;
}

async function loadDriver(options) {
  if (options.mock) {
    const { mockUsbModule } = await import("../test/m2nano_mock.mjs");
    globalThis.__lumaburnUsbMock = mockUsbModule;
  }
  return require("../src/drivers/m2nano.cjs");
}

function buildCenterPlan(bitstrings, options, driver) {
  const rows = Array.isArray(bitstrings) ? bitstrings : [];
  const pixelHeight = rows.length;
  const pixelWidth = rows[0]?.length || 0;
  const widthMm = pixelWidth > 0 ? (pixelWidth * options.stepSizeSteps) / options.stepsPerMm : 0;
  const heightMm = pixelHeight > 0 ? (pixelHeight * options.stepSizeSteps) / options.stepsPerMm : 0;
  const originXmm = (options.bedWidthMm - widthMm) / 2;
  const originYmm = (options.bedHeightMm - heightMm) / 2;
  const originXSteps = Math.round(originXmm * options.stepsPerMm);
  const originYSteps = Math.round(originYmm * options.stepsPerMm);

  if (originXmm < 0 || originYmm < 0) {
    throw new Error(
      `Raster image is larger than the bed. Image=${widthMm.toFixed(2)}x${heightMm.toFixed(2)}mm Bed=${options.bedWidthMm}x${options.bedHeightMm}mm`
    );
  }

  const planner = new driver();
  return {
    input: options.input,
    rows: pixelHeight,
    columns: pixelWidth,
    widthMm: Number(widthMm.toFixed(3)),
    heightMm: Number(heightMm.toFixed(3)),
    originXmm: Number(originXmm.toFixed(3)),
    originYmm: Number(originYmm.toFixed(3)),
    originXSteps,
    originYSteps,
    stepSizeSteps: options.stepSizeSteps,
    rowAdvanceSteps: options.stepSizeSteps,
    speedMmPerSec: options.speedMmPerSec,
    powerPercent: options.powerPercent,
    homeFirst: options.homeFirst,
    prePositionStreams: [
      ...buildAxisMoveStreams(planner, planner.CODE_RIGHT, originXSteps),
      ...buildAxisMoveStreams(planner, planner.CODE_BOTTOM, originYSteps),
    ],
    payload: {
      bitstrings,
      stepSize: options.stepSizeSteps,
      rowAdvance: options.stepSizeSteps,
      speed: options.speedMmPerSec,
      power: options.powerPercent,
      bidirectional: true,
    },
  };
}

function buildAxisMoveStreams(driver, positiveCode, totalSteps) {
  const streams = [];
  let remaining = Math.max(0, Math.round(totalSteps));
  const chunkSize = 2550;
  while (remaining > 0) {
    const stepChunk = Math.min(remaining, chunkSize);
    streams.push(`I${positiveCode}${driver.buildDistance(stepChunk)}S1P\n`);
    remaining -= stepChunk;
  }
  return streams;
}

async function runLive(plan, Driver) {
  const driver = new Driver();
  await driver.open();
  try {
    if (plan.homeFirst) {
      console.log("preflight-home IPP");
      await driver.sendStream("IPP\n");
    }
    for (const stream of plan.prePositionStreams) {
      await driver.sendStream(stream);
    }
    await driver.beginRasterJob(plan.speedMmPerSec, plan.powerPercent);
    for (let index = 0; index < plan.payload.bitstrings.length; index += 1) {
      const direction = index % 2 === 0 ? "right" : "left";
      await driver.sendRasterRow(
        plan.payload.bitstrings[index],
        plan.stepSizeSteps,
        plan.speedMmPerSec,
        plan.powerPercent,
        {
          direction,
          rowAdvance: plan.rowAdvanceSteps,
        }
      );
      if ((index + 1) % 25 === 0 || index === plan.payload.bitstrings.length - 1) {
        console.log(`live-progress ${index + 1}/${plan.payload.bitstrings.length}`);
      }
    }
  } finally {
    await driver.finishRasterJob().catch(() => {});
    await driver.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const M2NanoDriver = await loadDriver(options);
  const inputPath = path.resolve(process.cwd(), options.input);
  const bitstrings = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const plan = buildCenterPlan(bitstrings, options, M2NanoDriver);
  const outputPath = path.resolve(process.cwd(), "centered_k40_raster_plan.json");

  fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2));

  console.log(`plan-file ${outputPath}`);
  console.log(`image ${plan.columns}x${plan.rows} px`);
  console.log(`physical-size ${plan.widthMm} x ${plan.heightMm} mm`);
  console.log(`center-origin-mm ${plan.originXmm},${plan.originYmm}`);
  console.log(`center-origin-steps ${plan.originXSteps},${plan.originYSteps}`);
  console.log(`pre-position ${plan.prePositionStreams.map((stream) => stream.trim()).join(" | ")}`);
  console.log(`home-first ${plan.homeFirst ? "yes" : "no"}`);
  console.log(`mode ${options.dryRun ? "dry-run" : "live"}`);
  console.log(`target ${options.mock ? "mock-ch341" : "real-ch341"}`);

  if (options.dryRun) {
    console.log("dry-run only; no hardware commands sent");
    return;
  }

  await runLive(plan, M2NanoDriver);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
