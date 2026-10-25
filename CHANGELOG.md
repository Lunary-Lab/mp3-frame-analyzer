# Changelog

## [2.0.0](https://github.com/Lunary-Lab/mp3-frame-analyzer/compare/v1.2.0...v2.0.0) (2026-10-25)


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

## [1.2.0](https://github.com/Lunary-Lab/mp3-frame-analyzer/compare/v1.1.0...v1.2.0) (2026-10-24)


### Features

* support raw MP3 uploads and free-format frame counting


### Bug Fixes

* **api:** classify upload errors and bound rejected raw streams
* **parser:** infer free-format spans that lack padding variation

## [1.1.0](https://github.com/Lunary-Lab/mp3-frame-analyzer/releases/tag/v1.1.0) (2026-10-24)


### Features

* harden uploads and automate verified semantic releases
