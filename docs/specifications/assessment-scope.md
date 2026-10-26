# Assessment-only requirements and expected behavior

**Authority:** [Original technical assessment and dated evaluator clarification](../assessment-brief.md).
This page is the short, controlling checklist for assessment scope. The other
files in this directory are reference material, not additional assignment
requirements. [ISO/IEC 11172-3:1993](https://www.iso.org/standard/22412.html)
defines the MPEG-1 Audio format. The publicly available ISO catalog does not
provide the entire technical text, so do not claim a certified ISO conformance
audit from these summaries alone.

## Explicit pass/fail deliverables

- Implement the assessment in **TypeScript**.
- Expose **`POST /file-upload`** accepting an uploaded MP3 file. No other
  endpoint is specified.
- Count **MPEG Version 1 Audio Layer 3 (MPEG-1 Layer III)** frames by actually
  parsing MP3 frame data. Do not estimate solely from file size, bitrate,
  duration, encoder-declared count, or an external tool.
- **Do not use an NPM package that directly parses MPEG MP3 frame data.**
  Ordinary web frameworks, multipart helpers and other generic utilities are
  permitted. Independent decoders can be development-only verification tools.
- For a successful upload, return a JSON object with the **`frameCount`**
  property containing a JSON number, with the correct
  **`Content-Type: application/json`** response header.
- Submit a **Git repository**, with clear start/run instructions and an
  example request showing how to test the endpoint.

The original brief does **not** prescribe an upload field name, raw-byte
support, exact error status mapping, an upload size limit, specific libraries,
a JSON error schema, hosting/deployment infrastructure, or query parameters.
Those are design decisions in the present project.

## Scope of "MPEG-1 Layer III"

To count ordinary MPEG-1 Layer III streams accurately, interpret the **11-bit
sync**, MPEG **version bits 11**, **Layer III bits 01**, valid bitrate and sample
rate indices, **padding**, and frame length. The full in-scope header values
are in [MPEG-1 Layer III rules](mpeg-1-layer-iii.md).

- Indexed bitrates **32–320 kbps**, all three MPEG-1 sample rates
  **32/44.1/48 kHz**, all four channel modes, CRC-protected/unprotected
  headers and CBR/VBR/ABR sequences are legitimate in-scope cases.
- Free-format **bitrate index zero is a valid MPEG-1 Layer III subtype**.
  Supporting it strengthens literal format coverage, even though the
  assignment does not call out this rare case or promise that it is tested.
  The current parser supports inferable free-format streams but **cannot
  claim unconditional full coverage**: ambiguous one-/two-frame streams
  are rejected.
- Reserved bitrate index **15** and sample-rate index **3** are not valid
  MPEG-1 Layer III frame configurations. MPEG-2, MPEG-2.5, Layers I/II,
  AAC/ADTS and MP4 are explicitly **outside the assignment**.
- Layer III compressed-audio decoding, bit-reservoir validation, full
  Huffman decoding, and validating optional frame CRCs are **not needed**
  for the requested logical _frame count_. Structural validation is not
  proof that audio is fully decodable.

Handling **ID3v1 and common ID3v2 metadata** is relevant to finding the
beginning/end of MPEG audio in real MP3 files. Parsing ID3 internal records,
artwork or lyrics is not. Xing/Info/LAME/VBRI are encoder-specific metadata
conventions, not new MPEG versions or separate ID3 audio frames. The
[metadata reference](tags-and-encoder-headers.md) documents their optional
boundary and counting implications.

LAME free-format **321–640 kbps** interoperability, arbitrary embedded
ID3, APEv2/Lyrics3, enhanced error semantics and decoder-style recovery
are **optional compatibility extensions**, not independently mandated
assessment features. They must not take priority over a correct working
solution within the five-day target.

## Selected count policy and confirmed sample expectation

The assessment asks for "the number of frames" without specifying how to
treat an initial MPEG frame carrying only an encoder's Xing/Info metadata.
The supplied sample contains **6090 physical MPEG frames**, while **MediaInfo
(explicitly suggested in the assignment) and FFprobe report 6089**
decoder-facing audio frames. The brief alone does not establish either
counting convention as the evaluator's intended rule.

The owner explicitly chose the HTTP default on **2026-10-24**: omitted or
`?includeVbrHeaderFrame=false` excludes one recognized initial Xing/Info/VBRI
metadata frame, returning **6089** for the sample. Explicit `true` returns
**6090** physical frames. Raw and multipart requests use the same policy;
direct `countMp3Frames()` calls retain their physical default. This is a
breaking change to the previous HTTP contract, with real-file regressions
for both upload modes and optional identity-checked sample tests.

On **2026-10-26**, the evaluator confirmed audio-frame counting and **6089**
for the supplied sample, recommending MediaInfo as a sanity check. This
resolves the sample expectation and matches the existing HTTP default; it
does not establish how to handle later encoder-like payloads or concatenated
sequences. Structural metadata exclusion does not decode audio or guarantee
agreement with every media tool. See the
[count-contract clarification and evidence](../frame-count-contract.md).

## Evaluation criteria, not extra format requirements

The brief grades **correctness**, **code quality and TypeScript idioms**,
**error handling**, **large-file scalability/performance**, and **Git
workflow**. Appropriate examples are well-structured modules, predictable
4xx/5xx errors, bounded-memory streaming, formatting/lint/test tooling,
a readable history, and concise instructions.

The brief does _not_ require a formal security audit, 100% coverage,
mutation testing, fuzzing, an SBOM, release automation, 640 kbps support,
or production-grade auth/rate limiting. These may be useful choices already
in the project, but must not be presented to AI agents as acceptance gates
imposed by the evaluator.

Finally, the brief states **"Done is better than perfect"**, asks
candidates to complete the work within **five days**, and notes that
AI-assisted submissions must be understandable and explainable by the
candidate. Prefer demonstrably correct essentials to unrelated scope growth.

## Minimal acceptance demonstration

```bash
npm ci
npm run build
npm start

# In another terminal:
curl -i -X POST 'http://127.0.0.1:3000/file-upload' \
  -F 'file=@tests/fixtures/cbr.mp3;type=audio/mpeg'
```

The success response must include an `application/json` content type
and a `frameCount` number. For this bundled CBR fixture, the selected HTTP
default returns `{"frameCount":32}`; explicit `includeVbrHeaderFrame=true`
returns 33 physical frames. The particular multipart field name `file`
is the current implementation's choice, not wording from the assessment.
