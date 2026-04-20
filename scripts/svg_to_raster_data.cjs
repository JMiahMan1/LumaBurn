#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    input: "assets/raster-test-card.svg",
    output: "test/fixtures/raster_test_card_256.json",
    width: 256,
    height: 256,
    invert: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--input" && next) {
      options.input = next;
      index += 1;
    } else if (arg === "--output" && next) {
      options.output = next;
      index += 1;
    } else if (arg === "--width" && next) {
      options.width = Number(next);
      index += 1;
    } else if (arg === "--height" && next) {
      options.height = Number(next);
      index += 1;
    } else if (arg === "--invert") {
      options.invert = true;
    }
  }

  return options;
}

async function rasterizeSvgToRows(svgMarkup, options) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ svgText, width, height, invert }) => {
        function applyAtkinsonDither(lumas, imageWidth, imageHeight) {
          const result = new Float32Array(lumas);
          for (let y = 0; y < imageHeight; y += 1) {
            for (let x = 0; x < imageWidth; x += 1) {
              const idx = y * imageWidth + x;
              const oldPixel = result[idx];
              const newPixel = oldPixel < 128 ? 0 : 255;
              result[idx] = newPixel;

              const error = Math.floor((oldPixel - newPixel) / 8);

              if (x + 1 < imageWidth) result[idx + 1] += error;
              if (x + 2 < imageWidth) result[idx + 2] += error;
              if (y + 1 < imageHeight) {
                if (x - 1 >= 0) result[(y + 1) * imageWidth + (x - 1)] += error;
                result[(y + 1) * imageWidth + x] += error;
                if (x + 1 < imageWidth) result[(y + 1) * imageWidth + (x + 1)] += error;
              }
              if (y + 2 < imageHeight) result[(y + 2) * imageWidth + x] += error;
            }
          }
          return result;
        }

        const blob = new Blob([svgText], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);

        try {
          const img = new Image();
          img.src = url;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          const imageData = ctx.getImageData(0, 0, width, height);
          const pixels = imageData.data;
          const lumas = new Float32Array(width * height);

          for (let index = 0; index < pixels.length; index += 4) {
            const r = pixels[index];
            const g = pixels[index + 1];
            const b = pixels[index + 2];
            const a = pixels[index + 3] / 255;
            const compositeR = 255 + (r - 255) * a;
            const compositeG = 255 + (g - 255) * a;
            const compositeB = 255 + (b - 255) * a;
            let luma = 0.299 * compositeR + 0.587 * compositeG + 0.114 * compositeB;
            if (invert) luma = 255 - luma;
            lumas[index / 4] = Math.max(0, Math.min(255, luma));
          }

          const dithered = applyAtkinsonDither(lumas, width, height);
          const rows = [];
          for (let y = 0; y < height; y += 1) {
            let row = "";
            for (let x = 0; x < width; x += 1) {
              row += dithered[y * width + x] === 0 ? "1" : "0";
            }
            rows.push(row);
          }
          return rows;
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      {
        svgText: svgMarkup,
        width: options.width,
        height: options.height,
        invert: options.invert,
      }
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output);
  const svgMarkup = fs.readFileSync(inputPath, "utf8");
  const rows = await rasterizeSvgToRows(svgMarkup, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2));
  console.log(`input ${inputPath}`);
  console.log(`output ${outputPath}`);
  console.log(`image ${options.width}x${options.height}`);
  console.log(`rows ${rows.length}`);
  console.log(`columns ${rows[0]?.length || 0}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
