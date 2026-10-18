// Print the newest UTC day whose three Blockchair dumps (transactions, inputs, outputs) are all
// published, as "day=YYYY-MM-DD" for GitHub Actions. Blockchair publishes a day some hours after it
// ends, so this looks back from yesterday, up to five days.
//
//   node scripts/latest-day.mjs >> "$GITHUB_OUTPUT"
const TABLES = ["transactions", "inputs", "outputs"];
const url = (table, day) =>
  `https://gz.blockchair.com/zcash/${table}/blockchair_zcash_${table}_${day.replaceAll("-", "")}.tsv.gz`;

let latest;
for (let back = 1; back <= 5 && !latest; back++) {
  const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  const found = await Promise.all(
    TABLES.map(async (t) => {
      try {
        return (await fetch(url(t, day), { method: "HEAD" })).ok;
      } catch {
        return false;
      }
    }),
  );
  if (found.every(Boolean)) latest = day;
  else console.error(`${day}: not published yet`);
}
// Set the exit code rather than calling process.exit, so open connections close cleanly.
if (latest) console.log(`day=${latest}`);
else {
  console.error("No complete day published in the last five days; Blockchair may be down.");
  process.exitCode = 1;
}
