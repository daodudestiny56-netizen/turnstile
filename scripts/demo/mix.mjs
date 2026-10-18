// Combine the recording and the narration into the final MP4 (H.264 + AAC): each scene's narration
// starts where scripts/demo/record.mjs says that scene started.
//
//   node scripts/demo/mix.mjs [ffmpeg=ffmpeg]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "data/demo";
const ffmpeg = process.argv[2] ?? "ffmpeg";
const timeline = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const LEAD_MS = 350; // let each scene's first frame land before the voice starts

const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", join(OUT, "raw.webm")];
for (const s of timeline) args.push("-i", join(OUT, "audio", `${s.id}.wav`));
const delays = timeline
  .map(
    (s, i) =>
      `[${i + 1}:a]adelay=${s.startMs + LEAD_MS}|${s.startMs + LEAD_MS},aresample=48000[a${i}]`,
  )
  .join(";");
const mix = `${timeline.map((_, i) => `[a${i}]`).join("")}amix=inputs=${timeline.length}:normalize=0[aout]`;
args.push(
  "-filter_complex",
  `${delays};${mix}`,
  "-map",
  "0:v",
  "-map",
  "[aout]",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-c:a",
  "aac",
  "-b:a",
  "160k",
  "-movflags",
  "+faststart",
  join(OUT, "turnstile-demo.mp4"),
);
execFileSync(ffmpeg, args, { stdio: "inherit" });
console.log(`wrote ${join(OUT, "turnstile-demo.mp4")}`);
