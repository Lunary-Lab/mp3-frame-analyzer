# Supported, unsupported and malformed input

This is the **project error contract**, not an ISO conformance certificate. The
assessment requires MPEG-1 Layer III counting; other MPEG formats are outside
its scope. The parser reads structural boundaries, not decoded audio or CRC
integrity. HTTP mappings and message wording are application decisions.

## Evidence and limits

- The [ID3v2.2 §3.1](https://id3.org/id3v2-00),
  [ID3v2.3 §3.1](https://id3.org/id3v2.3.0), and
  [ID3v2.4 §3.1](https://id3.org/id3v2.4.0-structure) author specifications forbid
  `0xff` in either version byte. This is an informal-format rule, distinct from
  an unknown major version such as 5. Revisions 0–254 remain accepted for the
  supported major versions 2, 3 and 4; metadata content is opaque.
- ISO/IEC 11172-3:1993 §§2.4.1.3 and 2.4.2.3 define the MPEG-1 header and
  field meanings, including reserved layer `00` and forbidden bitrate index
  `1111`. The standard's MPEG-1 layout uses a twelve-bit sync and one-bit ID;
  the implementation's eleven-bit sync/two-bit version view also identifies
  out-of-scope MPEG-2 and MPEG-2.5. The reserved two-bit version `01` is not
  another supported codec. [FFmpeg's header checker](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.h)
  and [mpg123's header definitions](https://github.com/libsdl-org/mpg123/blob/main/src/libmpg123/mpeghead.h)
  provide independent implementation context, not additional ISO requirements.
  These are original summaries; standard-document bytes and full decoder
  conformance are outside this repository.
- [RFC 3003](https://www.rfc-editor.org/rfc/rfc3003.html) covers MPEG audio more
  broadly than MPEG-1 Layer III. An accepted `audio/mpeg` declaration, `.mp3`
  filename or sync marker alone does not establish supported audio.

## Input/error matrix

Both upload forms return JSON `{"error": string, "message": string}` on the
application errors below. The direct parser uses `Mp3ParseError` with `kind`,
`message` and byte `offset`, without HTTP status.

| Observed input                                                                                                       | Direct-parser result                                                                                    | HTTP result / exact message                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Complete supported MPEG-1 Layer III indexed frames                                                                   | Traversed physical count                                                                                | 200, `{"frameCount": N}`, subject to the existing first-encoder-frame policy                        |
| Free-format index 0 with sufficient unambiguous bounded evidence                                                     | Supported under the [inference profile](mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero) | 200; insufficient/ambiguous inference remains 415, not proof of ISO-invalid audio                   |
| Supported ID3v2.2/.3/.4 envelopes and allowed placement                                                              | Skip metadata, count MPEG frames                                                                        | Same count; ID3 records are not MPEG frames                                                         |
| Nonreserved MPEG-2/2.5 or Layer I/II identifiers                                                                     | `unsupported-format`                                                                                    | 415, `Only MPEG-1 Layer III is supported`                                                           |
| Reserved MPEG version `01` or layer `00`, bad sync; forbidden bitrate or reserved rate/emphasis in the target format | `invalid-mp3`                                                                                           | 422, `Invalid MPEG-1 Layer III frame header`                                                        |
| Unknown ID3 major version, without forbidden `0xff` identifiers                                                      | `unsupported-format`                                                                                    | 415, `Unsupported ID3v2 version`                                                                    |
| ID3 major or revision byte `0xff`                                                                                    | `invalid-mp3`                                                                                           | 422, `ID3v2 version and revision must not be 0xff`                                                  |
| Reserved flags in a supported ID3 header                                                                             | `invalid-mp3`                                                                                           | 422, `Reserved ID3v2 flags are set`                                                                 |
| Non-synchsafe supported ID3 size                                                                                     | `invalid-mp3`                                                                                           | 422, `Invalid synchsafe ID3v2 size`                                                                 |
| Complete but mismatched ID3v2.4 footer                                                                               | `invalid-mp3`                                                                                           | 422, `Invalid ID3v2 footer`                                                                         |
| Recognized ID3 prefix with fewer than ten header bytes                                                               | `truncated-mp3`                                                                                         | 422, `Incomplete ID3v2 tag header`                                                                  |
| Incomplete required ID3v2.4 footer                                                                                   | `truncated-mp3`                                                                                         | 422, `Incomplete ID3v2 footer`                                                                      |
| Recognized supported frame or metadata body runs past EOF                                                            | `truncated-mp3`                                                                                         | 422, `Unexpected end of MP3`                                                                        |
| One to three bytes after a complete frame                                                                            | `truncated-mp3`                                                                                         | 422, `Incomplete trailing frame header`                                                             |
| Fewer than four initial MPEG bytes or only supported leading metadata                                                | `invalid-mp3`                                                                                           | 422, `No MPEG-1 Layer III frames found`                                                             |
| Empty input                                                                                                          | `invalid-mp3`, no frames                                                                                | Upload layer rejects first: 400 `empty-file`, `The MP3 file must not be empty`                      |
| Declared unsupported media type, including AAC/MP4                                                                   | Not invoked                                                                                             | 415 `unsupported-media-type`; raw: `Expected an MP3 upload`; multipart file: `Expected an MP3 file` |
| AAC/MP4 bytes mislabeled with an accepted MIME type                                                                  | `invalid-mp3` for the committed fixtures                                                                | 422, invalid MPEG header; no universal codec/container sniffer                                      |

`unsupported-format` is **not a validity assertion** for the rejected family.
The parser recognizes nonreserved version/layer identifiers and stops; it does
not validate that family's remaining header, frame geometry or payload. Tests
cover all 16 version/layer bit combinations, but do not assert that every
nonreserved combination, notably MPEG-2.5 with another layer, is a defined codec.
Unknown future ID3 versions are likewise not asserted to be valid encodings.

Unrecognized junk is not relabeled as a known unsupported codec. APE/Lyrics3
remain unrecognized optional metadata families, not newly implemented tag
parsers. No out-of-scope decoder or MIME-sniffing dependency is added.

## Precedence and chunk invariance

1. A complete MPEG header is required before classification. After a complete
   MPEG frame, one to three remaining bytes (even `ID3`) retain the incomplete
   trailing-frame-header error before metadata dispatch. Missing sync and
   reserved version/layer identifiers are invalid; the other-family scope gate
   follows. Other fields are validated only for MPEG-1 Layer III. This preserves
   the existing unsupported-family precedence without pretending to validate it.
2. At a known ID3 boundary, fewer than ten bytes remain truncated even if an
   available byte is already forbidden. For complete headers, forbidden version
   bytes precede the unknown-major scope gate; known-version flags and size
   validation follow. Unknown-major flags/body layouts are not interpreted.
3. Required header errors after indexed or locked free-format frames report
   themselves, not a misleading bitrate-mode mixing error. Offsets identify
   the header start (synchsafe size failures identify the offending byte).
4. Bounded free-format candidate probes are not known frame boundaries. Their
   existing conservative inference/ambiguity policy is unchanged. A failed
   inference can therefore precede a later candidate metadata diagnostic.
5. Transport errors, empty-upload checks and size-limit observation keep their
   existing precedence. A later upload-limit violation need not override an
   already observed malformed header. Frame-count policy is unchanged.

## Tests and fixture provenance

- `format-classification.test.ts`: all 672 indexed bitrate/rate/padding/CRC/mode
  geometries, 384 combinations of non-length header fields, every allowed ID3
  revision, and exact error kind/message/offset at first, leading-tag, indexed
  and locked-free-format boundaries (including 21-/23-byte mono prefixes) under
  three chunk partitions.
- `format-classification-http.test.ts`: the identifier/error matrix through
  raw and multipart uploads, exact status/JSON/message, supported indexed and
  ID3 cases, and independent empty/truncated/malformed checks. The complete
  identifier matrix also crosses real TCP with explicit one-/seven-byte HTTP
  transfer chunks; parser chunk-partition invariance is checked separately.
- `unsupported-formats.test.ts` and `fixtures/unsupported-formats.json`: six
  complete self-generated sine-wave encodings: MPEG-2 Layer III, MPEG-2.5 Layer
  III, MPEG-1 Layer II, MPEG-2 Layer II, AAC ADTS and AAC in MP4. The manifest
  records the FFmpeg version, exact generation command, SHA-256, FFprobe codec,
  rate/channel/decoded-frame observations and bytes. Each was decoded to a null
  sink during generation; tests consume committed bytes without requiring
  FFmpeg. Decoded counts are provenance, **not the parser's physical-count oracle**.
- Layer I and the remaining identifier combinations are explicitly **header-only
  structural rejection cases**, not encoder-produced or decoder-certified files.
  Positive structural fixtures likewise do not establish decoded-audio or CRC
  validity. Existing genuine MPEG-1 CBR/VBR/short-free-format fixtures complement
  them; this change does not replace those tests or claim every possible format.
