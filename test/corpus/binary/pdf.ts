// A minimal PDF 1.4 writer: pages of Helvetica text and, optionally, one
// uncompressed RGB image per page that sets the file size exactly enough
// for the corpus's size cases (a 9 MB and an 11 MB file).

export type PdfPage = {
  lines: string[];
  /** Raw RGB image drawn on the page, width * height * 3 bytes. */
  image?: { width: number; height: number; rgb: Buffer };
};

function escapePdfText(text: string): string {
  // Only printable ASCII goes into the standard font; anything else is replaced.
  return text.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
}

export function encodePdf(pages: PdfPage[], title: string): Buffer {
  if (pages.length === 0) throw new Error("a PDF needs at least one page");
  const objects: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };
  const stream = (dict: string, data: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);

  // Fixed object numbers: 1 catalog, 2 pages, 3 font, 4 info; pages follow.
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree, filled in once the page numbers are known
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(`<< /Title (${escapePdfText(title)}) /Producer (corpus generator) >>`);
  const pageIds: number[] = [];
  for (const page of pages) {
    const text = page.lines
      .map((line, i) => `BT /F1 12 Tf 72 ${760 - i * 16} Td (${escapePdfText(line)}) Tj ET`)
      .join("\n");
    let resources = "/Font << /F1 3 0 R >>";
    let draw = text;
    if (page.image) {
      const { width, height, rgb } = page.image;
      if (rgb.length !== width * height * 3) throw new Error("image data has the wrong length");
      const imageId = add(
        stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8`, rgb),
      );
      resources += ` /XObject << /Im1 ${imageId} 0 R >>`;
      draw += `\nq 400 0 0 ${Math.max(1, Math.round((400 * height) / width))} 100 120 cm /Im1 Do Q`;
    }
    const contentId = add(stream("", Buffer.from(draw, "latin1")));
    pageIds.push(
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contentId} 0 R >>`),
    );
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(
    Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"),
  );
  return Buffer.concat(parts);
}
