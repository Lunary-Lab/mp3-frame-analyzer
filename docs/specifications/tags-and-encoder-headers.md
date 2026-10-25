# MP3 metadata and encoder-header boundary specifications

These structures are **not MPEG-1 Layer III audio decoding**. They affect where MPEG frames begin/end and how the selected policy counts an initial metadata-bearing MPEG frame. See [authority registry](README.md), [MPEG-1 frame contract](mpeg-1-layer-iii.md), and the [owner-selected count contract](../frame-count-contract.md).

## 1. Terminology: never confuse these "frames"

- **MPEG audio frame:** a physical frame beginning with a 4-byte MPEG header; included by physical counting, while the HTTP default can exclude one recognized initial encoder-metadata frame.
- **ID3v2 frame:** a record _inside an ID3 tag_, such as a title or embedded picture; never an MPEG audio frame and never counted.
- **Xing/Info/LAME/VBRI encoder header frame:** a physical MPEG audio frame whose ancillary/payload region contains indexing or encoding metadata. A recognized initial frame is excluded by HTTP omitted/`false` and included by HTTP `true`. Direct parser calls retain their physical default.

ID3 formats are independent _informal standards_. Xing/Info and VBRI are _de facto encoder conventions_. None redefines the MPEG bitrate table or the Layer III frame-size formula.

## 2. ID3v2 header sizes and version differences

Primary format-author specifications:

