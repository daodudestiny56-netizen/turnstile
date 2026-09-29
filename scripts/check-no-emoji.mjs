// Project rule: no emoji anywhere in the repository. Scans every git-tracked file; fails on any hit.
//
//   node scripts/check-no-emoji.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// U+FE0F (emoji presentation selector) sits outside the class: it's a combining mark.
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}]|\u{FE0F}/u;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
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
  });
}
if (hits > 0) {
  console.log(`${hits} line(s) contain emoji`);
  process.exitCode = 1;
}
