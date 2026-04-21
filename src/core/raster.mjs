/**
 * raster.mjs - Handles image dithering and raster-to-G-code processing.
 */

/**
 * Reads an image file into an HTMLImageElement.
 * @param {File} file - The file to load.
 * @returns {Promise<HTMLImageElement>}
 */
export async function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * High-performance image dithering using the Atkinson algorithm.
 * @param {HTMLImageElement} image - Source image.
 * @param {Object} sourceBounds - Original image bounds.
 * @param {Object} worldBounds - Targeted canvas bounds.
 * @param {Object} transform - Transformation matrix.
 * @param {number} resolutionDpi - Targeted output resolution.
 * @param {number} contrast - Contrast slope (0.0 to 2.0).
 * @param {number} brightness - Brightness offset (-100 to 100).
 * @returns {Object} { lumas: Float32Array, width, height }
 */
export function ditherImageAtkinson(
  image,
  sourceBounds,
  worldBounds,
  transform,
  resolutionDpi = 254,
  contrast = 1.0,
  brightness = 0
) {
  const { lumas, width, height } = rasterizeImageToLumas(
    image,
    sourceBounds,
    worldBounds,
    transform,
    resolutionDpi,
    contrast,
    brightness
  );
  return { lumas: applyAtkinsonDither(lumas, width, height), width, height };
}

/**
 * Extracts grayscale luma values from a transformed canvas image.
 * @param {HTMLImageElement} image - Source image.
 * @param {Object} sourceBounds - Original image bounds.
 * @param {Object} worldBounds - Targeted canvas bounds.
 * @param {Object} transform - Transformation matrix.
 * @param {number} resolutionDpi - Targeted output resolution.
 * @param {number} contrast - Contrast slope (0.0 to 2.0).
 * @param {number} brightness - Brightness offset (-100 to 100).
 * @returns {Object} { lumas: Float32Array, width, height }
 */
export function rasterizeImageToLumas(
  image,
  sourceBounds,
  worldBounds,
  transform,
  resolutionDpi = 254,
  contrast = 1.0,
  brightness = 0
) {
  const dpm = resolutionDpi / 25.4;
  const targetWidthPx = Math.ceil(worldBounds.width * dpm);
  const targetHeightPx = Math.ceil(worldBounds.height * dpm);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidthPx;
  canvas.height = targetHeightPx;
  const ctx = canvas.getContext("2d");

  ctx.translate(-worldBounds.x * dpm, -worldBounds.y * dpm);

  const angleRad = (transform.rotation || 0) * (Math.PI / 180);
  const cx = (transform.x || 0) + sourceBounds.centerX * (transform.scaleX || 1);
  const cy = (transform.y || 0) + sourceBounds.centerY * (transform.scaleY || 1);

  ctx.translate(cx * dpm, cy * dpm);
  ctx.rotate(angleRad);
  ctx.scale(transform.scaleX || 1, transform.scaleY || 1);
  ctx.translate(-sourceBounds.centerX * dpm, -sourceBounds.centerY * dpm);

  ctx.drawImage(image, 0, 0, sourceBounds.width * dpm, sourceBounds.height * dpm);

  const imageData = ctx.getImageData(0, 0, targetWidthPx, targetHeightPx);
  const pixels = imageData.data;
  const width = targetWidthPx;
  const height = targetHeightPx;

  const lumas = new Float32Array(width * height);
  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i];
    let g = pixels[i + 1];
    let b = pixels[i + 2];

    r = ((r / 255 - 0.5) * contrast + 0.5) * 255;
    g = ((g / 255 - 0.5) * contrast + 0.5) * 255;
    b = ((b / 255 - 0.5) * contrast + 0.5) * 255;

    r += brightness;
    g += brightness;
    b += brightness;

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    lumas[i / 4] = Math.max(0, Math.min(255, luma));
  }
  return { lumas, width, height };
}

/**
 * Applies Atkinson error-diffusion dithering to a luma buffer.
 * @param {Float32Array} lumas - Grayscale luma values (0-255).
 * @param {number} width - Buffer width.
 * @param {number} height - Buffer height.
 * @returns {Float32Array} Dithered monochrome buffer (0 or 255).
 */
export function applyAtkinsonDither(lumas, width, height) {
  const result = new Float32Array(lumas);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = result[idx];
      const newPixel = oldPixel < 128 ? 0 : 255;
      result[idx] = newPixel;

      const error = Math.floor((oldPixel - newPixel) / 8);

      if (x + 1 < width) {
        result[idx + 1] += error;
      }
      if (x + 2 < width) {
        result[idx + 2] += error;
      }
      if (y + 1 < height) {
        if (x - 1 >= 0) {
          result[(y + 1) * width + (x - 1)] += error;
        }
        result[(y + 1) * width + x] += error;
        if (x + 1 < width) {
          result[(y + 1) * width + (x + 1)] += error;
        }
      }
      if (y + 2 < height) {
        result[(y + 2) * width + x] += error;
      }
    }
  }
  return result;
}

