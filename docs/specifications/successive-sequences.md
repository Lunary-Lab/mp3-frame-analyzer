# Successive configurations: bounded inference policy

The parser supports successive **MPEG-1 Layer III configurations inside one
uploaded file** under this bounded inference policy. Multiple multipart files
remain rejected.

## Authority and scope

ISO/IEC 11172-3:1993 §2.1.10 holds sampling frequency constant within an audio
sequence; §§2.4.1.1 and 2.4.2.3 describe sync-led frames and contemplate a
sampling-rate change requiring decoder reset. Free format retains a fixed
unpadded span, with each frame's padding applied, within its configuration.

Those clauses do not establish a universal standalone-file concatenation grammar
or a unique inference algorithm. [RFC 3003 §1](https://www.rfc-editor.org/rfc/rfc3003.html#section-1)
describes an elementary stream of MPEG frames; the
[W3C MPEG Audio Byte Stream Format §§3–5](https://www.w3.org/TR/2024/NOTE-mse-byte-stream-format-mpeg-audio-20240723/#mpeg-audio-frames)
provides a frame-combination profile specifically for Media Source Extensions.
They corroborate a compatibility choice, not a mandate to implement the whole MSE
profile, additional codecs, Icecast or resynchronization.

At a resolved boundary, a valid changed sample rate resets the cached bitrate
mode/free span. Indexed lengths are computed independently; a new free
configuration requires bounded acquisition. Invalid and identified unsupported
headers retain their own errors before any reset.

Same-rate indexed/free switching retains its existing rejection policy. This is
not a claim that ISO expressly forbids every such edited stream. The fixed-rate
condition applied to mixed same-rate runs remains a separate compatibility
decision. Metadata alone is not treated as an ISO reset marker.

## Admissibility, ranking and errors

1. Search remains one 8,647-byte probe plus one unsearched EOF-witness byte.
   Candidate unpadded spans remain 20–2,880 bytes.
2. Within a free configuration, compatible-header count ranks first, then
   validated metadata evidence. This existing strongest-chain preference remains
   a **heuristic**, not proof of universal mathematical uniqueness.
3. A supported changed-rate suffix can anchor a short leading free candidate.
   Successor headers do not increase the preceding span's score. Existing
   conservative short-candidate checks for swallowed same-rate free headers and
   plausible metadata remain.
4. When EOF is already known, new suffix evidence must close consistently.
   Otherwise bounded header-chain or validated metadata evidence is permitted;
   normal traversal still validates selected boundaries and streamed tag bodies.
5. A supported changed-rate candidate on a conflicting first span cannot be
   outvoted by a coarser same-rate chain hiding that configuration. It, or an
   equal best same-configuration score, returns unsupported-format / HTTP 415:
   **“Ambiguous free-format MPEG frame layout”**. No numeric count is guessed.
6. No qualifying candidate retains the separate **“Cannot infer a unique
   free-format MPEG frame size from consecutive headers”** error. These inference
   failures do not declare every such byte string ISO-invalid.
7. Once established, a span is skipped without scanning payload. No new sequence
   causes another encoder-header subtraction: HTTP omitted/false excludes at most
   the upload's initial recognized Xing/Info/VBRI frame; true and the direct parser
   default count physical frames.

## Necessary side-information bounds, not decoding

New sequence evidence reads the nine-bit main_data_begin, the two/four
twelve-bit part2_3_length fields, and their nine-bit big_values pair counts. ISO/IEC 11172-3:1993 §§2.4.1.7, 2.4.2.7 and
2.4.3.4.3 imply this necessary bound:

    sum(part2_3_length) <=
      8 * (main_data_begin + physicalFrameLength - mandatoryPrefix)
    mandatoryPrefix = 4 + optionalCRCBytes + (mono ? 17 : 32)

The 59-bit granule/channel records have equal length in both window-switch
branches. First records begin at side-information bit 18 for mono and 20
otherwise. Round only the aggregate bit sum; granules are not individually
byte-aligned. Granting the full backward offset does **not** assume a reservoir
reset at a rate change.

Each big_values count must be at most 288: its spectral pairs occupy part of
576 values per granule (§2.4.2.7). The field follows each part2_3_length directly.
This rules out impossible header-like ancillary patterns without decoding them.

The same necessary-evidence filter rejects three further contradictions
(§§2.4.2.7, 2.4.3.4.5/.6 and table B.7):

- A transmitted `block_type=0` when `window_switching_flag=1` is reserved. Normal
  unswitched blocks retain their implicit type zero.
- With `big_values>0`, the first pair necessarily uses region zero; its table
  selection cannot be undefined table 4 or 14. Unused selections are not rejected.
  Later region selections are not validated by this deliberately narrow check.
- The declared `part2_3_length` must cover the mandatory transmitted scalefactor
  bits. MPEG-1's compression mapping supplies the two widths. Long blocks have
  groups of 6, 5, 5 and 5 values; second-granule `scfsi` can omit those groups
  independently per channel. Short blocks require 18 values of each width;
  mixed blocks require 17 of the first and 18 of the second. Signalled long-block
  reuse is granted conservatively without proving prior values are available.

Original ancillary-decoy regressions place changed-rate headers inside a valid
864-byte zero-main-data singleton. Each of the three contradictions above must
leave that singleton countable, while the all-zero alternate remains ambiguous;
all controls run at 1-, 7- and 4,096-byte chunk sizes. An impossible alternative
is not evidence of intrinsic ambiguity. The filter remains necessary rather
than sufficient, so other payload coincidences can still cause conservative
rejection.

These checks do not establish actual reservoir availability, validate all
remaining side-information semantics, check CRC, decode Huffman data or prove
decodability. Ordinary same-rate paths retain their historical structural
policy: this is a filter for new sequence evidence, not a full-conformance gate.
`side-information.test.ts` checks field offsets, all compression codes, exact
budget boundaries and channel-specific reuse; `sequence-side-information.test.ts`
checks the public parser seam.

## Explicit non-unique constructions

Original zero-main-data fixtures demonstrate why construction counts alone are
not authoritative:

- **864 bytes:** a 216-byte free frame at 48 kHz plus two 324-byte frames at 32 kHz
  also admits one 864-byte 48 kHz / 288 kbps free frame. Later headers may be
  ancillary patterns. Counts are three or one.
- **3,780 bytes:** seven 324-byte 32 kHz frames plus seven 216-byte 48 kHz frames
  also admit three 972-byte 32 kHz / 216 kbps frames followed by four 216-byte
  48 kHz frames. Counts are fourteen or seven.

Both report ambiguity. A header whose indexed span cannot fit, a free header
missing its mandatory prefix, or a candidate contradicted by declared main-data
capacity is not automatically a supported alternate layout.

## Resource bounds

Cached header, metadata and prefix-count observations belong to one fixed probe.
A reverse offset dynamic program stores successor existence, not every path.
There is no recursive backtracking or upload-sized candidate graph.

Suffix discovery stops at its first admissible layout because callers need only
existence, not its ranked count. Impossible prefix capacity or spectral-pair
fields reject a suffix before candidate walks. Root candidates retain their
specified ranking and ambiguity policy.

Inference is resumable. Candidate visits, followed frames and conservative
metadata iterations trigger an actual event-loop turn after a **2,048-unit
scheduling quantum**, at the next candidate/suffix checkpoint. Completing one
advancing candidate walk adds at most a conservative two-probe-length amount of
work before the checkpoint. Indexing and prefix-field reads are separately
fixed-window bounded. There is no arbitrary total-work format rejection:
ancillary density alone must not turn an accepted stream into unsupported MPEG.

The direct parser accepts optional AbortSignal cancellation. It checks before
reading, at frame boundaries, and before/after cooperative inference turns;
the caller's reason propagates unchanged and the upstream iterator is cleaned
up. This does not race or forcibly interrupt an arbitrary pending user-supplied
iterator.next() promise. Request disconnect/deadline wiring belongs to the HTTP
lifecycle, not MPEG error classification. Normal inference outcomes are identical
to a synchronous drain of the same state machine and independent of chunking.

Each successful acquisition is followed by consuming at least 21 physical frame
bytes. Work is therefore linear in upload length with fixed constants; memory
depends on the fixed probe observations and existing upstream-chunk ownership, not
the whole upload. This is an algorithmic bound, not a latency SLA.

## Verification

The successive-sequence suite covers all rates and bitrate modes, one/two/three
leading frames, repeated transitions, metadata, false headers, ambiguous layouts,
error precedence and raw/multipart count defaults. Capacity tests cover exact
bounds, one-bit overflow, aggregate rounding, CRC, channel modes, both switch
branches and backward offsets. Work tests cover dense graphs, exact scheduling accounting,
bounded lookahead, chunk independence, scheduling fairness, cancellation and
iterator cleanup. A 2,700-byte three-frame control with dense ancillary patterns
remains counted: proposed alternatives either lack their claimed history or
contain impossible spectral-pair counts. No reservoir reset is assumed. All 48 normally
flushed short encoder fixtures remain mandatory controls.

Sequence-aware property and coverage-guided fuzz targets generate changed-rate
indexed/free combinations, padding/CRC/channel modes, ancillary patterns,
metadata and bounded lengths. Exact anchored-count domains and the two explicit
ambiguity witnesses are separate from arbitrary layouts, whose oracle checks
chunk invariance and sane counts without inventing intended boundaries.
