# Assessment brief

This is the original technical assessment as supplied by the evaluator, kept
here as the source of truth for the API contract. The wording is unchanged;
only the formatting was converted to Markdown (including the brief's repeated
response-format sentence). The interpretation of "number of frames" is
discussed in [the frame-count contract](frame-count-contract.md).

**Repository interpretation, approved by the owner (2026-10-24):** the HTTP
endpoint excludes one recognized initial Xing/Info/VBRI metadata frame by
default. The supplied sample therefore returns `{"frameCount":6089}`;
`?includeVbrHeaderFrame=true` requests its 6090 physical frames. This decision
applies to raw and multipart uploads and is a breaking change to the previous
HTTP default. This was the repository owner's decision at that time; the later
evaluator clarification is recorded separately below.

## Clarification received 2026-10-26

The evaluator confirmed that the requested result counts **audio frames only**,
with **6089** expected for the supplied sample, and recommended **MediaInfo**
as a sanity check as suggested in the original brief. The existing HTTP default
already matches that result; explicit physical counting remains a separate
diagnostic mode returning 6090 for this sample.

This clarification does not specify later encoder-like payload or concatenation
policies. It is not a full decoder-conformance requirement or a statement that
every media tool must agree on every input. The [count contract](frame-count-contract.md)
keeps those implementation boundaries and verification evidence distinct.
The original assignment text below remains unchanged.

---

## Assignment

### Technical Assessment: MP3 File Analysis App

### Objective

The aim of this task is to create an API endpoint according to the
specification below that accepts an MP3 file and responds with the number of
frames in the file. A sample file is provided for candidates to test their
solution against.

This assessment will test the candidate's ability to:

- Learn & apply new knowledge in a likely unfamiliar context
- Demonstrate technical competency in Typescript
- Show personal coding styles & preferences

### API Specification

The application must host an endpoint at `/file-upload` that accepts an MP3
file upload via the POST method.

The endpoint must successfully count the number of frames for MPEG Version 1
Audio Layer 3 files (This is almost universally the format for .mp3 files,
including the provided sample).

The endpoint must provide a JSON response (with the correct response headers)
in the following format:

> ⚠️ Handling of other MPEG file formats should be considered out of scope for
> this exercise & candidates are encouraged not to spend time on this.

The endpoint must provide a JSON response (with the correct response headers)
in the following format:

```json
{
  "frameCount": <number>
}
```

Note: `<number>` should be the correct number of frames in the MP3 file

### Requirements

The candidate:

- Must use TypeScript to complete the exercise.
- Must parse the MP3 file to logically count the number of frames in the file.
- Must not use an NPM package to parse the MP3 frame data directly. NPM
  packages may be used for other things such as generic utilities or a http
  framework.
- Must respond to the client with the correct number of frames found in the
  file, in the format specified above.

### Evaluation Criteria

The candidate's solution will be evaluated based on the following criteria:

#### Correctness

- Does the solution meet the requirements?
- Does the solution correctly determine the number of frames in the MP3 file
  correctly?
- Does the solution handle errors appropriately?

#### Code Quality

- Is the code well-organised, readable, and maintainable?
- Does the code follow TypeScript good practices?
- Does the code utilise TypeScript's features effectively?
- Does the solution include standardised tooling for formatting, linting,
  testing etc?

#### Error Handling

- Is error handling implemented appropriately?
- Does the solution handle errors gracefully?
- Does the solution provide useful error messages to the user?

#### Scalability

- Is the solution scalable and able to handle large files?
- Is the solution optimised for performance?

#### Approach

- Has the candidate used Git effectively?
- Is there evidence of a structured approach to the solution?

### Tips

The candidate may wish to use a tool such as mediainfo to verify their results.

Candidates are reminded to test final solutions before submission.

Priority should be given to producing a working solution in the allotted time -
Done is better than perfect. Brief comments may be left to explain
optimisations / improvements that would be implemented with more time & there
will be an opportunity to expand on this at interview.

Candidates may use AI assistance to complete the exercise but the submission
will still be taken as the candidates own work and therefore it should be
representative of something they would write themselves and they will be
expected to understand and explain the solution.

