import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawSmartAttendIcon(size, maskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = maskable ? size * 0.16 : size * 0.06;
  const radius = size * (maskable ? 0 : 0.2);

  const inRoundedRect = (x, y, rx, ry, rw, rh, rr) => {
    if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;
    if (rr <= 0) return true;
    const cx = x < rx + rr ? rx + rr : x >= rx + rw - rr ? rx + rw - rr : x;
    const cy = y < ry + rr ? ry + rr : y >= ry + rh - rr ? ry + rh - rr : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= rr * rr;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const inBg = maskable
        ? true
        : inRoundedRect(x, y, 0, 0, size, size, radius);

      if (!inBg) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
        continue;
      }

      // Rich slate-to-blue geometric gradient
      const t = (x + y) / (2 * size);
      let r = Math.round(29 * (1 - t) + 15 * t);
      let g = Math.round(78 * (1 - t) + 23 * t);
      let b = Math.round(216 * (1 - t) + 42 * t);
      if (t < 0.65) {
        r = Math.round(37 * (1 - t) + 29 * t);
        g = Math.round(99 * (1 - t) + 78 * t);
        b = Math.round(235 * (1 - t) + 216 * t);
      }

      // Draw crisp white QR + check emblem inside safe zone
      const inner = size - pad * 2;
      const nx = (x - pad) / inner;
      const ny = (y - pad) / inner;
      let isEmblem = false;

      if (nx >= 0.12 && nx <= 0.88 && ny >= 0.12 && ny <= 0.88) {
        // Top-left finder square
        const tlOuter = nx >= 0.14 && nx <= 0.42 && ny >= 0.14 && ny <= 0.42;
        const tlInner = nx >= 0.21 && nx <= 0.35 && ny >= 0.21 && ny <= 0.35;
        const tlCore = nx >= 0.25 && nx <= 0.31 && ny >= 0.25 && ny <= 0.31;

        // Top-right finder square
        const trOuter = nx >= 0.58 && nx <= 0.86 && ny >= 0.14 && ny <= 0.42;
        const trInner = nx >= 0.65 && nx <= 0.79 && ny >= 0.21 && ny <= 0.35;
        const trCore = nx >= 0.69 && nx <= 0.75 && ny >= 0.25 && ny <= 0.31;

        // Bottom-left finder square
        const blOuter = nx >= 0.14 && nx <= 0.42 && ny >= 0.58 && ny <= 0.86;
        const blInner = nx >= 0.21 && nx <= 0.35 && ny >= 0.65 && ny <= 0.79;
        const blCore = nx >= 0.25 && nx <= 0.31 && ny >= 0.69 && ny <= 0.75;

        // Bottom-right checkmark accent
        const seg1 =
          nx >= 0.56 &&
          nx <= 0.68 &&
          Math.abs(ny - (0.71 + (nx - 0.56) * 1.0)) < 0.045;
        const seg2 =
          nx >= 0.66 &&
          nx <= 0.86 &&
          Math.abs(ny - (0.83 - (nx - 0.66) * 1.05)) < 0.045;

        if (
          (tlOuter && (!tlInner || tlCore)) ||
          (trOuter && (!trInner || trCore)) ||
          (blOuter && (!blInner || blCore)) ||
          seg1 ||
          seg2
        ) {
          isEmblem = true;
        }
      }

      if (isEmblem) {
        buf[idx] = 255;
        buf[idx + 1] = 255;
        buf[idx + 2] = 255;
        buf[idx + 3] = 255;
      } else {
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = 255;
      }
    }
  }

  return encodeRgbaPng(size, size, buf);
}

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-192x192.png'), drawSmartAttendIcon(192, false));
fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-512x512.png'), drawSmartAttendIcon(512, false));
fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-maskable-512x512.png'), drawSmartAttendIcon(512, true));
fs.writeFileSync(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), drawSmartAttendIcon(180, false));

const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="sa-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#sa-g)"/>
  <rect x="11" y="11" width="16" height="16" rx="2.5" fill="none" stroke="#fff" stroke-width="3.5"/>
  <rect x="16" y="16" width="6" height="6" rx="1" fill="#fff"/>
  <rect x="37" y="11" width="16" height="16" rx="2.5" fill="none" stroke="#fff" stroke-width="3.5"/>
  <rect x="42" y="16" width="6" height="6" rx="1" fill="#fff"/>
  <rect x="11" y="37" width="16" height="16" rx="2.5" fill="none" stroke="#fff" stroke-width="3.5"/>
  <rect x="16" y="42" width="6" height="6" rx="1" fill="#fff"/>
  <path d="M37 45l5 5 11-12" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
fs.writeFileSync(path.join(PUBLIC_DIR, 'icon.svg'), svgIcon);
console.log('Generated crisp PWA icons in public/.');