/**
 * Converts a monochrome raster map into ordered row jobs.
 * Dark pixels (`0`) become laser-on bits.
 * @param {Object} ditheredMap
 * @param {Object} physicalBounds
 * @param {Object} options
 * @returns {Array<{row:number,y:number,startX:number,endX:number,direction:string,bitstring:string}>}
 */
export function buildRasterRows(ditheredMap, physicalBounds, options = {}) {
  const { lumas, width, height } = ditheredMap;
  const { x, y, width: physW, height: physH } = physicalBounds;
  const bidirectional = options.bidirectional !== false;
  const rows = [];

  if (!width || !height || !physW || !physH) {
    return rows;
  }

  const stepX = physW / width;
  const stepY = physH / height;

  for (let row = 0; row < height; row += 1) {
    const leftToRight = !bidirectional || row % 2 === 0;
    const bits = [];
    for (let col = 0; col < width; col += 1) {
      const sourceCol = leftToRight ? col : width - col - 1;
      const val = lumas[row * width + sourceCol];
      bits.push(val === 0 ? "1" : "0");
    }
    rows.push({
      row,
      y: y + row * stepY,
      startX: leftToRight ? x : x + physW,
      endX: leftToRight ? x + physW : x,
      direction: leftToRight ? "right" : "left",
      bitstring: bits.join(""),
      stepX,
      stepY,
    });
  }

  return rows;
}

/**
 * Generates horizontal sweep G-code for a monochrome raster map.
 * @param {Object} ditheredMap - The dithered luma result.
 * @param {Object} physicalBounds - Real-world mm bounds.
 * @param {Object} operationLayer - Burn power/feed settings.
 * @param {Object} machine - Machine settings for origin normalization.
 * @returns {string[]} G-code lines.
 */
export function generateRasterGcode(ditheredMap, physicalBounds, operationLayer, machine = {}) {
  const normalizePoint = (point) => {
    if (!machine || machine.originMode === "upper-left" || !Number.isFinite(machine.bedHeight)) return point;
    return { x: point.x, y: machine.bedHeight - point.y };
  };
  const lines = [];
  const rows = buildRasterRows(ditheredMap, physicalBounds, {
    bidirectional: operationLayer.bidirectional !== false,
  });
  const stepY = rows[0]?.stepY || 0;
  const laserMode = operationLayer.constantPower ? "M3" : "M4";
  const power = operationLayer.power || 50;
  const travelSpeed = operationLayer.travelSpeed || 3000;
  const feed = operationLayer.feed || 600;

  lines.push(`; Raster Operation: ${operationLayer.name || "Image"}`);
  lines.push(`G0 F${travelSpeed}`);
  lines.push("G90");

  rows.forEach((row) => {
    let isDrawing = false;
    const startPoint = normalizePoint({ x: row.startX, y: row.y });
    lines.push(`G0 X${startPoint.x.toFixed(3)} Y${startPoint.y.toFixed(3)}`);
    for (let col = 0; col < row.bitstring.length; col += 1) {
      const bit = row.bitstring[col];
      const progress = col * row.stepX;
      const targetX = row.direction === "right" ? row.startX + progress : row.startX - progress;
      const targetPoint = normalizePoint({ x: targetX, y: row.y });

      if (bit === "1" && !isDrawing) {
        lines.push(`G0 X${targetPoint.x.toFixed(3)} Y${targetPoint.y.toFixed(3)}`);
        lines.push(`${laserMode} S${power}`);
        isDrawing = true;
      } else if (bit === "0" && isDrawing) {
        lines.push(`G1 X${targetPoint.x.toFixed(3)} Y${targetPoint.y.toFixed(3)} F${feed}`);
        lines.push("M5");
        isDrawing = false;
      }
    }
    if (isDrawing) {
      const endPoint = normalizePoint({ x: row.endX, y: row.y });
      lines.push(`G1 X${endPoint.x.toFixed(3)} Y${endPoint.y.toFixed(3)} F${feed}`);
      lines.push("M5");
    }
  });

  if (rows.length) {
    const lastRow = rows[rows.length - 1];
    const finalPoint = normalizePoint({ x: lastRow.endX, y: lastRow.y + stepY });
    lines.push(`G0 X${finalPoint.x.toFixed(3)} Y${finalPoint.y.toFixed(3)}`);
  }

  return lines;
}
