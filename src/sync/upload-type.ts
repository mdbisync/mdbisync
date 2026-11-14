import { parseXml, XmlElement, type XmlNode } from '@rgrove/parse-xml';

/** Every extension `uploadExtension` gives: the asset files a sync writes next to a document. */
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.gif', '.webp', '.pdf', '.avif', '.mp4', '.webm', '.svg']);

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
      if (brands.some((brand) => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'dash', 'cmfc', 'cmfs'].includes(brand))) return '.mp4';
    }
  }
  // WebM is EBML with a webm DocType, not an arbitrary Matroska file.
  if (starts([0x1a, 0x45, 0xdf, 0xa3]) && webmHeader(bytes)) return '.webm';
  return safeSvg(bytes) ? '.svg' : null;
}

/** Read EBML variable-length sizes and skip header elements by their declared length. */
function webmHeader(bytes: Buffer): boolean {
  const vint = (at: number, id = false): {value:number; next:number} | null => {
    const first = bytes[at];
    if (first === undefined || first === 0) return null;
    let width = 1;
    let marker = 0x80;
    while ((first & marker) === 0) { width++; marker >>= 1; }
    if (width > (id ? 4 : 8) || at + width > bytes.length) return null;
    let value = id ? first : first & (marker - 1);
    for (let index = 1; index < width; index++) value = value * 256 + bytes[at + index]!;
    return Number.isSafeInteger(value) ? {value, next:at + width} : null;
  };
  const header = vint(4);
  if (header === null) return false;
  const end = header.next + header.value;
  if (end > bytes.length) return false;
  let found = false;
  for (let at = header.next; at < end;) {
    const id = vint(at, true);
    const size = id === null ? null : vint(id.next);
    if (id === null || size === null || size.next + size.value > end) return false;
    if (id.value === 0x4282) {
      if (found || bytes.toString('latin1', size.next, size.next + size.value) !== 'webm') return false;
      found = true;
    }
    at = size.next + size.value;
  }
  return found;
}

function safeSvg(bytes: Buffer): boolean {
  try {
    const xml = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const document = parseXml(xml, {preserveDocumentType:true});
    const root = document.root;
    if (root === null) return false;
    const names = root.name.split(':');
    if (names.length > 2 || names.at(-1) !== 'svg') return false;
    const namespace = root.attributes[names.length === 2 ? `xmlns:${names[0]}` : 'xmlns'];
    if (namespace !== undefined && namespace !== 'http://www.w3.org/2000/svg') return false;
    if (names.length === 2 && namespace === undefined) return false;
    const nodes: XmlNode[] = [...document.children];
    while (nodes.length > 0) {
      const node = nodes.pop()!;
      // Do not interpret DTDs, custom entities or external stylesheets.
      if (node.type === 'doctype' || node.type === 'pi') return false;
      if (!(node instanceof XmlElement)) continue;
      const element = node.name.split(':').at(-1)!.toLowerCase();
      // Animation can replace a checked href with a script URL after parsing.
      if (['script', 'foreignobject', 'set'].includes(element) || element.startsWith('animate')) return false;
      for (const [key, value] of Object.entries(node.attributes)) {
        const name = key.split(':').at(-1)!.toLowerCase();
        if (name.startsWith('on') || key === 'xml:base' || (name === 'href' && !value.startsWith('#'))) return false;
      }
      nodes.push(...node.children);
    }
    return true;
  } catch { return false; }
}
