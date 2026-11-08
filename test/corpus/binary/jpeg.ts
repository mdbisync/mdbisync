// A minimal baseline JPEG writer. Every 8x8 block has one solid color, so
// each block codes only its DC coefficient followed by end-of-block. That
// keeps the encoder small while producing valid images of any size, from
// 1x1 to 4000x3000, that every decoder reads.

/** A block-colored picture: one YCbCr color per 8x8 block, row-major. */
export type BlockImage = {
  width: number;
  height: number;
  /** For each block, [Y, Cb, Cr] in 0..255. */
  blocks: Uint8Array;
};

export function blocksAcross(width: number): number {
  return Math.ceil(width / 8);
}

export function blocksDown(height: number): number {
  return Math.ceil(height / 8);
}

// Standard DC Huffman table (ITU T.81 Annex K.3, luminance): categories 0-11.
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// AC table with the one symbol this writer uses: end-of-block (0x00).
const AC_COUNTS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_SYMBOLS = [0x00];
// Quantizer for every coefficient. 8 makes the quantized DC equal to the
// sample value minus 128, since the forward DCT's DC term is 8 times the mean.
const QUANT = 8;

type Code = { code: number; length: number };

function canonicalCodes(counts: number[], symbols: number[]): Map<number, Code> {
  const codes = new Map<number, Code>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < (counts[length - 1] as number); i++) {
      codes.set(symbols[k++] as number, { code, length });
      code++;
    }
    code <<= 1;
  }
  return codes;
}

const DC_CODES = canonicalCodes(DC_COUNTS, DC_SYMBOLS);
const EOB = canonicalCodes(AC_COUNTS, AC_SYMBOLS).get(0) as Code;

class ScanWriter {
  readonly bytes: number[] = [];
  #acc = 0;
  #bits = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.#acc = (this.#acc << 1) | ((value >>> i) & 1);
      this.#bits++;
      if (this.#bits === 8) this.#emit();
    }
  }

  #emit(): void {
    this.bytes.push(this.#acc);
    if (this.#acc === 0xff) this.bytes.push(0x00); // byte stuffing
    this.#acc = 0;
    this.#bits = 0;
  }

  /** Pads the last byte with one bits, as the standard asks. */
  flush(): void {
    while (this.#bits !== 0) this.write(1, 1);
  }
}

function writeDc(out: ScanWriter, diff: number): void {
  const magnitude = Math.abs(diff);
  const category = magnitude === 0 ? 0 : 32 - Math.clz32(magnitude);
  const code = DC_CODES.get(category);
  if (!code) throw new Error(`DC difference ${diff} is out of range`);
  out.write(code.code, code.length);
  if (category > 0) out.write(diff > 0 ? diff : diff + (1 << category) - 1, category);
}

function segment(marker: number, body: number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
}

function huffmanTable(classAndId: number, counts: number[], symbols: number[]): number[] {
  return [classAndId, ...counts, ...symbols];
}

export function encodeJpeg(image: BlockImage): Buffer {
  const { width, height, blocks } = image;
  const across = blocksAcross(width);
  const down = blocksDown(height);
  if (blocks.length !== across * down * 3) throw new Error("one YCbCr triple per 8x8 block is needed");
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error("size out of range");

  const head: number[] = [0xff, 0xd8];
  // JFIF APP0: version 1.1, no density units, 1:1 aspect, no thumbnail.
  head.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  head.push(...segment(0xdb, [0x00, ...new Array<number>(64).fill(QUANT)]));
  head.push(
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      ...[1, 2, 3].flatMap((id) => [id, 0x11, 0]), // no subsampling, table 0
    ]),
  );
  head.push(
    ...segment(0xc4, [
      ...huffmanTable(0x00, DC_COUNTS, DC_SYMBOLS),
      ...huffmanTable(0x10, AC_COUNTS, AC_SYMBOLS),
    ]),
  );
  head.push(...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));

  const scan = new ScanWriter();
  const previous = [0, 0, 0];
  for (let b = 0; b < across * down; b++) {
    for (let c = 0; c < 3; c++) {
      const dc = (blocks[b * 3 + c] as number) - 128;
      writeDc(scan, dc - (previous[c] as number));
      previous[c] = dc;
      scan.write(EOB.code, EOB.length);
    }
  }
  scan.flush();
  return Buffer.from([...head, ...scan.bytes, 0xff, 0xd9]);
}

/** The RGB a JFIF decoder produces for one YCbCr triple, rounded and clamped. */
export function ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(y + 1.402 * (cr - 128)),
    clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
    clamp(y + 1.772 * (cb - 128)),
  ];
}
