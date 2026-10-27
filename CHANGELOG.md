# Changelog

## [2.2.0](https://github.com/Lunary-Lab/mp3-frame-analyzer/compare/v2.1.1...v2.2.0) (2026-10-27)


### Features

* **api:** bound concurrent upload admission ([#17](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/17)) ([5127f33](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/5127f3345d1eb9cecce3b66208df2bc9d1ab9518))
* **parser:** support short streams and boundary-aligned metadata ([#2](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/2)) ([441cb51](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/441cb51150783fbe2ffe489a6b2661b758fa9f7a))


### Fixes

* **api:** enforce bounded upload and shutdown lifecycles ([#16](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/16)) ([6fe6816](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/6fe68161126bfaea704d2e1a7b03c16747a4cba5))
* cancel disconnected uploads and verify lifecycle cleanup ([#37](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/37)) ([2c46390](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/2c463907e770ad30e4729e43e50b27d8abd01a5d))
* **ci:** enforce complete Semgrep wheel integrity ([#21](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/21)) ([221e107](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/221e107bc8a3db35f83fd3c520324e0777c632fc))
* **ci:** verify Go compiler and locked helper modules ([#27](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/27)) ([ddc60b8](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/ddc60b88c07f6474ff5cea39d077ffe41003318c))
* **ci:** verify npm bootstrap archive integrity ([#20](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/20)) ([c273af9](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/c273af93cf78973dbebc0ebfc03a1a5bfdb157d7))
* **ci:** verify runtime and package acquisition ([#33](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/33)) ([7718c30](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/7718c30e76c59b9e5b1b7d5a1b3b2501fa74ffcf))
* disable implicit local package acquisition ([#43](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/43)) ([5f1eefb](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/5f1eefbb621f463203d3ba4173827bfeeec3d9d1))
* **governance:** validate checks and sanitize complete snapshots ([#5](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/5)) ([1c76a46](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/1c76a4610f55cb93d01a558a926ba8dbef16000d))
* isolate native release archive environments ([#41](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/41)) ([670608c](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/670608cbaa5dc8349e5fb8a2993cf0f8c441a68e))
* **logging:** allowlist application log fields and messages ([#11](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/11)) ([0544818](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/05448183a97538fbd8559f2fc84e16273e798348))
* **mutation:** safely reuse unaffected killed mutants ([#18](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/18)) ([20e5610](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/20e56102f79e80a28b828589162b57e8ba98339d))
* **runtime:** harden API errors and cooperative parser traversal ([#25](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/25)) ([03c0277](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/03c02771b4041b43fde2e97e6cbcd376b966d516))
* **security:** replace vulnerable scanner with native architecture checks ([#39](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/39)) ([3f4dbde](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/3f4dbdea42ff716eb61b49a562bfd47e5fb19182))
* support bounded cooperative MP3 sequence inference ([#45](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/45)) ([9d2108c](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/9d2108cd6682936fb68e2a06f2ae60a94612baf4))
* validate release SBOM integrity and CLI dispatch ([#40](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/40)) ([d7d7ab6](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/d7d7ab6d7ff1c0adf4fa22331a05b96cc28281a6))
* verify independent LAME encoder source integrity ([#42](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/42)) ([fda5216](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/fda52162c8d89fac488d60437261bd93237092ed))
* verify native Terraform initialization boundaries ([#44](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/44)) ([320cbb6](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/320cbb6a366605807777c974bf747effae76aa09))


### Performance

* replace custom mutation caching with native Stryker reuse ([#35](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/35)) ([9d4bb13](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/9d4bb13d0470b532380ff8e46a1e803198501dd0))
* reuse same-PR mutation results and avoid redundant CI ([#36](https://github.com/Lunary-Lab/mp3-frame-analyzer/issues/36)) ([fcb59e2](https://github.com/Lunary-Lab/mp3-frame-analyzer/commit/fcb59e28545b43e521228d570efcff0526c40d5d))

## [2.1.1](https://github.com/Lunary-Lab/mp3-frame-analyzer/releases/tag/v2.1.1) (2026-10-25)


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
