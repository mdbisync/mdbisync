// Minimal audio and video files: silent MP3 frames, and an MP4 container
// with a movie header and no tracks. They are valid files for upload tests;
// nobody needs to play them.

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, mono: silent frames of 417 bytes. */
export function encodeSilentMp3(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG-1, Layer III, no CRC
  frame[2] = 0x90; // 128 kbit/s, 44.1 kHz, no padding
  frame[3] = 0xc0; // mono
  // Side information and main data stay zero: every granule is silence.
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, body]);
}

/** An ISO base media file: ftyp, moov with mvhd, and a free box of padding. */
export function encodeEmptyMp4(durationSeconds: number, padding: number): Buffer {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "ascii"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2mp41", "ascii")]));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 0); // version 0, flags 0
  mvhd.writeUInt32BE(0, 4); // creation time (fixed)
  mvhd.writeUInt32BE(0, 8); // modification time (fixed)
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(durationSeconds * 1000, 16);
  mvhd.writeUInt32BE(0x00010000, 20); // rate 1.0
  mvhd.writeUInt16BE(0x0100, 24); // volume 1.0
  // Identity matrix.
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  matrix.forEach((v, i) => mvhd.writeUInt32BE(v, 36 + i * 4));
  mvhd.writeUInt32BE(1, 96); // next track id
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd)), box("free", Buffer.alloc(padding))]);
}
