# GuardDog finding investigation — 2026-10-26

Status: draft review, not a clean malicious-dependency verdict. Owner: Lunary-Lab repository security maintainer. Analyst review date 2026-10-26; exact finding reviews expire 2026-11-25 and require fresh independent approval. Missing capabilities and genuine provenance regression are not false positives.

Evidence run: [40259270959 / native job121367877914](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40259270959/job/121367877914), source f2a17b9db7396227026b21ec8abf1f9ecbb4962f. It completed510/511 archives, with119 findings; @types/node remained a wrapper failure, explicitly not clean. Subsequent runs must prove complete coverage. Lock SHA256 ac057932c86b0cdee40c2df0823054c0784311438431dbdd59c04f48cec168e6.

Every reviewed source file below was read from an ignore-scripts npm installation and its SHA256 checked against the native hosted archive scan. No package test, hook or installer was executed for this investigation. Each config match includes exact name/version/SRI/all lock paths, rule/capability, path/line and evidence hash. Metadata evidence is a deterministic hash of exact differing field values (or exact binary path/kind/hash inventory); raw maintainer information and source snippets are not published. Registry payload hashes are recorded in the hosted diagnostic, but unrelated metadata churn does not silently broaden an exception.

The review engine rejects expired, malformed, duplicate, broadened, unused or evidence-changed exceptions. A review does not assert that an entire dependency is safe. Expected-behavior entries acknowledge real capabilities; they are not labelled false positives.

## Reviewed exact findings

<a id="source-babel-parser"></a>

### @babel/parser@8.0.8: false-positive

The matched long string is the JavaScript parser Unicode identifier-character table/regular expression, not an encoded executable payload. The exact lib/index.js file and matching line were inspected; the character classes are used for identifier parsing.

| Rule                         | Exact archive location      | Context SHA256                                                     |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `threat-runtime-obfuscation` | `package/lib/index.js:1356` | `687860d40a126108176fcf0ff32f56c164c81fb045fffb7e2b246117fd6fa3a9` |

<a id="source-fastify-busboy"></a>

### @fastify/busboy@3.2.4: false-positive

The long repeated-character string is multipart body test fixture data in test/types-multipart.test.js. The matched test builds a Buffer and validates parsing; it does not decode or execute an obfuscated payload.

| Rule                         | Exact archive location                    | Context SHA256                                                     |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `threat-runtime-obfuscation` | `package/test/types-multipart.test.js:26` | `5a31c50f42de183e8e24cd0bd3e24343dbac14c5b2a06d1ecbe4f2d26fc242b4` |

<a id="source-cmake-js"></a>

### cmake-js@8.0.0: expected-behavior

The two matches are its documented native-build distribution downloader: lib/dist.js writes runtime import libraries and lib/downloader.js fetches text. The surrounding runtimePaths.js selects Node/Electron/NW headers and libraries, with optional user mirrors; these specific sites are not download-and-execute commands. This is expected build-tool capability, not a claim that arbitrary mirror execution is safe.

| Rule                           | Exact archive location         | Context SHA256                                                     |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------ |
| `threat-process-download-exec` | `package/lib/dist.js:164`      | `d908ede8be1ea3ee47c4c0e2a1097ba6605efa76176ccf62cfe5e78030d67d08` |
| `threat-process-download-exec` | `package/lib/downloader.js:72` | `6b566bbe14501453e0e2c0693455fb4f77bf2cb85a771bbe4935141c8bdd8e39` |

<a id="metadata-deep-extend"></a>

### deep-extend@0.6.0: false-positive

The sole native manifest difference is scripts.test: registry mocha versus archive ./node_modules/.bin/mocha. npm adds dependency executables to script PATH, making this standard local executable normalization. Neither form is a lifecycle hook; no dependency or runtime entry-point differs.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `f04c5af64bc3bd8428aadda4aecbba608ac04185d581d25e82e0c707e7db5e2e` |

Exact differing fields: `scripts.test`.

<a id="metadata-dunder-proto"></a>

### dunder-proto@1.0.1: false-positive

Both the registry manifest and SRI-bound archive have main:false, with matching boolean type. Native metadata_mismatch assumes main must be a string and reports a difference even when both boolean values agree. The evidence records identical native type hashes; manual comparison confirmed equal values and no listed dependency/script difference.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `3ae4b433b350603a714e639084b843e391618deaaf5c225f70c9b2034dc2739c` |

Exact differing fields: `main.Expected type <class 'str'>`.

<a id="source-esbuild"></a>

### esbuild@0.28.2: expected-behavior

The package.json postinstall invokes the shipped install.js native binary selector/installer. A lifecycle hook really exists, so this is expected-behavior review rather than denial of the capability. Repository installs use --ignore-scripts, and GuardDog never installs or invokes the package.

