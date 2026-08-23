/**
 * Minimal image encoding, so OCR never needs a canvas.
 *
 * tesseract.js accepts an encoded image as raw bytes, which means the only
 * reason `recognizePlane` ever built a `<canvas>` was to have something the
 * worker would take. Encoding a BMP here removes that — and with it the last
 * DOM dependency in the OCR path, letting the identical code run in Node.
 *
 * BMP rather than PNG because it needs no compressor: the format is a header
 * followed by the pixels, so this is thirty lines and no dependency. The size
 * on the wire does not matter, because the buffer is handed straight to a
 * worker in the same process and never leaves it.
 *
 * This is free in the browser too. The benchmark recorded in `scoreboardOcr`
 * measured canvas at 1036ms, blob at 1033ms and OffscreenCanvas at 1034ms per
 * recognize — indistinguishable, because the cost is all inside the LSTM. So
 * switching the browser onto this path cannot regress it.
 */

import { GrayPlane } from './imagePipeline';

/**
 * Encode an 8-bit grayscale plane as an uncompressed 24-bit BMP.
 *
 * Rows are written bottom-up and padded to a 4-byte boundary, which is what
 * the format requires; getting either wrong yields an image that decodes to a
 * sheared or upside-down glyph rather than an error, so both are worth stating
 * plainly.
 */
export function grayToBmp(plane: GrayPlane): Uint8Array {
  const { width: w, height: h, data } = plane;
  const rowBytes = w * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padding;
  const pixelBytes = stride * h;

  const FILE_HEADER = 14;
  const INFO_HEADER = 40;
  const offset = FILE_HEADER + INFO_HEADER;
  const out = new Uint8Array(offset + pixelBytes);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, out.length, true);
  view.setUint32(10, offset, true);

  // BITMAPINFOHEADER
  view.setUint32(14, INFO_HEADER, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true); // positive height = bottom-up rows
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(34, pixelBytes, true);

  for (let y = 0; y < h; y++) {
    // Source row 0 is the top; BMP row 0 is the bottom.
    const src = (h - 1 - y) * w;
    let dst = offset + y * stride;
    for (let x = 0; x < w; x++) {
      const v = data[src + x];
      out[dst++] = v; // B
      out[dst++] = v; // G
      out[dst++] = v; // R
    }
  }

  return out;
}
