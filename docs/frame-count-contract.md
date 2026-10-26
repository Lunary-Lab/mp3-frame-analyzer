# Frame-count contract

**Status: the evaluator confirmed audio-frame counting and sample result 6089
on 2026-10-26.** This matches the HTTP default selected by the repository owner
on 2026-10-24: exclude one recognized initial Xing/Info/VBRI metadata frame.
Clients can separately request all physical MPEG-1 Layer III frames with
`?includeVbrHeaderFrame=true`. The clarification changes no implementation or
diagnostic default; the earlier HTTP-default change remains a historical
breaking change.

## Selected contract

| Entry point and option                              | Count policy                                          |
| --------------------------------------------------- | ----------------------------------------------------- |
| Raw or multipart HTTP upload, option omitted        | Exclude one recognized initial metadata frame         |
| HTTP `includeVbrHeaderFrame=false`                  | Exclude one recognized initial metadata frame         |
| HTTP `includeVbrHeaderFrame=true`                   | Include every complete physical MPEG frame            |
| Direct `countMp3Frames()` call, option omitted      | Include every complete physical MPEG frame; unchanged |
| Direct call with `{ includeVbrHeaderFrame: false }` | Exclude one recognized initial metadata frame         |

The parser still traverses and validates each required frame boundary. Under
the exclusion policy, it removes at most one frame from the resulting count,
only when the first MPEG frame after any leading ID3 tags has a recognized
Xing/Info or VBRI structure at the expected position. LAME is an extension of
Xing/Info, not an independent frame signature. Later payload signatures do not
trigger exclusion, and files without a recognized initial metadata frame keep
their full count. The declared count inside encoder metadata is never used as
the answer.

This is a structural metadata-exclusion policy. It does not decode audio or
guarantee that every counted frame produces audio samples, and it need not
agree with every decoder or metadata tool.

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

| File                         | HTTP default / `false` | Physical frames / HTTP `true` | Xing/Info declared | FFprobe 6.0 `nb_read_frames` | MediaInfo 26.05 `FrameCount` |
| ---------------------------- | ---------------------: | ----------------------------: | -----------------: | ---------------------------: | ---------------------------: |
| Assessment sample (VBR)      |               **6089** |                      **6090** |               6089 |                         6089 |                     **6089** |
| `tests/fixtures/vbr.mp3`     |                     32 |                            33 |                 32 |                           32 |                           32 |
| `tests/fixtures/cbr.mp3`     |                     32 |                            33 |        32 (`Info`) |                           32 |                           33 |
| `tests/fixtures/no-xing.mp3` |                     51 |                            51 |               none |                           51 |                           51 |

MediaInfo labels the sample's first frame `Tag (Xing)` rather than audio. Its
reported duration, 159.060 s, equals 6089 × 1152 samples ÷ 44 100 Hz. For VBR
files MediaInfo reports the Xing-declared count; for the CBR fixture it reports
33, a size-derived count that includes the `Info` frame. No single convention
reproduces MediaInfo on every file. Excluding only a recognized leading
Xing/Info/VBRI frame matches FFprobe on these fixtures and MediaInfo on the
supplied sample.

## Assessment clarification (2026-10-26)

The evaluator confirmed **audio frames only**, with **6089** expected for the
supplied sample, and recommended **MediaInfo** as a sanity check in line with
the original brief. This resolves the previously open counting-convention
question and confirms the existing HTTP default for the sample. Explicit
physical counting still returns **6090**; no diagnostic tests or parser defaults
were changed to make the two modes appear identical.

The clarification does not specify how to treat incidental later encoder-like
payloads or concatenated sequences. Those details remain documented
implementation policies, not additional claims about the evaluator's intent.
Structural metadata exclusion is not audio decoding or a guarantee that every
media tool agrees on every file.

### Current-main verification (2026-10-26)

The actual packaged server from main `4652b334f2e81c1a566a5fdfca61910cababf626`
was checked with the identity-verified external sample. All 12 combinations of
raw/multipart, known-length/chunked, and omitted/false/true options passed:
omitted and false returned 6089; true returned 6090. Production logging and
clean shutdown were also checked. The private sample remains external to Git.
This evidence confirms that main's sample behavior matches the clarification;
it is not a claim of exhaustive decoder equivalence.

## Compatibility and verification

Existing HTTP clients that need the previous default must add
`?includeVbrHeaderFrame=true`. The response shape, upload types, and low-level
parser default are unchanged. Both HTTP upload modes pass an explicit policy
to that parser.

Real-file HTTP regressions cover omitted, `false`, and `true` options for CBR
and VBR files with initial metadata and for a file without Xing. The optional
`ASSESSMENT_SAMPLE_PATH` checks the supplied file's identity, default result
6089, and explicit physical count 6090. Parser construction and fuzz oracles
continue to distinguish their independently known physical and excluded counts.

The earlier HTTP-default change was a breaking HTTP change. This
clarification changes documentation only; Release Please remains responsible
for version and changelog updates. Published v1.1.0 measurements retain their
historical physical-frame contract.
