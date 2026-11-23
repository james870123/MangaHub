/**
 * Rouman5's JPEG URLs may mark a page as sr:1. Those JPEG files contain
 * vertically permuted strips; sr:0 images are already in reading order.
 * This helper only transforms pixels in a canvas after the browser has loaded
 * an ordinary, accessible JPEG. It never fetches or derives protected URLs.
 */

/**
 * Keep the reader and disk cache on the same *host family* rules as the Rust
 * validate_rouman_image_source() allowlist (v0.6.6 CDN rotation fix).
 * Only exact numbered v1-v999 nodes are accepted; never arbitrary subdomains.
 */
export function isRoumanCdnImage(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.pathname.startsWith('/m/')) return false;
    const host = u.hostname.toLowerCase();
    return host === 'kelv47.xyz' || /^v[1-9][0-9]{0,2}\.(kelv47|towm85)\.xyz$/.test(host);
  } catch { return false; }
}

export function needsRoumanStripRepair(value: string): boolean {
  if (!isRoumanCdnImage(value)) return false;
  try {
    // The site marks permuted JPEGs by a path component, not by the CDN host.
    return new URL(value).pathname.split('/').includes('sr:1');
  } catch { return false; }
}

// Pure JS implementation, used to reproduce the per-image strip count.
// Avoids additional npm dependencies and WebCrypto (which does not offer MD5).
export function md5Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const bits = BigInt(bytes.length) * 8n;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Number(bits & 0xffffffffn), true);
  view.setUint32(paddedLength - 4, Number((bits >> 32n) & 0xffffffffn), true);

  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number, s: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; s = shifts[i % 4]; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; s = shifts[4 + i % 4]; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; s = shifts[8 + i % 4]; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; s = shifts[12 + i % 4]; }
      const originalD = d;
      const sum = (a + f + constants[i] + view.getUint32(offset + g * 4, true)) >>> 0;
      d = c; c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      a = originalD;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(n =>
    [0, 8, 16, 24].map(shift => ((n >>> shift) & 255).toString(16).padStart(2, '0')).join('')
  ).join('');
}

export function roumanStripCount(url: string): number {
  const encoded = new URL(url).pathname.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid encoded image name');
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const originalName = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return (Number.parseInt(md5Hex(originalName).slice(-2), 16) % 10) + 5;
}

export function drawRoumanImage(image: HTMLImageElement, canvas: HTMLCanvasElement, src: string): void {
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height) throw new Error('Image not loaded');
  const strips = roumanStripCount(src);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is unavailable');
  const heightPerStrip = Math.floor(height / strips);
  const remainder = height % strips;
  for (let i = 0; i < strips; i++) {
    const stripHeight = heightPerStrip + (i === 0 ? remainder : 0);
    const sourceY = height - heightPerStrip * (i + 1) - remainder;
    const targetY = heightPerStrip * i + (i === 0 ? 0 : remainder);
    if (stripHeight) ctx.drawImage(image, 0, sourceY, width, stripHeight, 0, targetY, width, stripHeight);
  }
}