- [ID3v2.2.0](https://id3.org/id3v2-00), `3.1`
- [ID3v2.3.0](https://id3.org/id3v2.3.0), `3.1`
- [ID3v2.4.0 Main Structure, §§3.1–3.4 and 5–6](https://id3.org/id3v2.4.0-structure)

All have a 10-byte _tag_ header (distinct from the size of any internal ID3 record):

| Header bytes | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| 0–2          | ASCII `ID3`                                                             |
| 3            | Major version `0x02`, `0x03` or `0x04`                                  |
| 4            | Revision byte (not `0xff`)                                              |
| 5            | Version-specific flag byte                                              |
| 6–9          | 28-bit synchsafe tag data length: each source byte's high bit must be 0 |

Tag body length:

```text
body = (b6 << 21) | (b7 << 14) | (b8 << 7) | b9
total = 10 (header) + body + (hasV24Footer ? 10 : 0)
```

The encoded tag size _excludes_ the leading header and _excludes_ the optional v2.4 footer; it includes tag body, extended headers and padding after application of any unsynchronization. For **counting**, skip the encoded byte length. Do not try to parse/decompress ID3 record contents, embedded artwork, or text to find audio boundaries.

**Permitted header flags** (other bits reserved under the respective ID3 informal standard):

| Version | Allowed flag mask | Relevant bits                                                         |
| ------- | ----------------- | --------------------------------------------------------------------- |
| ID3v2.2 | `0xc0`            | `0x80` unsynchronization, `0x40` compression                          |
| ID3v2.3 | `0xe0`            | `0x80` unsynchronization, `0x40` extended header, `0x20` experimental |
| ID3v2.4 | `0xf0`            | Same as v2.3 plus `0x10` optional footer                              |

ID3v2.2 expressly advises skipping/ignoring a compressed tag when the format is unknown. The frame counter can **skip** the entire tag using its validated outer size without decompressing it. ID3v2.3's per-record frame lengths are not the same representation as v2.4's; the project has no need to interpret those records.

ID3v2.4 trailing footer:

- Optional at the tag level but **required when ID3v2.4 is appended after the audio**.
- Exactly 10 bytes, begins with ASCII `3DI`, then mirrors the corresponding header's version, flags and encoded size.
- Footer flags/size must match the header, and truncated/mismatched footers are errors.
- ID3v2.4 disallows padding when a footer is used (specification detail, **not currently verified by the structural tag skipper**, which does not decode internal records).
- ID3v2.4 §5 allows prepend, append, and prepend-plus-append (with a SEEK frame required for its recommended paired-tag layout). The endpoint accepts **consecutive ID3v2 tags per MPEG boundary**, including repeated appended v2.4 tags, followed by at most one final ID3v1. Every tag in a trailing run needs its own matching footer. The former eight-tag restriction was removed: every iteration consumes at least ten bytes, so memory and work remain bounded by the streaming cursor and total input bytes, not a tag-count limit.

Embedded placement is explicit in the author specifications: ID3v2.2 §4.19 (`BUF`), ID3v2.3 §4.19 (`RBUF`) and [ID3v2.4 Frames §4.18](https://id3.org/id3v2.4.0-frames) describe tags **between MPEG frames**. The [FAQ](https://id3.org/FAQ) corroborates this. Such tags may be footerless; parsing resumes in the existing MPEG mode. A footerless tag followed only by EOF or ID3v1 is appended, not embedded, and is rejected.

The skipper validates outer version/flags/synchsafe size and matching footer, not internal records. It does not enforce minimum record counts, extended-header semantics, padding restrictions, SEEK/RBUF contents, compression, encryption or unsynchronization correctness. The new layout fixtures include actual title, buffer, SEEK and update records; this is not a claim that every accepted metadata body conforms. A SEEK fixture points from the current tag's end to the **next** tag, not past an intervening tag.

## 3. ID3v1 and ID3v1.1

[ID3.org's original ID3v1 description](https://id3.org/ID3v1) documents a **fixed 128-byte** trailing metadata block with ASCII `TAG` at its start. ID3v1.1 reuses the same block size; the track number alters only its internal interpretation. Neither should count as MPEG audio.

At an expected post-frame boundary, accept a final 128-byte `TAG` block and then require EOF. **Do not** treat an incidental `TAG` occurrence _inside_ an MPEG frame payload as a tag. After a known indexed or locked free-format frame boundary, strict EOF handling rejects arbitrary extra trailing data. Initial short free-format EOF inference has the separate ambiguity limits described in [MPEG syntax](mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero).

## 4. Xing / Info / LAME metadata

Primary source is the **encoder implementation**, not ISO MPEG:

- [LAME VbrTag.h](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.h) flags and data contract
- [LAME VbrTag.c](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.c) actual writing/parsing and first-frame handling
- [LAME API](https://github.com/lameproject/lame/blob/master/API) explicitly states that the tagging call creates a valid additional MP3 frame

The first MPEG Layer III frame may contain an ancillary-data signature `Xing` (commonly VBR/ABR) or `Info` (commonly CBR) plus a 32-bit flags word. Up to four optional fields follow, in order:

| Flag bit | Optional field                              |
| -------- | ------------------------------------------- |
| `0x0001` | 32-bit big-endian declared frame count      |
| `0x0002` | 32-bit big-endian declared stream byte size |
| `0x0004` | 100-byte seek table                         |
| `0x0008` | 32-bit big-endian VBR quality/scale         |

LAME extends these structures with version, gapless delay/padding and other encoding metadata. **`LAME` is not a separate additional MPEG frame by itself**. Validate every optional field's boundary before reading it. Do **not** trust the declared count/byte size for an exact physical traversal; they can differ after editing, concatenating or truncating the file.

For MPEG-1 Layer III, an unprotected initial Xing/Info tag is conventionally at offset `4 + (mono ? 17 : 32)` from the start of its MPEG frame. CRC-protected _encoder header_ placement has interoperability quirks: compare the original LAME implementation and the repository's candidate offsets; do not assert a single ISO-mandated Xing offset or blindly copy the ordinary MPEG CRC offset as an encoder-header rule.

HTTP default and explicit `includeVbrHeaderFrame=false`: exclude at most **one** structurally recognized initial metadata frame. Explicit `true`: include every complete physical frame. Direct `countMp3Frames()` calls retain their physical default. Do not subtract based on arbitrary string matches within audio payload or on the encoder's declared count, and do not infer decoded-audio validity from structural recognition.

## 5. VBRI

VBRI is a Fraunhofer-associated encoder header convention, **not part of ISO MPEG-1 Layer III's four-byte header**. A freely accessible, authoritative normative _VBRI specification_ was not established for this assessment, so treat the observed layout in [FFmpeg's reader](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3dec.c) (`mp3_parse_vbri_tag`) and [TagLib's parser](https://github.com/taglib/taglib/blob/master/taglib/mpeg/xingheader.cpp) as corroborating implementation references, **not an ISO standard**.

- FFmpeg probes signature `VBRI` at byte offset `4 + 32 = 36` from the MPEG frame start.
- A recognized version-1 header carries declared byte/frame counts and seeking-table information. The current project requires a nonempty table with widths 1–4 and a complete `26 + entries × width` body. [GStreamer's reader](https://github.com/GStreamer/gstreamer/blob/main/subprojects/gst-plugins-good/gst/audioparsers/gstmpegaudioparse.c) corroborates those fields, but accepts some headers without a usable table. Thus our nonempty-table recognition is a **stricter project policy**, not proven universal VBRI validity.
- Its presence never authorizes accepting a malformed MPEG frame, trusting the declared count for physical traversal, or subtracting an unconditional frame.

## 6. Other tag families / strict-policy boundaries

- **APE/APE2** and **Lyrics3** metadata occur in some real `.mp3` files. [ID3.org's Lyrics3 page](https://id3.org/Lyrics3) describes Lyrics3 placement; these are not Layer III header types. Neither is explicitly required by the assessment; the owner kept additional families outside this change. Their absence is a compatibility limitation, not proof that a tagged MPEG-1 Layer III file changes codec. No arbitrary other-family trailer is skipped.
- MPEG payloads can contain false sync words, `ID3` strings or `TAG` strings. Indexed and locked traversal never scans inside a declared frame. During initial free-format inference, metadata is examined only at each proposed fixed-span boundary; short candidates with still-plausible supported metadata prefixes are conservatively rejected. Known-invalid ID3 bytes and TAG strings ruled out by the candidate/available-byte length are not metadata evidence; a bounded probe end is not assumed to be EOF.
- [RFC 3003 §1](https://www.rfc-editor.org/rfc/rfc3003.html) allows `audio/mpeg` streams with interspersed non-MPEG material. This endpoint deliberately implements a **stricter validated-file policy**. Do not describe the broader RFC's permitted material as inherently forbidden by MPEG.
- Distinguish a corrupt tag (incorrect synchsafe size, unsupported version/flags, missing bytes/footer) from absent metadata. Never silently walk bytes of a malformed tag as though they were audio.

## 7. Relevant source and tests

[`id3.ts`](../../src/mp3/id3.ts), [`count-frames.ts`](../../src/mp3/count-frames.ts), [`encoder-frame.ts`](../../src/mp3/encoder-frame.ts), [`id3.test.ts`](../../tests/id3.test.ts), [`metadata-layouts.test.ts`](../../tests/metadata-layouts.test.ts), [`encoder-layouts.test.ts`](../../tests/encoder-layouts.test.ts), [`count-frames.test.ts`](../../tests/count-frames.test.ts), and [`frame-count-contract.md`](../frame-count-contract.md).
