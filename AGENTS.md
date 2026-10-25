# AI agent context: MP3 frame analyzer

Read this file before changing parser, API, fixtures, fuzzers, or counts. This file indexes **project policy** and **authoritative source-backed format rules**, not a substitute for either.

## Instruction/source precedence

1. [Original candidate assessment](docs/assessment-brief.md) controls the mandatory deliverable: TypeScript, `POST /file-upload`, MPEG-1 Audio **Layer III** frame counting, JSON `{"frameCount": number}`, no NPM package that parses MPEG frames for the implementation, and a Git repository with run/test instructions.
2. [Assessment-only requirements and evaluator risk](docs/specifications/assessment-scope.md) distinguishes what the task explicitly requires from format compatibility and engineering enhancements.
3. [Frame-count contract](docs/frame-count-contract.md) records the **owner-selected HTTP policy (2026-10-24)**: omitted or `includeVbrHeaderFrame=false` excludes one recognized initial Xing/Info/VBRI encoder frame; `true` counts all physical MPEG frames. Direct `countMp3Frames()` calls retain their physical default. The supplied sample returns 6089 by HTTP default and 6090 with `true`. This breaking HTTP change is explicitly authorized by the owner; evaluator intent remains inferred from the MediaInfo suggestion, not confirmed by the evaluator. Further default changes require an explicit owner decision.
4. [Authoritative specifications registry](docs/specifications/README.md) identifies ISO/IEC, ID3, IETF/IANA and original encoder sources, including what they **do not** require. Read the relevant topic:
   - [MPEG-1 Layer III syntax and free-format](docs/specifications/mpeg-1-layer-iii.md)
   - [ID3, Xing/Info/LAME and VBRI](docs/specifications/tags-and-encoder-headers.md)
   - [HTTP API, media types and security limits](docs/specifications/http-api.md)
   - [Conformance / exclusions / verification matrix](docs/specifications/conformance.md)
5. [Architecture](docs/architecture.md), [security](docs/security.md), [testing](docs/testing.md), and source code establish the current implementation and resource policies. If they conflict with an upstream format rule, surface the disagreement; do not silently widen scope or redefine a standard.

## Current design invariants (not additional assessment requirements)

**Scope gate:** Only requirements called out in the [assessment-only checklist](docs/specifications/assessment-scope.md) are mandated by the employer. The 50 MiB limit, raw uploads, metadata-exclusion option, extended free-format range, fuzzing and release tooling are established **project choices**, not extra conditions imposed by the brief. Keep them working but never broaden unrelated scope to satisfy a reference appendix.

- MPEG-1 is version bits `11`; Layer III is layer bits `01`. Support bitrate indices 1–14 **and free-format index 0** (bounded frame-spacing inference); reject reserved index 15 and reserved sample rate 3. MPEG-2, MPEG-2.5, Layers I/II, ADTS/AAC and MP4 are out of assessment scope.
- Compute indexed frame lengths independently for **every frame**, including VBR/ABR, rather than multiplying the first frame length by the count or trusting a Xing/VBRI count.
- Free-format has no table bitrate; cache the **unpadded frame length**, then apply each frame's padding. Confirm competing sync candidates conservatively; do not guess on ambiguous short streams. Never allow unbounded lookahead, rescans or backtracking.
- **Current owner-selected policy:** HTTP omitted/`false` excludes at most one recognized _initial_ Xing/Info/VBRI encoder frame; HTTP `true` and direct parser calls with no option count complete physical MPEG frames. **ID3 frames are metadata records, not MPEG audio frames.** Exclusion must recognize the initial encoder structure, never subtract one blindly, and does not prove that every counted frame decodes to audio.
- Skip supported ID3 tags from their encoded, bounded lengths; do not interpret tag content, decompress, execute, download art, log uploaded bytes, or load entire uploads into memory.
- Preserve `AsyncIterable<Uint8Array>` parsing, bounded memory, streaming backpressure, raw/multipart per-file 50 MiB limits, typed deterministic failures, and JSON response format.
- A structurally valid MPEG header chain is **not proof of decodable audio or valid CRC**. Do not claim this service is a full Layer III decoder or formal ISO bitstream-conformance validator.
- Classify requirements explicitly as `ISO/RFC normative`, `ID3 informal standard`, `encoder convention`, or `project-specific policy`. Do not promote a decoder implementation or MIME interoperability preference to an ISO requirement.

## Source/test map

`src/mp3/frame-header.ts`: bitfields and bitrate table.
`src/mp3/free-format.ts`: bounded free-format discovery.
`src/mp3/count-frames.ts`: streaming boundaries and count semantics.
`src/mp3/id3.ts`: tag sizing; `src/mp3/vbr-header.ts`: recognized initial encoder frame.
`src/mp3/byte-reader.ts`: chunk partition independence / bounded memory.
`src/upload.ts`: raw and multipart upload policies (media types, limits, unread remainder).
`src/error-response.ts`: maps every failure the route raises to its JSON error response.
`src/client-error.ts`: the one deliberate, client-facing failure type.
`src/app.ts`: route, query option and Fastify wiring.

Domain terms live in [`GLOSSARY.md`](GLOSSARY.md); architecture decisions live in [`docs/adr/`](docs/adr/).

Add focused tests in `tests/` and independent generated encoder fixtures; expand `fuzz/` oracles when widening format acceptance. Run `npm run check`, `npm run fuzz:regression`, `npm run mutation` and relevant memory/HTTP benchmarks. Do not use FFprobe/MediaInfo decoded counts as an oracle for physical counts without reconciling the leading metadata frame.

For standards changes, update the source registry and conformance matrix in the **same PR**. Prefer primary references linked in the registry; do not paste proprietary ISO text into the repository.
