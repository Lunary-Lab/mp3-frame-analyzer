# Mutation testing: equivalence review

The [GitHub Actions run on October 24, 2026](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40102747242) used Stryker 10.1.1 and the Vitest command runner.

| Module            |  Killed | Timed out | Survived |      Score |
| ----------------- | ------: | --------: | -------: | ---------: |
| `frame-header.ts` |      51 |         1 |        0 |    100.00% |
| `id3.ts`          |      87 |         1 |        3 |     96.70% |
| **Total**         | **138** |     **2** |    **3** | **97.90%** |

The initial score was **76.92%**. Targeted tests reduced 33 survivors to 3 without production-code deletions or Stryker suppressions. CI now fails below **95%** mutation score for these two decoder files. This is **not** a claim about mutation coverage across the entire application.

## Equivalent surviving mutations

The three surviving changes have identical observable behavior for the supported `Uint8Array` input contract.

1. **`id3.ts:11`: remove `bytes.length < 3`.** Short byte arrays cannot contain all three `ID3` signature bytes. The following signature check therefore still returns `null` because a missing typed-array index yields `undefined`.
2. **`id3.ts:34`: remove the `version === 4` footer condition.** The footer flag `0x10` is reserved in ID3v2.2 and ID3v2.3 and is already rejected by version-specific flag validation. Only ID3v2.4 can reach this line with `0x10` set.
3. **`id3.ts:39`: remove `bytes.length >= 3` in ID3v1 detection.** A shorter byte array cannot match all three bytes of the `TAG` prefix, so the remaining conjunction already returns `false`.

The explicit length and version checks are retained because they make format preconditions clear and protect against accidental changes to surrounding validation.

## Timed-out mutations

- **`frame-header.ts:33`** changes the frame-length multiplication into division, breaking traversal. Stryker observed a timeout rather than an assertion failure.
- **`id3.ts:28`** changes `i++` to `i--`, preventing termination of the tag-length validation loop. Stryker observed a timeout.

These two are reported separately from the 138 assertion-detected mutants. Their timeout classifications are preserved instead of claiming they were killed normally.

The defensible metric is **97.90% raw mutation score**, with 3 documented equivalent survivors. Removing good defensive checks merely to manufacture a 100% score would obscure more than it demonstrates. The separately measured **100% parser branch coverage** also does not prove full semantic correctness.