| Rule                   | Exact archive location    | Context SHA256                                                     |
| ---------------------- | ------------------------- | ------------------------------------------------------------------ |
| `threat-process-hooks` | `package/package.json:10` | `9d0bc453f4e791553c4cc2298ba023b409241fd9801e494741666eb0f6051490` |

<a id="source-fast-uri"></a>

### fast-uri@4.2.3: false-positive

The matched ../../../etc/passwd literals are URN preservation/normalization test inputs and expected output strings. They are passed to URI parsing/assertions, not filesystem reads. The nested locked package path and exact source hash were checked, rather than confusing it with another fast-uri version.

| Rule                     | Exact archive location                   | Context SHA256                                                     |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| `threat-filesystem-read` | `package/test/urn-full-input.test.js:33` | `dbc0f83921364a51c4f572f0d7a8cd758de6610837ea06bc49a7cbde8db867d7` |
| `threat-filesystem-read` | `package/test/urn-full-input.test.js:37` | `dbc0f83921364a51c4f572f0d7a8cd758de6610837ea06bc49a7cbde8db867d7` |

<a id="source-fastify"></a>

### fastify@5.12.7: expected-behavior

The maintenance-only scripts/validate-ecosystem-links.js reads an optional GITHUB_TOKEN for HEAD requests to fixed https://api.github.com/repos/<validated-owner>/<validated-repo>. The other two matches delete that variable in its MockAgent tests. This is documented tooling authentication, not application-runtime credential exfiltration; repository CI does not invoke this dependency maintenance script.

| Rule                              | Exact archive location                                      | Context SHA256                                                     |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `threat-runtime-environment-read` | `package/scripts/validate-ecosystem-links.js:24`            | `b1d8089b962e5341a1e92cb25c135006ec08bbf4b1cb8781e74ff7abd3e9fbe3` |
| `threat-runtime-environment-read` | `package/test/scripts/validate-ecosystem-links.test.js:133` | `70c17ff78e003d6bda2639aa921f3e2c038c4587ff1ac8764949b0fa40803b27` |
| `threat-runtime-environment-read` | `package/test/scripts/validate-ecosystem-links.test.js:145` | `70c17ff78e003d6bda2639aa921f3e2c038c4587ff1ac8764949b0fa40803b27` |

<a id="source-find-my-way"></a>

### find-my-way@9.10.0: false-positive

The IP-address URLs are literal router.find inputs compared with relative-path route lookups in test/full-url.test.js. These matching statements perform in-memory URL/routing assertions, not requests to that IP address; unrelated HTTP server tests in the file do not create the alleged exfiltration flow.

| Rule                          | Exact archive location             | Context SHA256                                                     |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `threat-network-exfiltration` | `package/test/full-url.test.js:30` | `75759b6222fd9f47a20a6bc52e5dee28f376971517074edb485c5f3a74430d8c` |
| `threat-network-exfiltration` | `package/test/full-url.test.js:35` | `75759b6222fd9f47a20a6bc52e5dee28f376971517074edb485c5f3a74430d8c` |

<a id="metadata-fsevents"></a>

### fsevents@2.3.3: expected-behavior

The only difference is registry scripts.install="node-gyp rebuild" versus no archive install key. The official v2.3.3 package manifest has no install/preinstall and its source root contains binding.gyp; npm documents this exact implicit install default. The archive ships the prebuilt Darwin module. This is a bounded packaging-normalization inference, not proof that arbitrary injected scripts are safe; lifecycle scripts remain disabled.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `79d8ce3c2f7e4f9bd9ed726b18a4eb2ab0dc6a54a491ae145f90c8c2dfcb61ed` |

Exact differing fields: `scripts.install`.

<a id="source-lefthook"></a>

### lefthook@2.2.2: expected-behavior

The package.json hook calls the shipped postinstall.js, which skips ordinary CI and otherwise runs the selected lefthook binary with literal install to configure Git hooks. Lifecycle execution is disabled here. This review is ONLY the exact source hook finding: the separate real provenance_regression remains unreviewed and blocking.

| Rule                   | Exact archive location    | Context SHA256                                                     |
| ---------------------- | ------------------------- | ------------------------------------------------------------------ |
| `threat-process-hooks` | `package/package.json:44` | `ec18e6107a588b913d91144c35ccabd43c4b736d39b9a0a2c0a85cb1409e88ee` |

<a id="metadata-math-intrinsics"></a>

### math-intrinsics@1.1.0: false-positive

