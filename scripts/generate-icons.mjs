#!/usr/bin/env node
/**
 * Gera os icones PNG do PWA (192, 512 e maskable 512) sem dependencias externas.
 * Desenha com supersampling e codifica PNG manualmente (zlib nativo).
 *
 * Uso: node scripts/generate-icons.mjs
 */

import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'icons');
const SS = 3; // supersampling

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const BG_TOP = hexToRgb('#12213a');
const BG_BOTTOM = hexToRgb('#070d18');
const BAR_FROM = hexToRgb('#6366f1');
const BAR_TO = hexToRgb('#38bdf8');
const ACCENT = hexToRgb('#38bdf8');

/**
 * Desenha o icone em um buffer RGBA de size x size.
 * @param {number} size
 * @param {{maskable?: boolean}} options
 */
function drawIcon(size, options = {}) {
  const canvas = new Uint8ClampedArray(size * size * 4);
  const maskable = Boolean(options.maskable);
  // Em maskable, o conteudo precisa caber na area segura (80% central).
  const scale = maskable ? 0.66 : 0.82;
  const offset = (1 - scale) / 2;
  const radius = maskable ? 0 : 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const index = (y * size + x) * 4;

      const inside = maskable || inRoundedRect(nx, ny, 0, 0, 1, 1, radius);
      if (!inside) {
        canvas[index + 3] = 0;
        continue;
      }

      // fundo com gradiente diagonal
      const t = Math.min(1, Math.max(0, nx * 0.45 + ny * 0.65));
      let color = mix(BG_TOP, BG_BOTTOM, t);

      // brilho radial no topo esquerdo
      const gx = nx - 0.18;
      const gy = ny - 0.14;
      const glow = Math.max(0, 1 - Math.sqrt(gx * gx + gy * gy) / 0.72) ** 2 * 0.5;
      color = mix(color, ACCENT, glow);

      // barras (coordenadas normalizadas dentro da area segura)
      const bx = (nx - offset) / scale;
      const by = (ny - offset) / scale;
      const bars = [
        { x0: 0.1, x1: 0.3, y0: 0.52, y1: 0.86 },
        { x0: 0.4, x1: 0.6, y0: 0.18, y1: 0.86 },
        { x0: 0.7, x1: 0.9, y0: 0.36, y1: 0.86, alpha: 0.78 },
      ];
      for (const bar of bars) {
        if (inRoundedRect(bx, by, bar.x0, bar.y0, bar.x1, bar.y1, 0.075)) {
          const barColor = mix(BAR_FROM, BAR_TO, Math.min(1, Math.max(0, (by - bar.y0) / Math.max(0.001, bar.y1 - bar.y0))));
          color = mix(color, barColor, bar.alpha ?? 1);
        }
      }

      // ponto de destaque
      const dx = bx - 0.2;
      const dy = by - 0.28;
      if (dx * dx + dy * dy <= 0.0046) {
        color = ACCENT;
      }

      canvas[index] = Math.round(color[0]);
      canvas[index + 1] = Math.round(color[1]);
      canvas[index + 2] = Math.round(color[2]);
      canvas[index + 3] = 255;
    }
  }
  return canvas;
}

/** Reduz por media de blocos (antialiasing). */
function downsample(canvas, sourceSize, factor) {
  const size = sourceSize / factor;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * sourceSize + (x * factor + sx)) * 4;
          r += canvas[index];
          g += canvas[index + 1];
          b += canvas[index + 2];
          a += canvas[index + 3];
        }
      }
      const total = factor * factor;
      const outIndex = (y * size + x) * 4;
      out[outIndex] = r / total;
      out[outIndex + 1] = g / total;
      out[outIndex + 2] = b / total;
      out[outIndex + 3] = a / total;
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filtro none
    for (let x = 0; x < width * 4; x += 1) {
      raw[y * (width * 4 + 1) + 1 + x] = rgba[y * width * 4 + x];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function generate(size, options, filename) {
  const big = size * SS;
  const canvas = drawIcon(big, options);
  const small = downsample(canvas, big, SS);
  const png = encodePng(small, size, size);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, filename), png);
  console.log(`gerado icons/${filename} (${size}x${size}, ${png.length} bytes)`);
}

generate(192, {}, 'icon-192.png');
generate(512, {}, 'icon-512.png');
generate(512, { maskable: true }, 'icon-maskable-512.png');
generate(180, {}, 'apple-touch-icon.png');
