# MPEG-1 Audio Layer III: project-specific format contract

**Normative root:** [ISO/IEC 11172-3:1993 (Audio)](https://www.iso.org/standard/22412.html), [technical corrigendum](https://www.iso.org/standard/25371.html). Technical header values below are paraphrased implementer summaries, cross-checked against [FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c) and [mpg123](https://github.com/libsdl-org/mpg123/blob/main/src/libmpg123/mpeghead.h); they are _not_ purported verbatim ISO clauses. See [source hierarchy](README.md).

## 1. Precisely supported format

Only MPEG-**1** Audio Layer **III** (MP3) elementary audio frames. A compliant frame may use any valid MPEG-1 Layer III table bitrate, sample rate, CRC-protection setting, padding setting, channel mode, and other valid header flags. CBR/VBR/ABR describe encoder bitrate behavior; **they are not different MPEG versions or distinct frame header syntaxes**. The frame length must be resolved afresh at each indexed-bitrate frame.

Formats outside this target include MPEG-2 Layer III, non-ISO MPEG-2.5, MPEG-1 Layers I/II, ADTS AAC and MPEG-4/MP4. Recognized nonreserved MPEG version/layer identifiers reject as unsupported; reserved identifiers are malformed. AAC/MP4 declared media types reject as unsupported media, while mislabeled non-MPEG bytes need not be identified by codec. See the [exact input classification contract](input-classification.md). MPEG ancillary data does not change the underlying frame-boundary counting requirement.

## 2. Four-byte header: bit-accurate layout

Header is 32 bits in big-endian/MSB-first order; offsets are bit positions within the 32-bit unsigned header word. The table uses the common eleven-bit sync/two-bit version view for compatibility classification. ISO/IEC 11172-3:1993 describes a twelve-bit sync plus one-bit ID; these identify the same MPEG-1 prefix, without making other version combinations part of its requirements.

| Bits  | Width | Meaning and relevant values                                                 |
| ----- | ----: | --------------------------------------------------------------------------- |
| 31–21 |    11 | Synchronization: all ones (`0x7ff`)                                         |
| 20–19 |     2 | Version: `11` = MPEG-1; `10` MPEG-2; `00` MPEG-2.5 extension; `01` reserved |
| 18–17 |     2 | Layer: `01` = III; `10` = II; `11` = I; `00` reserved                       |
| 16    |     1 | Protection: `0` means protected by a 16-bit CRC; `1` no CRC                 |
| 15–12 |     4 | Bitrate index: `0000` free-format, `0001`–`1110` table, `1111` forbidden    |
| 11–10 |     2 | Sampling-rate index: `00` 44100, `01` 48000, `10` 32000 Hz; `11` reserved   |
| 9     |     1 | Padding: `0` = no extra slot, `1` = one byte for Layer III                  |
| 8     |     1 | Private application bit: must not change Layer III frame sizing             |
| 7–6   |     2 | Channel mode: `00` stereo, `01` joint stereo, `10` dual channel, `11` mono  |
| 5–4   |     2 | Mode extension: may affect audio coding, **not** frame byte length          |
| 3     |     1 | Copyright flag: not a validity or length discriminator                      |
| 2     |     1 | Original/home flag: not a validity or length discriminator                  |
| 1–0   |     2 | Emphasis: `00` none, `01` 50/15 µs, `10` reserved, `11` CCITT J.17          |

**Valid MPEG-1 Layer III indexed bitrate table**, from `BITRATES_KBPS` ([source](../../src/mp3/frame-header.ts)):

| Index (hex) | 0    | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | A   | B   | C   | D   | E   | F         |
| ----------- | ---- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --------- |
| kbps        | free | 32  | 40  | 48  | 56  | 64  | 80  | 96  | 112 | 128 | 160 | 192 | 224 | 256 | 320 | forbidden |

Frame header bit fields are unsigned; do not let JavaScript signed 32-bit operators change the interpretation of the highest bit. The emphasis value `10` is reserved, and the current strict project policy rejects it; some real-world decoders tolerate it as an interoperability exception.

## 3. Indexed frame length and boundaries

For bitrate index 1–14, with `bitrateKbps` from the table, `sampleRateHz` from the header and `paddingBit` in {0,1}:

```text
frameLengthBytes = floor(144000 * bitrateKbps / sampleRateHz) + paddingBit
```

MPEG-1 Layer III normally represents **1152 PCM samples per frame**, independent of the header's channel mode. This audio sample count does _not_ imply a count of decoded frames (encoder delay, padding, and metadata-only frames alter reporting by tools).

- Four header bytes belong to `frameLengthBytes`. Optional CRC bytes, side information, audio data and ancillary bytes are **within** the computed frame length; never add CRC bytes again.
- Protected ordinary Layer III frames have a 16-bit CRC field associated with the frame. The project recognizes the protection bit but does **not** verify CRC or Huffman/side-information integrity.
- Mono has 17 bytes of MPEG-1 Layer III side information, other channel modes have 32. This does not change the frame-length formula, but the complete frame must contain its 4-byte header, optional 2-byte CRC and that side information. These fields cannot be borrowed from the bit reservoir. See [RFC 5219 §3](https://www.rfc-editor.org/rfc/rfc5219.html#section-3), independently corroborated by [LAME's prefix sizing](https://github.com/lameproject/lame/blob/1f5cc9487284d5950343aa5d4f70de433468070a/libmp3lame/lame.c#L962-L969). This is a size check, not decoding or CRC validation.
- After parsing a valid header at offset `o`, skip exactly `frameLengthBytes` and expect the next header at `o + frameLengthBytes` (or one of the explicitly supported trailing tags/EOF). Ignore apparent sync markers inside that payload.
- No file-size-derived approximate count, first-frame-only bitrate assumption, or Xing/VBRI count shortcut can replace this traversal for an **exact physical-frame count**.
- Reject incomplete final headers, incomplete final frames, invalid indices, and nonmetadata garbage at required boundaries under the project's strict policy.

## 4. Free-format Layer III (bitrate index zero)

**Index `0000` is valid, not reserved.** It encodes no table-defined bitrate, so the indexed length formula alone is insufficient. [LAME's original documentation](https://github.com/lameproject/lame/blob/master/USAGE) calls this a fixed-bitrate free-format stream, encodable at arbitrary integer rates from 8 to 640 kbps, and notes that generally conforming decoders need support only up to 320 kbps. The project's **640 kbps** interoperability goal is broader than the minimum decoding requirement.

The minimum complete prefix is **21 bytes for mono without CRC**, 23 for protected mono, 36 for other modes without CRC, and 38 for protected other modes. ISO/IEC 11172-3:1993 §§2.4.1.3/.4/.7 and 2.4.3.4.3 establish these fields; there is no 24-byte or 8 kbps format floor. An original 21-byte mono fixture at 48 kHz is exactly 7 kbps (§2.4.3.1): all-zero side information gives no reservoir dependency, scale-factor bits or Huffman bits, and zero spectral values (§§2.4.2.7, 2.4.3.4.5/.6). A protected 23-byte control includes an independently checked CRC. These are original test fixtures, not standard-document bytes; runtime still does not decode or verify CRC.

The searched value is an **unpadded** span. A 20-byte base can occupy 21 physical bytes when padded, so search includes it and validates every selected frame's actual prefix. Finite all-padded base-20 tests exercise structural policy, not proof of a conformant long-term bitrate/padding schedule. The normative 7 kbps fixture is unpadded; the padding recommendation in §2.4.2.3 is not turned into an invented mandatory first-frame rule.

For consecutively aligned frames, infer **one fixed unpadded byte span**:

```text
baseLength = secondFrameStart - firstFrameStart - firstFramePadding
frameLength(i) = baseLength + paddingBit(i)
```

This is a structural inference from frame starts, not a reconstructed bitrate table. With LAME's documented upper rate and 32 kHz sample rate, `floor(144000 * 640 / 32000) + 1 = 2881` bytes. **2881 is a project interoperability/DoS bound inferred from LAME's ceiling, not a universal ISO-defined maximum**. See [LAME VbrTag.c](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.c) (the encoder has a 2880-byte free-frame constant), [mpg123 inference](https://github.com/libsdl-org/mpg123/blob/main/src/libmpg123/parse.c), and [GStreamer free-rate inference](https://github.com/GStreamer/gstreamer/blob/main/subprojects/gst-plugins-good/gst/audioparsers/gstmpegaudioparse.c).

Successive in-file sample-rate configurations follow the [bounded sequence policy](successive-sequences.md), a project compatibility choice rather than an asserted universal ISO concatenation mandate.

Current code: discovery in `src/mp3/free-format.ts`; the lock and mixing rules in `src/mp3/frame-spans.ts`:

- Searches one bounded **8,647-byte** probe, with one additional unsearched byte of lookahead to distinguish an exactly full probe at EOF from a longer stream. Candidate unpadded spans are 20–2,880 bytes; each current frame adds its own padding. Compatible headers have the same free-format mode and sample rate.
- At a **candidate's predicted frame boundary**, shared ID3 validation can skip a complete metadata tag. A complete validated ID3v2 header can also anchor a tag larger than the probe: normal traversal subsequently streams its body, checks its footer and validates the next MPEG header. This works before length acquisition, including tag ends on either side of the probe edge, without buffering album art.
- Rank candidates by compatible MPEG-header count, then validated metadata-boundary evidence. Equal best evidence returns `unsupported-format`, rather than choosing an arbitrary span. A conflicting supported changed-rate layout also vetoes a numeric count; successor headers do not vote for the prior span. Three-header chains retain the previous inference behavior; this remains evidence, not proof of a unique decoding.
- One-/two-header candidates require **EOF closure, a validated metadata anchor or supported changed-rate evidence**, room for each mandatory prefix, and no unexplained compatible header or plausible metadata prefix inside their proposed payloads. Any available `ID3` header bytes that already show an unsupported version, reserved flags or non-synchsafe size are not competing supported metadata; nor is any available footer byte that disagrees with its header-derived expected value; neither is `TAG` more than 128 bytes before the minimum possible stream end established by available bytes and the candidate frame end. A final ID3v1 boundary adds ranking evidence only when EOF is proved; the probe edge alone is not a tail boundary. An unproved tail does not erase preceding validated ID3v2 anchors; subsequent streaming traversal still validates the tail completely. Partial headers/footers remain conservative evidence only while every available byte is compatible with a supported envelope. Unknown fields are not used to infer a tag size or footer. Known-boundary readers still require the complete ten-byte header/footer and retain their strict truncation behavior. This short-stream rule is **project policy**, not an ISO minimum or a normative inference algorithm.
- Once chosen, cache the **unpadded** span and validate every later boundary without payload scanning. A valid sample-rate change at a resolved boundary resets the configuration and reacquires a free span when needed. Same-rate free/indexed switching retains its rejection policy, not a claimed ISO prohibition. The current frame must fit its 4-byte header, optional 2-byte CRC and 17/32-byte side information. Invalid/unsupported later headers keep their own typed errors.
- **Unavoidable limits:** a free-format header does not encode its length. A singleton's EOF can be consistent both with a complete frame and a truncated larger frame, or with a frame plus additional ancillary/trailing bytes. The counter cannot distinguish all such cases without deeper audio/side-information validation or external framing. Conservative plausible-prefix rejection can still reject real payload coincidences. Conversely, before a span is established, an invalid or unsupported metadata envelope after audio is indistinguishable from ancillary bytes; it need not produce the malformed-tag error that the same bytes produce at an established boundary. These are compatibility/inference limits, not declarations that short files are ISO-invalid.
- The assessment states no minimum duration. Committed fixtures include **48 normally flushed libLAME 3.100 streams**, with one or two frames, all three sample rates, mono/stereo, CRC on/off and 128/400 kbps. They were never trimmed from longer files. Encoder frame totals and a separate walk using the known encoder bitrate/padding agree exactly; independent HIP decoding corroborates PCM output but does not itself validate the complete ancillary span.
- Ancillary-decoy tests alter only verified unused bytes of the genuine silent mono singleton: its reservoir pointer and both granule bit lengths are zero. [LAME's original side-information writer](https://github.com/lameproject/lame/blob/1f5cc9487284d5950343aa5d4f70de433468070a/libmp3lame/bitstream.c) corroborates the field order/widths; independent HIP decoding retains 1,152 silent samples after each replacement. New sequence evidence reads the backward offset, declared main-data lengths and spectral-pair counts for necessary side-information bounds; no audio decoding or reservoir-availability validation is added.
- Mature-reader corroboration is narrower than our policy: [mpg123](https://github.com/libsdl-org/mpg123/blob/eb1138723913c3879f414b4918a79df3b355bbca/src/libmpg123/parse.c) and [libmad](https://github.com/sezero/libmad/blob/master/frame.c) acquire from a next header; [minimp3](https://github.com/lieff/minimp3/blob/ea99364f61c14656440e8d77e9c233ccf3124633/minimp3.h) uses a third. No one-frame EOF fallback was established in those readers. [LAME's HIP implementation](https://github.com/lameproject/lame/blob/1f5cc9487284d5950343aa5d4f70de433468070a/mpglib/interface.c) can emit decoded samples before the full free-format span is known; a zero-input decode call drains buffers, not an EOF signal.
- Candidate work is bounded independently of upload length, using fixed-window caching and cooperative scheduling rather than a total-work format rejection in the [sequence policy](successive-sequences.md#resource-bounds). Every candidate step advances by at least 20 bytes; every skipped tag consumes at least ten bytes; within the probe, the byte bound also bounds the number of tag iterations. Ordinary indexed traversal has no inference work. No unbounded resynchronization, recursion or backtracking is added.

## 5. Structural checks vs full ISO bitstream conformance

The parser is a **frame-structure counter**, _not_ a decoder or an ISO/IEC 11172-4-certified conformance validator. It does not establish that CRC checks pass, side-information fields are semantically valid, Huffman data decodes, bit-reservoir dependencies can be satisfied, or playback is gapless. [ISO/IEC 11172-4](https://webstore.iec.ch/en/publication/9590) describes a different, much larger conformance-testing target.

A test's expected value must be explicit about whether it means (1) physically present complete MPEG frame boundaries, (2) the structural count after recognized initial encoder-header exclusion, or (3) frames/packets a specific decoder chose to emit. HTTP omitted/`false` selects (2), HTTP `true` selects (1), and direct parser calls retain (1) as their default. Neither structural policy proves that every counted frame produces decoded audio.

## 6. Test obligations

Assert all table indices 1–14, all three rates, both padding settings, both CRC-protection bits and all four channel modes. Test mixed-bitrate indexed streams, free-format exact span with alternating padding, high-rate 640 kbps/32 kHz, 1-byte chunks, payload sync decoys, competing candidate alignments, short/ambiguous free-format, truncated frame/header, ID3 before/after, and first-frame metadata inclusion/exclusion. Derive independently known counts from generated frame offsets and encoder fixtures; FFprobe/MediaInfo alone are **not** physical-frame ground truth.

Relevant files: [header](../../src/mp3/frame-header.ts), [frame spans](../../src/mp3/frame-spans.ts), [free format](../../src/mp3/free-format.ts), [frame traversal](../../src/mp3/count-frames.ts), [tests](../../tests/free-format.test.ts), [real LAME test](../../tests/free-format-real.test.ts), [conformance](conformance.md).
