"""Narration with a Microsoft neural voice (natural-sounding), as an alternative to speak.ps1.

Uses the free edge-tts package, which sends each narration line (public text) to Microsoft's speech
service. Writes one WAV per scene and lengths.json, exactly as speak.ps1 does, so record.mjs and
mix.mjs work unchanged.

    pip install edge-tts
    python scripts/demo/speak_neural.py --ffmpeg <path to ffmpeg> [--voice en-US-AndrewNeural]
"""

import argparse
import asyncio
import json
import subprocess
import wave
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--voice", default="en-US-AndrewNeural")
    parser.add_argument("--rate", default="-4%", help="speaking rate, e.g. -4%% (a little slower)")
    parser.add_argument("--out", default="data/demo/audio")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scenes = json.loads((HERE / "narration.json").read_text(encoding="utf-8"))
    lengths = {}
    for scene in scenes:
        mp3 = out / f"{scene['id']}.mp3"
        wav = out / f"{scene['id']}.wav"
        await edge_tts.Communicate(scene["text"], args.voice, rate=args.rate).save(str(mp3))
        subprocess.run(
            [args.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(mp3),
             "-ac", "1", "-ar", "48000", str(wav)],
            check=True,
        )
        mp3.unlink()
        with wave.open(str(wav)) as w:
            lengths[scene["id"]] = round(1000 * w.getnframes() / w.getframerate())
    (out / "lengths.json").write_text(json.dumps(lengths, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(lengths, indent=2))


asyncio.run(main())
