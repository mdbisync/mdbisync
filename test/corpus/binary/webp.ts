// A minimal lossless WebP (VP8L) writer. Each of red, green and blue takes
// one of two values, so every channel is a "simple" prefix code with two
// one-bit symbols, and alpha is fixed at 255. No transforms, no color cache,
// no backward references. That gives valid images of any size up to
// 16384x16384 with eight colors.

export type TwoLevelImage = {
  width: number;
  height: number;
  /** The two values each channel may take, [low, high] with low < high. */
  red: [number, number];
  green: [number, number];
  blue: [number, number];
  /** Per pixel, bit 0 picks red, bit 1 green, bit 2 blue (0 low, 1 high). */
  choices: Uint8Array;
};

class BitWriter {
  readonly bytes: number[] = [];
  #acc = 0;
  #bits = 0;

  /** VP8L packs values least significant bit first. */
  write(value: number, length: number): void {
    for (let i = 0; i < length; i++) {
      this.#acc |= ((value >>> i) & 1) << this.#bits;
      this.#bits++;
      if (this.#bits === 8) {
        this.bytes.push(this.#acc);
        this.#acc = 0;
        this.#bits = 0;
      }
    }
  }

  flush(): void {
    if (this.#bits > 0) this.bytes.push(this.#acc);
    this.#acc = 0;
    this.#bits = 0;
  }
}

function simpleCode(out: BitWriter, symbols: number[]): void {
  out.write(1, 1); // simple code
  out.write(symbols.length - 1, 1);
  const first = symbols[0] as number;
  if (first < 2) {
    out.write(0, 1); // first symbol fits in one bit
    out.write(first, 1);
  } else {
    out.write(1, 1);
    out.write(first, 8);
  }
  if (symbols.length === 2) out.write(symbols[1] as number, 8);
}

function checkLevels(name: string, levels: [number, number]): void {
  const [low, high] = levels;
  if (!(low >= 0 && high <= 255 && low < high)) throw new Error(`${name} levels must be 0 <= low < high <= 255`);
}

export function encodeWebp(image: TwoLevelImage): Buffer {
  const { width, height, choices } = image;
  if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error("size out of range");
  if (choices.length !== width * height) throw new Error("one choice per pixel is needed");
  checkLevels("red", image.red);
  checkLevels("green", image.green);
  checkLevels("blue", image.blue);

  const out = new BitWriter();
  out.write(0x2f, 8); // VP8L signature
  out.write(width - 1, 14);
  out.write(height - 1, 14);
  out.write(0, 1); // alpha is not used
  out.write(0, 3); // version 0
  out.write(0, 1); // no transform
  out.write(0, 1); // no color cache
  out.write(0, 1); // no meta prefix codes
  // Canonical prefix codes give the smaller symbol the code 0, so a choice
  // bit of 0 selects the low value.
  simpleCode(out, [...image.green]);
  simpleCode(out, [...image.red]);
  simpleCode(out, [...image.blue]);
  simpleCode(out, [255]); // alpha
  simpleCode(out, [0]); // distance, never used
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i] as number;
    out.write((c >> 1) & 1, 1); // green
    out.write(c & 1, 1); // red
    out.write((c >> 2) & 1, 1); // blue
    // alpha has one symbol and costs no bits
  }
  out.flush();

  const data = Buffer.from(out.bytes);
  const pad = data.length % 2;
  const chunk = Buffer.alloc(8 + data.length + pad);
  chunk.write("VP8L", 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, chunk]);
}

/** The RGBA a decoder produces for one pixel's choice. */
export function webpPixel(image: TwoLevelImage, choice: number): [number, number, number, number] {
  const level = (levels: [number, number], bit: number): number => (bit === 0 ? levels[0] : levels[1]);
  return [level(image.red, choice & 1), level(image.green, (choice >> 1) & 1), level(image.blue, (choice >> 2) & 1), 255];
}
