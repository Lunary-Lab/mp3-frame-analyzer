# Run a release archive

The release contains compiled JavaScript, the exact npm lockfile, and runtime instructions. Use Node.js 24 or 26 and npm 11.9 or later within major 11; the repository pins npm 11.19.0 for release builds. No TypeScript compiler or development packages are needed to run the service.

Download the versioned `.tar.gz`, `.cdx.json`, `.manifest.json`, and `SHA256SUMS` files from the same GitHub release. Check their hashes before extracting:

```bash
sha256sum --check SHA256SUMS
tar -xzf mp3-frame-analyzer-1.0.0.tar.gz
cd mp3-frame-analyzer-1.0.0
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
HOST=127.0.0.1 PORT=3000 npm start
```

Replace `1.0.0` in the filename and directory with the downloaded version. Runtime installation requires access to the npm registry for the dependencies named in `package-lock.json`. The archive does not bundle `node_modules`.

From another terminal, upload a MPEG-1 Layer III file:

```bash
curl -i http://127.0.0.1:3000/file-upload \
  -F 'file=@/path/to/audio.mp3;type=audio/mpeg'
```

Successful responses use `application/json` and contain only `{"frameCount":<number>}`. By default, counts exclude one recognized initial Xing/Info/VBRI metadata frame; explicit `?includeVbrHeaderFrame=false` selects the same policy. Append `?includeVbrHeaderFrame=true` to count all physical MPEG frames. A file without a recognized initial metadata frame has the same count under every option. Free-format MPEG-1 Layer III is supported through bounded header-spacing inference; insufficient evidence or an equal best-score tie is rejected. The source repository README describes the remaining format and upload limits.

This HTTP default is a breaking change from the published v1.1.0 behavior, which counted all physical frames. Use the runtime instructions bundled with a downloaded release to identify that release's contract. No new release is implied by this source documentation.

`release-metadata.json` identifies the release version, tag, source commit, and Node/npm versions used to package it. Its contents match the external `.manifest.json`. The `.cdx.json` file is a CycloneDX application SBOM generated from production dependencies in the lockfile. `SHA256SUMS` covers the archive, SBOM, and manifest.

Send `SIGTERM` or `SIGINT` to stop the service. The server allows requests to drain within a bounded shutdown interval. Choose `HOST=0.0.0.0` only when the service must listen beyond loopback, and supply deployment-specific TLS, authentication, rate limits, and aggregate concurrency controls at the ingress.

The source README also contains contributor commands. Source, tests, development scripts, and fixtures are deliberately absent from this runtime archive; use the Git repository for development and verification.

Raw uploads are also accepted at `POST /file-upload` using `Content-Type: audio/mpeg` with a streamed binary request body. Raw and multipart requests use the same counting option: omitted/`false` excludes a recognized initial metadata frame, and `true` includes it. The supplied assessment sample returns 6089 by default and 6090 with `?includeVbrHeaderFrame=true`. This is structural counting without audio decoding; it does not guarantee the same result as every media tool.
