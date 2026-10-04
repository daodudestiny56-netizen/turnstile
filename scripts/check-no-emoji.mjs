// Project rules: no emoji anywhere in the repository, and no invisible or direction-control
// characters in source (they can make code read differently from how it runs). Scans every tracked
// and new (not ignored) file; fails on any hit.
//
//   node scripts/check-no-emoji.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// U+FE0F (emoji presentation selector) sits outside the class: it's a combining mark.
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}]|\u{FE0F}/u;
// Zero-width characters, bidirectional overrides and isolates, word joiner, byte-order mark.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const BOM_AT_START = /^\uFEFF/u;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
let hits = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree but still tracked
  }
  text.split("\n").forEach((line, i) => {
    if (EMOJI.test(line)) {
      hits++;
      console.log(`${file}:${i + 1}: emoji not allowed`);
    }
    // A byte-order mark at the very start of a file is harmless; anywhere else it isn't.
    if (INVISIBLE.test(i === 0 ? line.replace(BOM_AT_START, "") : line)) {
      hits++;
      console.log(
        `${file}:${i + 1}: invisible or direction-control character; write it as an escape`,
      );
    }
  });
}
if (hits > 0) {
  console.log(`${hits} problem(s) found`);
  process.exitCode = 1;
}