Both the registry manifest and SRI-bound archive have main:false, with matching boolean type. Native metadata_mismatch assumes main must be a string and reports a difference even when both boolean values agree. The evidence records identical native type hashes; manual comparison confirmed equal values and no listed dependency/script difference.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `3ae4b433b350603a714e639084b843e391618deaaf5c225f70c9b2034dc2739c` |

Exact differing fields: `main.Expected type <class 'str'>`.

<a id="source-pino"></a>

### pino@10.4.0: false-positive

All matched files are packaged tests: HTTP logger assertions use os.hostname as expected log data and make requests to their localhost test server; transport tests inspect NODE_OPTIONS/worker.env and use hostname/temp paths as fixtures. Inspection found no external system-information sink at these matched sites. This does not suppress any runtime source path or future test-file change.

| Rule                           | Exact archive location                              | Context SHA256                                                     |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| `threat-filesystem-read`       | `package/test/transport/node-options.test.js:95`    | `5f22453a509dcaeeb8c56bba5fb4417f5af160aeea893297fe62931d073abec7` |
| `threat-network-exfil-sysinfo` | `package/test/http.test.js:12`                      | `24ae6707e495be8f2ee60da7cf76abb1cb64cf8b2307e77e9716671196e4a7a4` |
| `threat-network-exfil-sysinfo` | `package/test/http.test.js:44`                      | `24ae6707e495be8f2ee60da7cf76abb1cb64cf8b2307e77e9716671196e4a7a4` |
| `threat-network-exfil-sysinfo` | `package/test/http.test.js:86`                      | `24ae6707e495be8f2ee60da7cf76abb1cb64cf8b2307e77e9716671196e4a7a4` |
| `threat-runtime-system-info`   | `package/test/transport/core.transpiled.test.ts:14` | `27e4f188d772c45c9c7daa3c7ae8eb8da5a492c16eb123b2ce6b2ec026766569` |
| `threat-runtime-system-info`   | `package/test/transport/core.transpiled.test.ts:20` | `27e4f188d772c45c9c7daa3c7ae8eb8da5a492c16eb123b2ce6b2ec026766569` |
| `threat-runtime-system-info`   | `package/test/transport/core.transpiled.test.ts:66` | `27e4f188d772c45c9c7daa3c7ae8eb8da5a492c16eb123b2ce6b2ec026766569` |

<a id="source-prettier"></a>

### prettier@3.9.10: false-positive

The long index.mjs string/regular expression belongs to bundled JSON5 Unicode identifier character handling. It is parser data, not a decoded or dynamically executed payload. The exact file hash and location bind this review to the inspected table.

| Rule                         | Exact archive location    | Context SHA256                                                     |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `threat-runtime-obfuscation` | `package/index.mjs:11272` | `b12454ed7e201b8abe8d2333dd46b6b58af1b3eaaa9aeda2c1e6947828574268` |

<a id="metadata-retry"></a>

### retry@0.12.0: false-positive

