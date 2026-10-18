// Delete cached Blockchair dumps older than N days (by the date in their file name), so the
// GitHub Actions cache holds only what the rolling 90-day snapshot needs.
//
//   node scripts/prune-cache.mjs [dir=data/cache/blockchair] [days=100]
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const [dir = "data/cache/blockchair", daysArg = "100"] = process.argv.slice(2);
const cutoff = new Date(Date.now() - Number(daysArg) * 86_400_000)
  .toISOString()
  .slice(0, 10)
  .replaceAll("-", "");

let removed = 0;
let kept = 0;
const walk = (d) => {
  let entries;
  try {
    entries = readdirSync(d);
  } catch {
    return; // nothing cached yet
  }
  for (const name of entries) {
    const path = join(d, name);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const day = /_(\d{8})\.tsv\.gz$/.exec(name)?.[1];
      if (day && day < cutoff) {
        rmSync(path);
        removed++;
      } else kept++;
    }
  }
};
walk(dir);
console.log(`kept ${kept} cached file(s), removed ${removed} older than ${daysArg} days`);
