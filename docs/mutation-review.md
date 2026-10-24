# Mutation testing: equivalence review

## Current measured result

The October 24, 2026 review update was tested locally using **Node.js 24.22.1**, **Stryker 10.1.1**, and the **Vitest 5.0.5 command runner**. The run covered the updated MPEG header decoder, including its free-format classifier, and the ID3 decoder with its extracted signature helper.

| Module            |  Killed | Timed out | Survived | No coverage | Errors |      Score |
| ----------------- | ------: | --------: | -------: | ----------: | -----: | ---------: |
| `frame-header.ts` |      72 |         5 |        0 |           0 |      0 |    100.00% |
| `id3.ts`          |      92 |         1 |        3 |           0 |      0 |     96.88% |
| **Total**         | **164** |     **6** |    **3** |       **0** |  **0** | **98.27%** |

All **173 mutants** were evaluated. The reported raw mutation score is `(164 + 6) / 173 = 98.27%`: the six timeout detections are counted separately from the 164 assertion-detected kills. The run completed in approximately 2 minutes 34 seconds and passed the unchanged **95%** CI threshold.

Run `npm run mutation` to repeat the measurement. The machine-readable report is generated at `reports/mutation/mutation.json` and uploaded by the mutation CI job. The mutation scope remains exactly `src/mp3/frame-header.ts` and `src/mp3/id3.ts`; this result does **not** measure mutation coverage of traversal, stream handling, HTTP, shutdown, or release tooling. Those components have separate tests.

## Equivalent surviving mutations

The three survivors have identical observable results for the supported ordinary `Uint8Array` and `Buffer` inputs. No additional non-equivalent survivors were found in this run.

1. **`id3.ts:10`, mutant 85: replace `bytes.length >= 3` with `true` in `isId3v2Tag`.** A shorter byte array cannot contain all three `ID3` signature bytes. A missing typed-array index yields `undefined`, so the remaining conjunction still returns `false`.
2. **`id3.ts:37`, mutant 153: remove the `version === 4` footer condition.** The footer flag `0x10` is reserved in ID3v2.2 and ID3v2.3 and is already rejected by version-specific flag validation. Only ID3v2.4 can reach this line with that flag set.
3. **`id3.ts:42`, mutant 168: replace `bytes.length >= 3` with `true` in `isId3v1Tag`.** A shorter array cannot match the complete `TAG` prefix, so the remaining conjunction still returns `false`.

The explicit length and version checks remain because they communicate format preconditions and protect against future changes to surrounding validation. No production checks were deleted, no mutation exclusions were added, and the score threshold was not lowered to improve the reported result.

## Timed-out mutations

| Module/location      | Mutants        | Change and interpretation                                                                                                                                                                   |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame-header.ts:28` | 15, 16, 17, 18 | Alter or remove zero-bitrate validation. These changes can admit a zero-length frame into traversal; the additional free-format regression cases expose the non-advancing mutated behavior. |
| `frame-header.ts:33` | 27             | Replace frame-length multiplication with division, which can also produce a zero-length frame and prevent traversal from advancing.                                                         |
| `id3.ts:31`          | 140            | Change `i++` to `i--`, preventing termination of the synchsafe-byte validation loop.                                                                                                        |

These six outcomes are recorded as **Timeout** in the report, not as ordinary assertion failures. The explanations above follow inspection of the corresponding mutations; timings and the distinction between an assertion kill and a timeout can vary with the runner. The test process watchdog bounds these deliberately broken variants.

## Historical comparison

The [earlier GitHub Actions run](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40102747242) measured **97.90%** on the previous source: 138 kills, 2 timeouts, and 3 equivalent survivors. Earlier targeted test improvements had raised that snapshot from 76.92% without deleting defensive checks or suppressing mutations.

The current run evaluates a different set of 173 mutants because the reviewed decoder code changed. Its 98.27% result supersedes the older numbers for this revision; the higher percentage alone is not evidence that every aspect of application correctness improved. Separately measured branch coverage likewise does not prove complete semantic correctness.
