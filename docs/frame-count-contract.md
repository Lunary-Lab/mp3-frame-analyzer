# Frame-count contract

**Status: unresolved external decision.** The API returns **physical MPEG-1
Layer III frames**, including a leading Xing/Info/VBRI metadata frame. That
behavior is preserved until the evaluator (or the repository owner)
confirms which count the assessment expects. It has not been changed on
speculation.

## What the brief says

The [assessment brief](assessment-brief.md) asks for "the number of
frames in the file", requires parsing the file "to logically count the number
of frames", and says `<number>` "should be the correct number of frames in the
MP3 file". It does not say whether a metadata-only frame counts. Its only
verification guidance is a tip: "The candidate may wish to use a tool such as
mediainfo to verify their results."

## Measurements (2026-10-24)

The supplied sample (SHA-256
`97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3`, LAME 3.100
VBR, 44.1 kHz joint stereo) contains 6090 structurally valid MPEG-1 Layer III
frames. The first starts at byte 44, after an ID3v2 tag, and carries a `Xing`
header whose frame field declares 6089 frames.

| File                         | Physical frames (API) | Xing/Info declared | FFprobe 6.0 `nb_read_frames` | MediaInfo 26.05 `FrameCount` |
| ---------------------------- | --------------------: | -----------------: | ---------------------------: | ---------------------------: |
| Assessment sample (VBR)      |              **6090** |               6089 |                         6089 |                     **6089** |
| `tests/fixtures/vbr.mp3`     |                    33 |                 32 |                           32 |                           32 |
| `tests/fixtures/cbr.mp3`     |                    33 |        32 (`Info`) |                           32 |                           33 |
| `tests/fixtures/no-xing.mp3` |                    51 |               none |                           51 |                           51 |

MediaInfo labels the sample's first frame `Tag (Xing)` rather than audio. Its
reported duration, 159.060 s, equals 6089 × 1152 samples ÷ 44 100 Hz. For VBR
files MediaInfo reports the Xing-declared count; for the CBR fixture it reports
33, a size-derived count that includes the `Info` frame. No single convention
reproduces MediaInfo on every file. Excluding only a leading Xing/Info/VBRI
frame (counting audio-bearing frames) matches FFprobe on every fixture and
MediaInfo on the supplied sample.

## Assessment

The brief's suggested tool reports **6089** for the supplied sample, as does
FFprobe, while this API reports **6090**. That is strong evidence an evaluator
following the tip expects 6089, but the brief does not explicitly require
excluding metadata frames, and the owner has not authorized changing the
externally visible contract. The physical count therefore remains the
documented behavior.

## Clarification question

> For the supplied sample, our endpoint counts 6090 MPEG-1 Layer III frames: the
> first frame contains only the LAME/Xing VBR header, followed by 6089 audio
> frames. MediaInfo and FFprobe both report 6089. Should `frameCount` include
> the Xing/Info metadata frame (6090), or count only audio frames (6089)?

## Optional explicit convention

The endpoint now accepts `?includeVbrHeaderFrame=false` for clients that want to exclude **one recognized initial** Xing/Info/LAME or VBRI frame. Omitted and `true` retain the physical-frame count. This does not guarantee the same result as every audio decoder or media metadata tool, and the declared encoder frame count is never trusted. The assessment default remains an unresolved external decision.

## If audio frames are confirmed

Skip at most one leading frame whose side-information region carries a `Xing`,
`Info`, or `VBRI` signature; never trust the declared count itself. Update the
parser tests, fixtures (`cbr.mp3` and `vbr.mp3` become 32), sample oracle,
README, runtime guide, architecture notes, and fuzz oracles. Treat it as a
contract change (`feat!:` → 2.0.0) unless the owner decides the brief always
required audio frames, in which case `fix:` (patch) documents a correction.