### Submission

The candidate should provide the solution as a git repository & should include
clear instructions for running the application & an example of how to test the
application.

### Timeframe

The candidate should aim to complete the assessment within 5 days of receiving
the task.

Good luck! We look forward to seeing your solution.

---

## Appendix: project interpretation (not assignment text)

This appendix separates the assignment's requirements from the repository's
implementation choices. The original assignment and dated clarification above
control assessment scope; the specification guides add reference detail, not
new evaluator requirements.

### Mandatory deliverables

- Use **TypeScript** and expose **`POST /file-upload`** accepting an MP3 upload.
- Logically parse **MPEG-1 Audio Layer III** frames to determine the count; do
  not estimate it from file size, bitrate, duration or encoder-declared totals.
- Do not use an NPM package that directly parses MP3 frame data. Generic web
  frameworks and multipart utilities are allowed; independent decoders may be
  development-only verification tools.
- Return a JSON object containing a numeric **`frameCount`**, with the correct
  **`Content-Type: application/json`** response header.
- Submit a **Git repository** with clear run instructions and an example test
  request. The [HTTP guide](specifications/http-api.md#reproducible-requests)
  supplies requests for the current implementation.

### Format coverage and limits

[MPEG-1 Layer III rules](specifications/mpeg-1-layer-iii.md) cover header sync,
version/layer identifiers, bitrate and sample-rate indices, padding and frame
length. Legitimate in-scope streams include indexed **32-320 kbps** bitrates,
**32/44.1/48 kHz**, all four channel modes, CRC-protected/unprotected frames and
CBR/VBR/ABR. **Free-format index 0 is also a valid subtype**, although the brief
does not call it out or promise a test; the parser supports inferable streams
and rejects ambiguous short layouts, so it cannot claim unconditional coverage.
Forbidden bitrate index 15 and reserved sample-rate index 3 are invalid.
MPEG-2/2.5, Layers I/II, AAC/ADTS and MP4 are outside the assignment.

ID3v1 and common ID3v2 envelopes matter to locating audio boundaries; internal
records, artwork and lyrics need not be interpreted. Xing/Info/LAME/VBRI are
encoder metadata conventions, not separate ID3 audio frames. See the
[metadata guide](specifications/tags-and-encoder-headers.md). Logical counting
does not require Layer III decoding, bit-reservoir or Huffman validation, or CRC
verification, and does not prove decodable audio. The public
[ISO catalog](https://www.iso.org/standard/22412.html) and these summaries do not
constitute a certified ISO conformance audit.

### Project choices and count policy

The **2026-10-26 evaluator clarification** confirms audio-frame counting and
**6089** for the supplied sample, matching the owner's **2026-10-24** HTTP
default: omitted/`false` excludes at most one recognized initial Xing/Info/VBRI frame.
Explicit `includeVbrHeaderFrame=true` returns its **6090 physical frames**;
direct `countMp3Frames()` calls retain their physical default. Raw and multipart
uploads share the HTTP policy. Later encoder-like payload and concatenation
remain project decisions; structural exclusion does not guarantee agreement
with every media tool. The [count contract](frame-count-contract.md) records
the policy, its change from the earlier HTTP default and verification evidence.

The brief does not prescribe a multipart field name, raw uploads, MIME aliases,
query options, exact error statuses/schema, upload caps, libraries or deployment
infrastructure. LAME extensions beyond the [documented 320 kbps candidate envelope](specifications/mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero)
are outside the supported scope and must not compete with supported layouts.
The inclusive endpoint follows the detailed maximum-rate rule and fixed-rate
arithmetic; the definition's wording distinction remains documented.
Arbitrary embedded ID3, APEv2/Lyrics3 and decoder-style recovery
are optional compatibility choices.
Fuzzing, mutation testing, 100% coverage, SBOMs, release automation, formal security
audits and production auth/rate limiting are likewise not evaluator mandates.

Correctness, readable TypeScript, useful errors, large-file performance, tooling
and effective Git use remain evaluation criteria. The five-day target and
requirement that the candidate understand and explain AI-assisted work favor a
working, demonstrably correct solution over unrelated scope growth.
