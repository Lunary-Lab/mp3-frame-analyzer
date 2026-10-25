# Changelog

## [2.1.1](https://github.com/Lunary-Lab/mp3-frame-analyzer/compare/v2.1.0...v2.1.1) (2026-10-25)


### Miscellaneous Chores

* **governance:** enforce rulesets and release approval on the public repository ([#1](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/1)) ([812c7b2](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/812c7b2b22cb7f933bf423f650684e51146eb145))

## 2.1.0 (2026-10-25)


### Features

* **server:** make the maximum upload size configurable ([14a6415](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/14a6415b243563acd2829bb7403b1d469ee4355d))

## 2.0.2 (2026-10-25)


### Bug Fixes

* **ci:** audit required checks as they stood at merge ([5bda42c](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/5bda42c92025d280411064987314b0b65237aba7))
* **release:** include shared runtime dependencies in production SBOM ([08c625e](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/08c625e58754d1c50784810b6246f0aaa737be1c))

## 2.0.1 (2026-10-25)


### Bug Fixes

* **build:** remove obsolete outputs and clarify historical validation ([bb584c9](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/bb584c9109f1f66679e09bc9e989712c468a8807))
* **parser:** reject free-format frames missing mandatory prefix space ([3f6d5fe](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/3f6d5fe7945050f606838527b321443feb5c17a7))

## 2.0.0 (2026-10-25)


### ⚠ BREAKING CHANGES

* **api:** POST /file-upload now excludes a recognized initial Xing/Info/VBRI metadata frame when includeVbrHeaderFrame is omitted. Send includeVbrHeaderFrame=true to retain the previous physical-frame count.

### Features

* **api:** default to audio-frame counts and strengthen free-format validation


### Bug Fixes

* **api:** report a cut-off multipart form as 400 however it arrives
* **fuzz:** distinguish replay setup errors from parser failures
* **fuzz:** preserve impossible-count signatures during reduction
* **parser:** report invalid headers after free-format frames as themselves
* **release:** package correctly from renamed checkouts
* **upload:** accept audio multipart parts without filenames
* **upload:** apply one media-type rule to raw and multipart uploads
* **upload:** normalize multipart media-type whitespace


### Performance Improvements

* **test:** validate affected-mutant reuse with trusted main baselines

## 1.2.0 (2026-10-24)


### Features

* support raw MP3 uploads and free-format frame counting


### Bug Fixes

* **api:** classify upload errors and bound rejected raw streams
* **parser:** infer free-format spans that lack padding variation

## 1.1.0 (2026-10-24)


### Features

* harden uploads and automate verified semantic releases
