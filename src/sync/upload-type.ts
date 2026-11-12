import { SaxesParser } from 'saxes';

/** A signature identifies a type, not whether a media decoder can render it. */
export function uploadExtension(bytes: Buffer): string | null {
  const starts = (signature: number[]) => bytes.subarray(0, signature.length).equals(Buffer.from(signature));
  const text = (from: number, to: number) => bytes.toString('latin1', from, to);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
  if (starts([0xff, 0xd8, 0xff])) return '.jpg';
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return '.gif';
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return '.webp';
  if (/^%PDF-[12]\.[0-9]/.test(text(0, 8))) return '.pdf';
  // ISO BMFF's file-type box has a major brand, minor version and compatible brands.
  if (bytes.length >= 16 && text(4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      const brands = [text(8, 12)];
      for (let at = 16; at < size; at += 4) brands.push(text(at, at + 4));
      if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return '.avif';
      if (brands.some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A '].includes(brand))) return '.mp4';
    }
  }
  // WebM is EBML with a webm DocType, not an arbitrary Matroska file.
  if (starts([0x1a, 0x45, 0xdf, 0xa3]) && bytes.subarray(0, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return '.webm';
  return safeSvg(bytes) ? '.svg' : null;
}

function safeSvg(bytes: Buffer): boolean {
  try {
    const xml = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const parser = new SaxesParser({xmlns:true});
    let root = false;
    const refuse = () => { throw new Error('Unsupported SVG'); };
    // Do not interpret DTDs, custom entities or external stylesheets.
    parser.on('doctype', refuse);
    parser.on('processinginstruction', refuse);
    parser.on('opentag', (tag) => {
      if (!root) {
        if (tag.local !== 'svg' || !['', 'http://www.w3.org/2000/svg'].includes(tag.uri)) refuse();
        root = true;
      }
      if (['script', 'foreignobject'].includes(tag.local.toLowerCase())) refuse();
      for (const attribute of Object.values(tag.attributes)) {
        const name = attribute.local.toLowerCase();
        if (name.startsWith('on') || (name === 'href' && !attribute.value.startsWith('#'))) refuse();
      }
    });
    parser.write(xml).close();
    return root;
  } catch { return false; }
}
