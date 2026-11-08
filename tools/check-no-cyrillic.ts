// Fails when a tracked file contains a Cyrillic character.
// The repository is English only; non-Latin test text uses other scripts.
// Prints the file and line of each hit, never the line itself.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CYRILLIC = /[\u0400-\u052F\u1C80-\u1C8F\u2DE0-\u2DFF\uA640-\uA69F\u{1E030}-\u{1E08F}]/u;

export function findCyrillicLines(text: string): number[] {
  return text.split("\n").flatMap((line, index) => (CYRILLIC.test(line) ? [index + 1] : []));
}

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter((file) => file !== "");
}

if (import.meta.main) {
  const hits: string[] = [];
  for (const file of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (text.includes("\0")) {
      continue; // binary file
    }
    for (const line of findCyrillicLines(text)) {
      hits.push(`${file}:${line}: Cyrillic character`);
    }
  }
  if (hits.length > 0) {
    console.error(hits.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("No Cyrillic characters found.");
  }
}
