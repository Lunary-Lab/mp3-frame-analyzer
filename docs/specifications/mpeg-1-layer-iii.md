# MPEG-1 Audio Layer III: project-specific format contract

**Normative root:** [ISO/IEC 11172-3:1993 (Audio)](https://www.iso.org/standard/22412.html), [technical corrigendum](https://www.iso.org/standard/25371.html). Technical header values below are paraphrased implementer summaries, cross-checked against [FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c) and [mpg123](https://github.com/libsdl-org/mpg123/blob/main/src/libmpg123/mpeghead.h); they are _not_ purported verbatim ISO clauses. See [source hierarchy](README.md).

## 1. Precisely supported format

Only MPEG-**1** Audio Layer **III** (MP3) elementary audio frames. A compliant frame may use any valid MPEG-1 Layer III table bitrate, sample rate, CRC-protection setting, padding setting, channel mode, and other valid header flags. CBR/VBR/ABR describe encoder bitrate behavior; **they are not different MPEG versions or distinct frame header syntaxes**. The frame length must be resolved afresh at each indexed-bitrate frame.

Header values outside this target: MPEG-2 Layer III, non-ISO MPEG-2.5, MPEG-1 Layers I/II, ADTS AAC and MPEG-4/MP4. MPEG ancillary data does not change the underlying frame-boundary counting requirement. Reject as unsupported rather than pretending to count as Layer III.

## 2. Four-byte header: bit-accurate layout

Header is 32 bits in big-endian/MSB-first order; offsets are bit positions within the 32-bit unsigned header word.

| Bits  | Width | Meaning and relevant values                                                 |
| ----- | ----: | --------------------------------------------------------------------------- |
| 31–21 |    11 | Synchronization: all ones (`0x7ff`)                                         |
| 20–19 |     2 | Version: `11` = MPEG-1; `10` MPEG-2; `00` MPEG-2.5 extension; `01` reserved |
| 18–17 |     2 | Layer: `01` = III; `10` = II; `11` = I; `00` reserved                       |
| 16    |     1 | Protection: `0` means protected by a 16-bit CRC; `1` no CRC                 |
| 15–12 |     4 | Bitrate index: `0000` free-format, `0001`–`1110` table, `1111` reserved     |
| 11–10 |     2 | Sampling-rate index: `00` 44100, `01` 48000, `10` 32000 Hz; `11` reserved   |
| 9     |     1 | Padding: `0` = no extra slot, `1` = one byte for Layer III                  |
| 8     |     1 | Private application bit: must not change Layer III frame sizing             |
| 7–6   |     2 | Channel mode: `00` stereo, `01` joint stereo, `10` dual channel, `11` mono  |
| 5–4   |     2 | Mode extension: may affect audio coding, **not** frame byte length          |
| 3     |     1 | Copyright flag: not a validity or length discriminator                      |
| 2     |     1 | Original/home flag: not a validity or length discriminator                  |
| 1–0   |     2 | Emphasis: `00` none, `01` 50/15 µs, `10` reserved, `11` CCITT J.17          |

**Valid MPEG-1 Layer III indexed bitrate table**, from `BITRATES_KBPS` ([source](../../src/mp3/frame-header.ts)):

| Index (hex) | 0    | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | A   | B   | C   | D   | E   | F        |
| ----------- | ---- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | -------- |
| kbps        | free | 32  | 40  | 48  | 56  | 64  | 80  | 96  | 112 | 128 | 160 | 192 | 224 | 256 | 320 | reserved |

Frame header bit fields are unsigned; do not let JavaScript signed 32-bit operators change the interpretation of the highest bit. The emphasis value `10` is reserved, and the current strict project policy rejects it; some real-world decoders tolerate it as an interoperability exception.

## 3. Indexed frame length and boundaries

For bitrate index 1–14, with `bitrateKbps` from the table, `sampleRateHz` from the header and `paddingBit` in {0,1}:

```text
frameLengthBytes = floor(144000 * bitrateKbps / sampleRateHz) + paddingBit
```

MPEG-1 Layer III normally represents **1152 PCM samples per frame**, independent of the header's channel mode. This audio sample count does _not_ imply a count of decoded frames (encoder delay, padding, and metadata-only frames alter reporting by tools).

- Four header bytes belong to `frameLengthBytes`. Optional CRC bytes, side information, audio data and ancillary bytes are **within** the computed frame length; never add CRC bytes again.
- Protected ordinary Layer III frames have a 16-bit CRC field associated with the frame. The project recognizes the protection bit but does **not** verify CRC or Huffman/side-information integrity.
- Mono has 17 bytes of MPEG-1 Layer III side information, other channel modes have 32. This matters for locating some Xing/Info metadata conventions, **not** for frame length.
- After parsing a valid header at offset `o`, skip exactly `frameLengthBytes` and expect the next header at `o + frameLengthBytes` (or one of the explicitly supported trailing tags/EOF). Ignore apparent sync markers inside that payload.
- No file-size-derived approximate count, first-frame-only bitrate assumption, or Xing/VBRI count shortcut can replace this traversal for an **exact physical-frame count**.
- Reject incomplete final headers, incomplete final frames, invalid indices, and nonmetadata garbage at required boundaries under the project's strict policy.

## 4. Free-format Layer III (bitrate index zero)

**Index `0000` is valid, not reserved.** It encodes no table-defined bitrate, so the indexed length formula alone is insufficient. [LAME's original documentation](https://github.com/lameproject/lame/blob/master/USAGE) calls this a fixed-bitrate free-format stream, encodable at arbitrary integer rates from 8 to 640 kbps, and notes that generally conforming decoders need support only up to 320 kbps. The project's **640 kbps** interoperability goal is broader than the minimum decoding requirement.

For consecutively aligned frames, infer **one fixed unpadded byte span**:

```text
baseLength = secondFrameStart - firstFrameStart - firstFramePadding
frameLength(i) = baseLength + paddingBit(i)
```

This is a structural inference from frame starts, not a reconstructed bitrate table. With LAME's documented upper rate and 32 kHz sample rate, `floor(144000 * 640 / 32000) + 1 = 2881` bytes. **2881 is a project interoperability/DoS bound inferred from LAME's ceiling, not a universal ISO-defined maximum**. See [LAME VbrTag.c](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.c) (the encoder has a 2880-byte free-frame constant), [mpg123 inference](https://github.com/libsdl-org/mpg123/blob/main/src/libmpg123/parse.c), and [GStreamer free-rate inference](https://github.com/GStreamer/gstreamer/blob/main/subprojects/gst-plugins-good/gst/audioparsers/gstmpegaudioparse.c).

Current code: discovery in `src/mp3/free-format.ts`; the lock and mixing rules in `src/mp3/frame-spans.ts`:

- Reads a bounded 8,647-byte initial probe, tests compatible Layer III/free-format/sample-rate headers, requires at least three sequential candidate headers, and selects the span with the unique greatest header-match count. Equal best scores and insufficient evidence reject. This does not prove that the bytes admit only one plausible framing; a lower-scoring alternative can remain possible.
- Caches the inferred **unpadded** span, adds each frame's padding bit thereafter, and rejects mixing free-format and indexed frames or changing free-format sample rate after acquisition.
- Cannot confidently count truly short ambiguous one-/two-frame free-format streams. **Do not equate this limitation with the ISO declaring such streams invalid.**
- False sync words **can occur inside compressed payload**. A three-header chain is evidence, not proof of a unique possible framing. Fuzz competing candidate spans and prefer bounded rejection over an incorrect positive count.
- Avoid arbitrary unbounded re-synchronization, recursive search, and zero-progress loops. Free-format probing must not affect the indexed-bitrate steady-state path.

## 5. Structural checks vs full ISO bitstream conformance

The parser is a **frame-structure counter**, _not_ a decoder or an ISO/IEC 11172-4-certified conformance validator. It does not establish that CRC checks pass, side-information fields are semantically valid, Huffman data decodes, bit-reservoir dependencies can be satisfied, or playback is gapless. [ISO/IEC 11172-4](https://webstore.iec.ch/en/publication/9590) describes a different, much larger conformance-testing target.

A test's expected value must be explicit about whether it means (1) physically present complete MPEG frame boundaries, (2) the structural count after recognized initial encoder-header exclusion, or (3) frames/packets a specific decoder chose to emit. HTTP omitted/`false` selects (2), HTTP `true` selects (1), and direct parser calls retain (1) as their default. Neither structural policy proves that every counted frame produces decoded audio.

## 6. Test obligations

Assert all table indices 1–14, all three rates, both padding settings, both CRC-protection bits and all four channel modes. Test mixed-bitrate indexed streams, free-format exact span with alternating padding, high-rate 640 kbps/32 kHz, 1-byte chunks, payload sync decoys, competing candidate alignments, short/ambiguous free-format, truncated frame/header, ID3 before/after, and first-frame metadata inclusion/exclusion. Derive independently known counts from generated frame offsets and encoder fixtures; FFprobe/MediaInfo alone are **not** physical-frame ground truth.

Relevant files: [header](../../src/mp3/frame-header.ts), [frame spans](../../src/mp3/frame-spans.ts), [free format](../../src/mp3/free-format.ts), [frame traversal](../../src/mp3/count-frames.ts), [tests](../../tests/free-format.test.ts), [real LAME test](../../tests/free-format-real.test.ts), [conformance](conformance.md).
