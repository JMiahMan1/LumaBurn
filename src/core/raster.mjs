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
export function ditherImageAtkinson(image, sourceBounds, worldBounds, transform, resolutionDpi = 254, contrast = 1.0, brightness = 0) {
  const { lumas, width, height } = rasterizeImageToLumas(image, sourceBounds, worldBounds, transform, resolutionDpi, contrast, brightness);
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
export function rasterizeImageToLumas(image, sourceBounds, worldBounds, transform, resolutionDpi = 254, contrast = 1.0, brightness = 0) {
  const dpm = resolutionDpi / 25.4; 
  const targetWidthPx = Math.ceil(worldBounds.width * dpm);
  const targetHeightPx = Math.ceil(worldBounds.height * dpm);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidthPx;
  canvas.height = targetHeightPx;
  const ctx = canvas.getContext("2d");
  
  ctx.translate(-worldBounds.x * dpm, -worldBounds.y * dpm);
  
  const angleRad = (transform.rotation || 0) * (Math.PI / 180);
  const cx = (transform.x || 0) + (sourceBounds.centerX * (transform.scaleX || 1));
  const cy = (transform.y || 0) + (sourceBounds.centerY * (transform.scaleY || 1));

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

    let luma = 0.299 * r + 0.587 * g + 0.114 * b;
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
      
      if (x + 1 < width) result[idx + 1] += error;
      if (x + 2 < width) result[idx + 2] += error;
      if (y + 1 < height) {
        if (x - 1 >= 0) result[(y + 1) * width + (x - 1)] += error;
        result[(y + 1) * width + x] += error;
        if (x + 1 < width) result[(y + 1) * width + (x + 1)] += error;
      }
      if (y + 2 < height) {
        result[(y + 2) * width + x] += error;
      }
    }
  }
  return result;
}

/**
 * Generates horizontal sweep G-code for a monochrome raster map.
 * @param {Object} ditheredMap - The dithered luma result.
 * @param {Object} physicalBounds - Real-world mm bounds.
 * @param {Object} operationLayer - Burn power/feed settings.
 * @returns {string[]} G-code lines.
 */
export function generateRasterGcode(ditheredMap, physicalBounds, operationLayer) {
  const { lumas, width, height } = ditheredMap;
  const { x, y, width: physW, height: physH } = physicalBounds;
  
  const stepX = physW / width;
  const stepY = physH / height;
  
  const lines = [];
  lines.push(`; Raster Operation: ${operationLayer.name || 'Image'}`);
  lines.push(`G0 F${operationLayer.travelSpeed || 3000}`);
  
  for (let row = 0; row < height; row++) {
    const curY = y + row * stepY;
    let isDrawing = false;
    
    // Scan left to right
    for (let col = 0; col < width; col++) {
      const val = lumas[row * width + col];
      const curX = x + col * stepX;
      
      if (val === 0 && !isDrawing) {
        // Start of a dark pixel segment
        lines.push(`G0 X${curX.toFixed(3)} Y${curY.toFixed(3)}`);
        lines.push(`M3 S${operationLayer.power || 50}`);
        isDrawing = true;
      } else if (val === 255 && isDrawing) {
        // End of a dark pixel segment
        lines.push(`G1 X${curX.toFixed(3)} Y${curY.toFixed(3)} F${operationLayer.feed || 600}`);
        lines.push(`M5`);
        isDrawing = false;
      }
    }
    if (isDrawing) {
      lines.push(`G1 X${(x + physW).toFixed(3)} Y${curY.toFixed(3)} F${operationLayer.feed || 600}`);
      lines.push(`M5`);
    }
  }
  
  return lines;
}