The sole native manifest difference is scripts.test: registry istanbul cover ./node_modules/tape/bin/tape ./test/integration/*.js versus the same command with ./node_modules/.bin/istanbul. npm script PATH resolves the same local executable; no dependency or lifecycle entry-point differs.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `e33101b139e0b892ebeceff90b709fcabddf552099a42c665e2581a35f4faa48` |

Exact differing fields: `scripts.test`.

<a id="source-set-cookie-parser"></a>

### set-cookie-parser@3.2.1: false-positive

The matched computed property finds a header whose key lowercases to set-cookie, then reads that header. It is case-insensitive HTTP header selection; no encoded string is decoded/evaluated and no obfuscated executable is constructed at the matched expression.

| Rule                             | Exact archive location            | Context SHA256                                                     |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `threat-runtime-obfuscation-api` | `package/dist/set-cookie.cjs:165` | `a2b14f96e92c6e91e2d70d5cf40dd232022c3f104f23824e4fc125f858693675` |

<a id="source-tree-kill"></a>

### tree-kill@1.2.2: false-positive

The three HTTP strings in package.json are author/contributor homepage URLs, not dependency selectors or executable downloads. The native text heuristic conflates these metadata URLs with HTTP dependencies; only these exact manifest locations and bytes are reviewed.

| Rule                         | Exact archive location    | Context SHA256                                                     |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `threat-npm-http-dependency` | `package/package.json:29` | `085e475aa81fe90a8e42d92c7348f259e370e0fc74b5d1982c6e80fc21c1f12d` |
| `threat-npm-http-dependency` | `package/package.json:35` | `085e475aa81fe90a8e42d92c7348f259e370e0fc74b5d1982c6e80fc21c1f12d` |
| `threat-npm-http-dependency` | `package/package.json:40` | `085e475aa81fe90a8e42d92c7348f259e370e0fc74b5d1982c6e80fc21c1f12d` |

<a id="metadata-typescript"></a>

### typescript@7.0.2: false-positive

All twenty differing dependencies entries are exactly version7.0.2 platform packages also present, identically, in optionalDependencies in BOTH registry and archive. The registry repeats optional dependencies under dependencies while the archive keeps them only optional. The complete exact-lock scan still includes all platform archives; no dependency is waived or substituted.

| Rule                | Exact archive location | Context SHA256                                                     |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `metadata_mismatch` | `$metadata`            | `3ed0da4c3ef9b8134e6da5cf491f457f3f31143e1a03095000a410e82476ff1d` |

Exact differing fields: `dependencies.@typescript/typescript-linux-loong64`, `dependencies.@typescript/typescript-linux-s390x`, `dependencies.@typescript/typescript-netbsd-x64`, `dependencies.@typescript/typescript-darwin-x64`, `dependencies.@typescript/typescript-win32-x64`, `dependencies.@typescript/typescript-linux-ppc64`, `dependencies.@typescript/typescript-linux-arm`, `dependencies.@typescript/typescript-aix-ppc64`, `dependencies.@typescript/typescript-linux-mips64el`, `dependencies.@typescript/typescript-netbsd-arm64`, `dependencies.@typescript/typescript-freebsd-x64`, `dependencies.@typescript/typescript-linux-x64`, `dependencies.@typescript/typescript-linux-arm64`, `dependencies.@typescript/typescript-openbsd-x64`, `dependencies.@typescript/typescript-openbsd-arm64`, `dependencies.@typescript/typescript-darwin-arm64`, `dependencies.@typescript/typescript-sunos-x64`, `dependencies.@typescript/typescript-win32-arm64`, `dependencies.@typescript/typescript-linux-riscv64`, `dependencies.@typescript/typescript-freebsd-arm64`.

<a id="source-vite"></a>

### vite@8.3.5: expected-behavior

The matched bundle sites implement documented tool behavior: .env identifiers/denylist and define transforms, Docker/WSL detection from /proc and os.release, editor-path conversion and homedir config search. The base64-exec/steganography matches correlate unrelated strings within the bundled file with a literal exec("net use") for Windows mapped-drive canonicalization; no encoded/image bytes reach that command. Review is exact-file/line-bound, not a general environment-read or process-spawn exception.

| Rule                                       | Exact archive location                   | Context SHA256                                                     |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| `threat-filesystem-read`                   | `package/dist/node/module-runner.js:786` | `7dcee739418a576f8089c0b682b979ec191ef64dce9ec8380cf8162b69df9e0d` |
| `threat-filesystem-read`                   | `package/dist/node/chunks/node.js:17138` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-filesystem-read`                   | `package/dist/node/chunks/node.js:25177` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-filesystem-read`                   | `package/dist/node/chunks/node.js:26685` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-filesystem-read`                   | `package/dist/node/chunks/node.js:37502` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-enumeration`               | `package/dist/node/chunks/node.js:14813` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-enumeration`               | `package/dist/node/chunks/node.js:14846` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-enumeration`               | `package/dist/node/chunks/node.js:14848` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-obfuscation-base64exec`    | `package/dist/node/chunks/node.js:2492`  | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-obfuscation-steganography` | `package/dist/node/chunks/node.js:2492`  | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-system-info`               | `package/dist/node/chunks/node.js:14262` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-system-info`               | `package/dist/node/chunks/node.js:14841` | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |
| `threat-runtime-system-info`               | `package/dist/node/chunks/node.js:6590`  | `5d40302b2d86ff8f3501df6503a69908dce2c2eab4ce03c154cd8745c0bec5f2` |

<a id="source-vitest"></a>

### vitest@5.0.5: expected-behavior

The matched code tracks project .env/.env.local files, handles Vite process.env define keys, includes the filesystem denylist and removes selected define entries. These are expected test-runner configuration transformations/watch inputs, not evidence of credential extraction. Exact file/line/hash matches prevent covering other filesystem accesses.

| Rule                     | Exact archive location                          | Context SHA256                                                     |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| `threat-filesystem-read` | `package/dist/chunks/cli-api.De07GUeT.js:10080` | `8b75d08fd468ac1428ef5562e43883e2cf1953c8953a7eab95da17b30ed97945` |
| `threat-filesystem-read` | `package/dist/chunks/cli-api.De07GUeT.js:10081` | `8b75d08fd468ac1428ef5562e43883e2cf1953c8953a7eab95da17b30ed97945` |
| `threat-filesystem-read` | `package/dist/chunks/index.1TqnEahn.js:2008`    | `4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412` |
| `threat-filesystem-read` | `package/dist/chunks/index.1TqnEahn.js:2051`    | `4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412` |
| `threat-filesystem-read` | `package/dist/chunks/index.1TqnEahn.js:7209`    | `4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412` |

## Unresolved true binary-presence findings

There are69 bundled_binary findings. Presence is expected for platform-specific compilers/bundlers, the Jazzer native fuzzer and Lefthook native hook manager, but a recognizable name and matching registry SRI are not an independent binary provenance or malware audit. These findings remain blocking; no binary family wildcard or blanket false-positive exception is configured. The following exact observed inventory permits review without uploading any binary.

| Locked package                                 | Native archive member / format                            | SHA256                                                             |
| ---------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `@esbuild/android-arm64@0.28.2`                | `package/bin/esbuild` (elf)                               | `84efbbd2cbf21bbfec2aaf304bee79cb2a4a05fe2ea7b861a87f7b8f213ac27d` |
| `@esbuild/freebsd-arm64@0.28.2`                | `package/bin/esbuild` (elf)                               | `6aba108a68b93064e491bfb1ecfa28843b4d4e504dff0627f53f68f6bb015c01` |
| `@esbuild/freebsd-x64@0.28.2`                  | `package/bin/esbuild` (elf)                               | `8a237e222bee0e50556e7b00d83ec2ff43721bf72f19811a5f0ee56f1d40177c` |
| `@esbuild/linux-arm64@0.28.2`                  | `package/bin/esbuild` (elf)                               | `90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2` |
| `@esbuild/linux-arm@0.28.2`                    | `package/bin/esbuild` (elf)                               | `d88f751b22095b2f3b42c8c2e8a3f36fabc1705438c5d6e78366b681f8b4e7a5` |
| `@esbuild/linux-ia32@0.28.2`                   | `package/bin/esbuild` (elf)                               | `b1e2d87d79f9a2baa0d3043cdf0dc6716f9f2eea66c58f47588641fd6019f36f` |
| `@esbuild/linux-loong64@0.28.2`                | `package/bin/esbuild` (elf)                               | `55a66f9854d6798f36b2b5471db74f2e552481887ea14d8bda1634a512383a43` |
| `@esbuild/linux-mips64el@0.28.2`               | `package/bin/esbuild` (elf)                               | `6bf7921a3af4a801051e056d85c360fe24bb446f488ef3da25f0b8e5cf973db1` |
| `@esbuild/linux-ppc64@0.28.2`                  | `package/bin/esbuild` (elf)                               | `c30df60d09bb0ba4853d7b06e244ce966890d61ce60cadd9b22335f6379c316a` |
| `@esbuild/linux-riscv64@0.28.2`                | `package/bin/esbuild` (elf)                               | `36bdcdc8230eef385838cdfeb0d9a1565cbe4b9ace30097a511d77e894de36a1` |
| `@esbuild/linux-s390x@0.28.2`                  | `package/bin/esbuild` (elf)                               | `bbbc1f92a76a5ca6e2976065222e42b02797363a1f119490dda315f74047741f` |
| `@esbuild/linux-x64@0.28.2`                    | `package/bin/esbuild` (elf)                               | `e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100` |
| `@esbuild/netbsd-arm64@0.28.2`                 | `package/bin/esbuild` (elf)                               | `62548519d7ae875d060aa8c94bfb8ed38ef191671a5173d9f626bdb6b7516970` |
| `@esbuild/netbsd-x64@0.28.2`                   | `package/bin/esbuild` (elf)                               | `f9d0e59d2b404559e3a0c958164d96960ebf0e04583b878b1d64d8f1c3698fcc` |
| `@esbuild/openbsd-arm64@0.28.2`                | `package/bin/esbuild` (elf)                               | `e10c45a0b62456632da41df058d7626b2e7cfe710780a2dc7f9f84681753f3aa` |
| `@esbuild/openbsd-x64@0.28.2`                  | `package/bin/esbuild` (elf)                               | `720bbe607736716f2ecd37962436c5589d801966e868a2ae4e0e7e62d1e4e887` |
| `@esbuild/sunos-x64@0.28.2`                    | `package/bin/esbuild` (elf)                               | `01a3bd9183631ca749f34d15601ea21ba6834614184c5c859f99d54bd683203d` |
| `@esbuild/win32-arm64@0.28.2`                  | `package/esbuild.exe` (exe)                               | `530fb3933af14eefe85dfd06502f826e6ef60fdf4e75228ea67c696db312ecb1` |
| `@esbuild/win32-ia32@0.28.2`                   | `package/esbuild.exe` (exe)                               | `b2e62af5c17e00939583be0a0762fdc469f352869a617edc91371b00454c76f0` |
| `@esbuild/win32-x64@0.28.2`                    | `package/esbuild.exe` (exe)                               | `c7bee37877d0aa6a046e52783fa0a2cf1a9ce5579d68bb3083bda99d4bff18ef` |
| `@jazzer.js/fuzzer@4.0.0`                      | `package/prebuilds/fuzzer-linux-arm64.node` (elf)         | `36dc7f84ab80c2586e2d79671cf068726022d0a33b5f427354145587521a8a0d` |
| `@jazzer.js/fuzzer@4.0.0`                      | `package/prebuilds/fuzzer-linux-x64.node` (elf)           | `59ffc0d22ea37c5edcf3d8b9b76b1d964940461a9337d0b14068e378e7703ac9` |
| `@jazzer.js/fuzzer@4.0.0`                      | `package/prebuilds/fuzzer-win32-x64.node` (exe)           | `6dcbbb1452b50559c21fcd13b0187d484f84b123538c10b618c001b56e12b65c` |
| `@rolldown/binding-android-arm-eabi@1.2.15`    | `package/rolldown-binding.android-arm-eabi.node` (elf)    | `d3db106d18a89aadd3a81b372b0fd73632faba6afe45aeae26a799342760376a` |
| `@rolldown/binding-android-arm64@1.2.15`       | `package/rolldown-binding.android-arm64.node` (elf)       | `b8851475c6b9a8bfd1814a427baa206f7422458b3bf6778fb4e39a6f60b777d2` |
| `@rolldown/binding-freebsd-x64@1.2.15`         | `package/rolldown-binding.freebsd-x64.node` (elf)         | `8cb5c50102977e23ef495e434492c4ebc76b7c0b98233562445b729257286cd2` |
| `@rolldown/binding-linux-arm-gnueabihf@1.2.15` | `package/rolldown-binding.linux-arm-gnueabihf.node` (elf) | `ff58d31aaec050f4e0bf98f3494f18a6be5cfdeeb4861f80020587ea504adbac` |
| `@rolldown/binding-linux-arm64-gnu@1.2.15`     | `package/rolldown-binding.linux-arm64-gnu.node` (elf)     | `1032f7a6c06f1f0899eb329d38a0b44064833fb010ae739e974a01165d748cdd` |
| `@rolldown/binding-linux-arm64-musl@1.2.15`    | `package/rolldown-binding.linux-arm64-musl.node` (elf)    | `a7336ef7769ba5c0238ac8a579d747a51b323460019dfee0755b7f33ebf98192` |
| `@rolldown/binding-linux-ppc64-gnu@1.2.15`     | `package/rolldown-binding.linux-ppc64-gnu.node` (elf)     | `4a8e5e9110f90ab9503856154c6bdd1d1bf8d950ba7644ac320760eefa1703c9` |
| `@rolldown/binding-linux-s390x-gnu@1.2.15`     | `package/rolldown-binding.linux-s390x-gnu.node` (elf)     | `bdec5c1be9cf23a3ac839ae39ff4361b74ed3b2ed0d59195c10004ade0619a95` |
| `@rolldown/binding-linux-x64-gnu@1.2.15`       | `package/rolldown-binding.linux-x64-gnu.node` (elf)       | `4ce83b61f7e4e8045bbc838891204936e0eedf091ffb5d765af680751d24ed75` |
| `@rolldown/binding-linux-x64-musl@1.2.15`      | `package/rolldown-binding.linux-x64-musl.node` (elf)      | `af42aa23b84b43c18800593013268d50f9e242564c41956949f62ee1f9ec947e` |
| `@rolldown/binding-openharmony-arm64@1.2.15`   | `package/rolldown-binding.openharmony-arm64.node` (elf)   | `7fd422ea470f14a392381bfac268d275ef5705c9a0638db85f72a47c85dd1247` |
| `@rolldown/binding-win32-arm64-msvc@1.2.15`    | `package/rolldown-binding.win32-arm64-msvc.node` (exe)    | `39822bd3c70ecb2752caf56ab439d97ea6c605626098fe259d1aefc765808bbf` |
| `@rolldown/binding-win32-x64-msvc@1.2.15`      | `package/rolldown-binding.win32-x64-msvc.node` (exe)      | `d43e03f44c3351f8f75dcc535b5cdc79b231ed27401b9612095b2a321fc20d85` |
| `@typescript/typescript-freebsd-arm64@7.0.2`   | `package/lib/tsc` (elf)                                   | `4dd1288c15ae3be561b866a0e7558c60348c1095314e6a7a11d449495b1f5b56` |
| `@typescript/typescript-freebsd-x64@7.0.2`     | `package/lib/tsc` (elf)                                   | `0ab3d491a64bf753bb318aad3093135b5bbb49efd4311e746c50876fac9ff3bf` |
| `@typescript/typescript-linux-arm64@7.0.2`     | `package/lib/tsc` (elf)                                   | `f86e8070c267b12d6c119bf567cb82d8b245e9d93da1864bc7c603cea10a8b2f` |
| `@typescript/typescript-linux-arm@7.0.2`       | `package/lib/tsc` (elf)                                   | `ac9f058e914d421f13bcc74e75cda9d2aac935997377d6aac59c98fbce287c66` |
| `@typescript/typescript-linux-loong64@7.0.2`   | `package/lib/tsc` (elf)                                   | `ccf4a71662bcd8ce99650fb4fcb8909eb00990cb4d3bd681bd2a6907803a01c6` |
| `@typescript/typescript-linux-mips64el@7.0.2`  | `package/lib/tsc` (elf)                                   | `9ce934b02e68d35ff893667bca6dbd1175d46d0b4514e803ad3b8dd53ef3f457` |
| `@typescript/typescript-linux-ppc64@7.0.2`     | `package/lib/tsc` (elf)                                   | `2bb35c390ee7574b388b05b202ae05132e4785c6a8b45a76473d2feec3db5e65` |
| `@typescript/typescript-linux-riscv64@7.0.2`   | `package/lib/tsc` (elf)                                   | `decf029d3f09ab84e001a8ceab0d3e198dcd3a795fb7b0cf7cea8f5ccd178264` |
| `@typescript/typescript-linux-s390x@7.0.2`     | `package/lib/tsc` (elf)                                   | `f5c90811063f849dfc078b2e606d0820af15ed1913dae9f31bfd3e131c0e70ea` |
| `@typescript/typescript-linux-x64@7.0.2`       | `package/lib/tsc` (elf)                                   | `4f2de678286401759b3fb4475bafe35b8f32b4b3a07d92642bbf37eadc9b34a4` |
| `@typescript/typescript-netbsd-arm64@7.0.2`    | `package/lib/tsc` (elf)                                   | `4c0a229143602a826a71eb213d0ff2153ce88256c55fd2bd63cf8227726da0aa` |
| `@typescript/typescript-netbsd-x64@7.0.2`      | `package/lib/tsc` (elf)                                   | `b47540a029d32a21b5eba2e891d30c85c578a3fef437bdda5788dbeda101718b` |
| `@typescript/typescript-openbsd-arm64@7.0.2`   | `package/lib/tsc` (elf)                                   | `f1e8bd331f46cd82257853c4aad4af0cf2756b04ded74c4145efcf3f924c600d` |
| `@typescript/typescript-openbsd-x64@7.0.2`     | `package/lib/tsc` (elf)                                   | `280f6c00bde77f61754aca6e87c958fd6d8fb15f0da4ed442b88de50884f9373` |
| `@typescript/typescript-sunos-x64@7.0.2`       | `package/lib/tsc` (elf)                                   | `109170d9aaae6203769e48ef7dc3eb302d84a51515c18c8602fa111240e1d408` |
| `@typescript/typescript-win32-arm64@7.0.2`     | `package/lib/tsc.exe` (exe)                               | `2ec832b3d17ce25676fe92b3810ecc0a7580ffb9287d4972bc9a5acc4da2aa50` |
| `@typescript/typescript-win32-x64@7.0.2`       | `package/lib/tsc.exe` (exe)                               | `f9ecfbdc93753d2c972d66a8d0d75f5bd737fd4a5f88b422d9091ea282bcb2c7` |
| `lefthook-android-arm64@2.2.2`                 | `package/bin/lefthook` (elf)                              | `c6a7977eeba6e6a6e422087fe2767daf6e4c9bde8c2c24cf8a2b985a36f67945` |
| `lefthook-freebsd-arm64@2.2.2`                 | `package/bin/lefthook` (elf)                              | `b046ff9aaa5ca198256343b904de619abe866f1da8e4bf78f24e48a0e6895703` |
| `lefthook-freebsd-x64@2.2.2`                   | `package/bin/lefthook` (elf)                              | `ad6d1d92327bebe816dd8eb04bfee0451f43a3311de189468e6b9c2319318d34` |
| `lefthook-linux-arm64@2.2.2`                   | `package/bin/lefthook` (elf)                              | `08fb1bfbc40c8ecd16b6fa1ff4590da31b255d70883776eaf5b0e9f46f80416f` |
| `lefthook-linux-x64@2.2.2`                     | `package/bin/lefthook` (elf)                              | `7771d6243018b445bb83dd3c9b12dffd92a6067a3958f21d984bb389d8dbbc58` |
| `lefthook-openbsd-arm64@2.2.2`                 | `package/bin/lefthook` (elf)                              | `0eae396ea15de5466eacfbabe65ad107c65587672b3b964dc5eeb76360d04cc3` |
| `lefthook-openbsd-x64@2.2.2`                   | `package/bin/lefthook` (elf)                              | `acbceea8799f2899f2232e136e2c271d8393347418fbe81867848b8d035d26fa` |
| `lefthook-windows-arm64@2.2.2`                 | `package/bin/lefthook.exe` (exe)                          | `0e3f37226c6b87c9e40eba85f735af9b8f0bc8ad3b7523c3c01ffe6ff1bc2785` |
| `lefthook-windows-x64@2.2.2`                   | `package/bin/lefthook.exe` (exe)                          | `842f3fa8593e99ee36e1ab5243718b1ff8482361f7f5c7e434a04ab7889afd7d` |
| `lightningcss-android-arm64@1.33.0`            | `package/lightningcss.android-arm64.node` (elf)           | `d754cdc0af391caa283f435b53d1b11f9d1933b6b611c4b7d45e2e23d2104ec6` |
| `lightningcss-freebsd-x64@1.33.0`              | `package/lightningcss.freebsd-x64.node` (elf)             | `dfb2f178af52beafdc4f30e65582f21c488796ac4474263881b7f0293cf18feb` |
| `lightningcss-linux-arm-gnueabihf@1.33.0`      | `package/lightningcss.linux-arm-gnueabihf.node` (elf)     | `f1753b0c73545d71d55b0aeaea753bea9f2b9497ce7fbbb6b027a22b4883322d` |
| `lightningcss-linux-arm64-gnu@1.33.0`          | `package/lightningcss.linux-arm64-gnu.node` (elf)         | `630753f910bd6235aad7d702a984c109aa723563342b8057b88f34306702b626` |
| `lightningcss-linux-arm64-musl@1.33.0`         | `package/lightningcss.linux-arm64-musl.node` (elf)        | `1505fe66a29fcf11576b9b66bca8c65521641e291475dd880ea74d37a8e8de77` |
| `lightningcss-linux-x64-gnu@1.33.0`            | `package/lightningcss.linux-x64-gnu.node` (elf)           | `84c6f35fb9c78f9920090f4017a9dc6dc50842a56c543f509943a0d434325d93` |
| `lightningcss-linux-x64-musl@1.33.0`           | `package/lightningcss.linux-x64-musl.node` (elf)          | `a5cf77ba1e47a5539987d569d973bc9389f8c2bb1522d36a3adf22c82afaa86d` |
| `lightningcss-win32-arm64-msvc@1.33.0`         | `package/lightningcss.win32-arm64-msvc.node` (exe)        | `a2e857f84767de7e39da00d908696824ffaeea38251f49b048b2d8cf42dfdb6c` |
| `lightningcss-win32-x64-msvc@1.33.0`           | `package/lightningcss.win32-x64-msvc.node` (exe)          | `d043df0f0675e7fffed4cf8b8c33e28639ec9f21d445c21e7fe4985e4a9b5a91` |

## Unresolved provenance regression

lefthook2.2.2 lacks registry dist.attestations;2.2.1 has an [npm provenance endpoint](https://registry.npmjs.org/-/npm/v1/attestations/lefthook@2.2.1). Its official release-tag tree eb4e504b7c1d1ea6cb1fd29542431cb6d1a93a03 has [release.yml](https://github.com/evilmartians/lefthook/blob/eb4e504b7c1d1ea6cb1fd29542431cb6d1a93a03/.github/workflows/release.yml) and [npm publishing helper](https://github.com/evilmartians/lefthook/blob/eb4e504b7c1d1ea6cb1fd29542431cb6d1a93a03/packaging/scripts/lib/npm.sh); this shows intended CI tooling, not proof that the npm archive was published by that run. No provenance exception is configured. Remediation requires independently binding actual published bytes to trusted release evidence or choosing a reviewed attested version; neither a project reputation nor optional repository commit-signing policy resolves this finding.

## Primary reference material

- [Pinned native manifest comparator](https://github.com/DataDog/guarddog/blob/v3.2.0/guarddog/analyzer/metadata/npm/metadata_mismatch.py): typed main comparison and dependency/script fields.
- [npm script PATH and implicit node-gyp defaults](https://docs.npmjs.com/cli/v11/using-npm/scripts/).
- [fsevents2.3.3 manifest](https://github.com/fsevents/fsevents/blob/v2.3.3/package.json) and [binding.gyp](https://github.com/fsevents/fsevents/blob/v2.3.3/binding.gyp).
- Exact current registry metadata was fetched over HTTPS without credentials for only the six mismatch packages and Lefthook; no application bytes were sent. No newly fetched archive was parsed outside the supported hosted sandbox.
