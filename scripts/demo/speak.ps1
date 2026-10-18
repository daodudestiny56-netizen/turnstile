# Turn scripts/demo/narration.json into one WAV per scene with the built-in Windows voice, and
# print each file's length in milliseconds (the recording waits that long on each scene).
#
#   powershell -NoProfile -File scripts/demo/speak.ps1 -OutDir data/demo/audio
param([string]$OutDir = "data/demo/audio", [string]$Voice = "Microsoft Zira Desktop", [int]$Rate = 0)

Add-Type -AssemblyName System.Speech
$scenes = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot "narration.json") | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($Voice)
$synth.Rate = $Rate
$lengths = @{}
foreach ($s in $scenes) {
  $path = Join-Path (Resolve-Path $OutDir) "$($s.id).wav"
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($s.text)
  $synth.SetOutputToNull()
  $bytes = (Get-Item $path).Length
  # 16-bit mono at the synthesizer's default 22,050 Hz, after a 44-byte header (checked below).
  $reader = [System.IO.File]::OpenRead($path)
  $header = New-Object byte[] 44
  [void]$reader.Read($header, 0, 44)
  $reader.Close()
  $byteRate = [BitConverter]::ToInt32($header, 28)
  $lengths[$s.id] = [int](($bytes - 44) * 1000 / $byteRate)
}
$synth.Dispose()
$lengths | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutDir "lengths.json")
$lengths | ConvertTo-Json
