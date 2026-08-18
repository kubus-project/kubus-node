import QRCode from 'qrcode';

/**
 * Render pairing QR codes with the maintained `qrcode` encoder. The explicit
 * margin and width preserve a four-module quiet zone and readable modules in
 * the operator GUI.
 */
export async function renderQrSvg(
  text: string,
  options: { title?: string } = {},
): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 560,
  });
  if (!options.title) return svg;
  const title = options.title.replace(/[<>&]/g, '');
  return svg.replace(/^<svg([^>]*)>/, `<svg$1 role="img"><title>${title}</title>`);
}
