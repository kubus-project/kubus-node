import { describe, expect, it } from 'vitest';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import sharp from 'sharp';
import { renderQrSvg } from '../src/gui/qr.js';

async function decodeSvgWithZxing(svg: string): Promise<string> {
  const image = await sharp(Buffer.from(svg), { density: 300 })
    .resize(1680, 1680, { kernel: 'nearest' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = image.data;
  const pixels = new Int32Array(image.info.width * image.info.height);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * image.info.channels;
    pixels[index] = (rgb[offset]! << 16) | (rgb[offset + 1]! << 8) | rgb[offset + 2]!;
  }
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, image.info.width, image.info.height)));
  return new QRCodeReader().decode(bitmap).getText();
}

describe('operator pairing QR', () => {
  it('renders a high-contrast SVG with a quiet zone', async () => {
    const svg = await renderQrSvg('kubus-node://pair?v=2');
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="560"');
    expect(svg).toContain('viewBox="0 0 33 33"');
  });

  it('round-trips the actual GUI SVG through an independent ZXing decoder', async () => {
    const payload = new URL('kubus-node://pair');
    payload.searchParams.set('v', '2');
    payload.searchParams.set('e', 'https://node.example.test/local/v1');
    payload.searchParams.append('a', 'http://192.168.100.200:8787');
    payload.searchParams.set('s', '8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70');
    payload.searchParams.set('k', 'A9f5rN2Nukc9qHiSr_WCUKzVQfZcQMbZqcQYqZxFf1k');
    payload.searchParams.set('n', 'node-8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70');
    payload.searchParams.set('l', 'Kubus Node Studio');
    payload.searchParams.set('f', 'a'.repeat(64));

    const svg = await renderQrSvg(payload.toString(), { title: 'Pairing code' });
    expect(svg).toContain('shape-rendering="crispEdges"');
    await expect(decodeSvgWithZxing(svg)).resolves.toBe(payload.toString());
  });
});
