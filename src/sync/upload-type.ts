import { parseXml, XmlElement, type XmlNode } from '@rgrove/parse-xml';

/** Every extension `uploadExtension` gives: the asset files a sync writes next to a document. */
/** The folder beside a document that holds the files the sync takes from Linear for it. */
export const ASSETS_FOLDER = 'assets';
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.gif', '.webp', '.pdf', '.avif', '.mp4', '.webm', '.svg']);

/**
 * Whether `path` is named as a capture names a downloaded upload: its content's
 * SHA-256 in lowercase hex and an extension `uploadExtension` gives.
 */
export function isCaptureName(path: string): boolean {
  const match = /^[0-9a-f]{64}(\.[a-z0-9]+)$/.exec(path.slice(path.lastIndexOf('/') + 1));
  return match !== null && UPLOAD_EXTENSIONS.has(match[1]!);
}

/**
 * Whether a file named as a capture names it still passes the upload check:
 * its bytes are an admitted type and that type's extension is the file's.
 * Files with other names are not uploads the sync admitted, and pass.
 */
export function admitsCapturedFile(path: string, bytes: Buffer): boolean {
  if (!isCaptureName(path)) return true;
  const extension = uploadExtension(bytes);
  return extension !== null && path.endsWith(extension);
}

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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/**
 * Static SVG elements. Not listed, so refused: script, foreignObject, animation,
 * and image and feImage, which load another file.
 */
const STATIC_SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'a', 'view', 'title', 'desc', 'metadata', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'filter',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
]);

/**
 * CSS, in a style element or any attribute, may refer only to fragments of this file.
 * CSS escapes are refused because they could spell a function name the check misses.
 */
function loadsCss(css: string): boolean {
  // CSS whitespace only: a URL keeps other spaces, such as U+00A0, as part of its path.
  return /\\|@import|image-set[ \t\n\r\f]*\(|\bsrc[ \t\n\r\f]*\(|url[ \t\n\r\f]*\([ \t\n\r\f]*(?=[^ \t\n\r\f])(?!['"]?[ \t\n\r\f]*#)/i.test(css);
}

/** The prefixes `xml` and `xmlns` are fixed by XML Namespaces; a file may not bind them. */
function declaredPrefix(key: string): string | null | undefined {
  if (key === 'xmlns') return '';
  if (!key.startsWith('xmlns:')) return undefined;
  const prefix = key.slice(6);
  return prefix === '' || prefix.includes(':') || prefix === 'xml' || prefix === 'xmlns' ? null : prefix;
}

/** An admitted SVG has only static SVG elements, resolved through every xmlns in scope. */
function safeSvg(bytes: Buffer): boolean {
  try {
    const xml = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const document = parseXml(xml, {preserveDocumentType:true});
    const root = document.root;
    if (root === null || root.name.split(':').at(-1) !== 'svg') return false;
    // An SVG without a default xmlns stays admitted, as its elements are read as SVG.
    const nodes: Array<{node:XmlNode; scope:ReadonlyMap<string, string>}> =
      document.children.map((node) => ({node, scope:new Map([['', SVG_NAMESPACE]])}));
    while (nodes.length > 0) {
      const {node, scope: parent} = nodes.pop()!;
      // Do not interpret DTDs, custom entities or external stylesheets.
      if (node.type === 'doctype' || node.type === 'pi') return false;
      if (!(node instanceof XmlElement)) continue;
      let scope = parent;
      for (const [key, value] of Object.entries(node.attributes)) {
        const prefix = declaredPrefix(key);
        if (prefix === null) return false;
        if (prefix === undefined) continue;
        if (scope === parent) scope = new Map(parent);
        (scope as Map<string, string>).set(prefix, value);
      }
      const name = node.name.split(':');
      if (name.length > 2 || scope.get(name.length === 2 ? name[0]! : '') !== SVG_NAMESPACE) return false;
      if (!STATIC_SVG_ELEMENTS.has(name.at(-1)!)) return false;
      // A browser reads a style sheet from direct text only; an element inside could split a checked word.
      if (name.at(-1) === 'style' && (node.children.some((child) => child instanceof XmlElement) || loadsCss(node.text))) return false;
      for (const [key, value] of Object.entries(node.attributes)) {
        if (declaredPrefix(key) !== undefined) continue;
        const parts = key.split(':');
        if (parts.length > 2) return false;
        const [prefix, local] = parts.length === 2 ? parts as [string, string] : ['', key];
        // Unprefixed attributes have no namespace; only xlink and xml:lang/xml:space are admitted with one.
        if (prefix === 'xml' ? !['lang', 'space'].includes(local) : prefix !== '' && scope.get(prefix) !== XLINK_NAMESPACE) return false;
        if (local.toLowerCase().startsWith('on') || (local === 'href' && !value.startsWith('#')) || loadsCss(value)) return false;
      }
      nodes.push(...node.children.map((child) => ({node:child, scope})));
    }
    return true;
  } catch { return false; }
}
