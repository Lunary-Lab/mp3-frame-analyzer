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

The per-file upload limit defaults to **50 MiB (52,428,800 bytes)**. To set a
100 MiB limit for both raw and multipart files:

```bash
MAX_UPLOAD_BYTES=104857600 HOST=127.0.0.1 PORT=3000 npm start
```

`MAX_UPLOAD_BYTES` must be decimal digits representing `1` through
`9007199254740991` bytes; leading zeros are allowed. Only an absent variable
uses the default. Empty values, whitespace, signs, fractions, exponents, units,
and unsafe integers fail startup before listening. There is no unlimited mode.
The limit includes file bytes, not multipart envelope overhead, and applies
also to raw requests without `Content-Length`. Increasing it does not increase
request timeouts or the separately configured upload-admission limit.

`MAX_MULTIPART_BYTES` separately caps the aggregate multipart body, including its
envelope, preamble, epilogue and discarded bytes. It defaults to the configured
file limit plus 65,536 bytes, capped at `9007199254740991`, and uses the same
positive-decimal startup validation. A lower explicit value is allowed; it also
reduces the space available for file bytes. Known or observed excess is
`413 request-too-large` with connection closure. A response already chosen for an
earlier error remains unchanged, but draining stops at this aggregate budget.
The counter measures transfer-decoded HTTP body bytes, not HTTP framing, arbitrary
Content-Encoding decompression or a strict network-byte cap. Transport read-ahead
and the crossing chunk can exceed the configured value; ingress limits are still
needed for public deployments.

`MAX_ACTIVE_UPLOADS` limits simultaneously accepted uploads in this server
instance; default **8**, allowed decimal integers **1–1024**, leading zeros
allowed. Invalid or empty values fail before listening; there is no unlimited
mode. Requests over the cap receive JSON
`{"error":"server-busy","message":"Upload capacity is temporarily exhausted"}`,
HTTP **503**, `Retry-After: 1`, and `Connection: close`, without an application
queue or draining the rejected body. Slots include lingering multipart cleanup,
not just requests awaiting their response. A higher setting requires measuring
your own memory and latency budgets. This is not a fleet-wide or per-user quota,
nor a limit on all TCP connections; ingress protections remain necessary.

From another terminal, upload a MPEG-1 Layer III file:

```bash
curl -i http://127.0.0.1:3000/file-upload \
  -F 'file=@/path/to/audio.mp3;type=audio/mpeg'
```

Successful responses use `application/json` and contain only `{"frameCount":<number>}`. By default, counts exclude one recognized initial Xing/Info/VBRI metadata frame; explicit `?includeVbrHeaderFrame=false` selects the same policy. Append `?includeVbrHeaderFrame=true` to count all physical MPEG frames. A file without a recognized initial metadata frame has the same count under every option. Free-format MPEG-1 Layer III is supported through bounded header-spacing inference; insufficient evidence or an equal best-score tie is rejected. The source repository README describes the remaining format and upload limits.

This HTTP default is a breaking change from the published v1.1.0 behavior, which counted all physical frames. Use the runtime instructions bundled with a downloaded release to identify that release's contract. No new release is implied by this source documentation.

`release-metadata.json` identifies the release version, tag, source commit, and Node/npm versions used to package it. Its contents match the external `.manifest.json`. The `.cdx.json` file is a CycloneDX application SBOM generated from production dependencies in the lockfile. Packaging validates the supported CycloneDX 1.5 schema, exact component identities and SHA-512 integrity, and dependency edges checked against native `npm ls` resolution from the same production lock projection. The SBOM describes locked production dependencies, not bundled Node/OS binaries or the CI toolchain; it is not a vulnerability-free certificate. `SHA256SUMS` covers the archive, SBOM, and manifest.

Send `SIGTERM` or `SIGINT` to stop the service. The server allows accepted requests to finish within a 10-second shutdown deadline. Connections that become idle after their request bodies and responses finish are closed, including ordinary keep-alive connections; still-active requests are not forcibly closed early. Body and response completion can occur in either order. If active work or a close hook cannot finish by the deadline, the process logs a sanitized failure and exits 1. Normal keep-alive reuse is unchanged outside shutdown. Choose `HOST=0.0.0.0` only when the service must listen beyond loopback, and supply deployment-specific TLS, authentication, rate limits, and aggregate concurrency controls at the ingress.

The source README also contains contributor commands. Source, tests, development scripts, and fixtures are deliberately absent from this runtime archive; use the Git repository for development and verification.

Raw uploads are also accepted at `POST /file-upload` using `Content-Type: audio/mpeg` with a streamed binary request body. Raw and multipart requests use the same counting option: omitted/`false` excludes a recognized initial metadata frame, and `true` includes it. The supplied assessment sample returns 6089 by default and 6090 with `?includeVbrHeaderFrame=true`. This is structural counting without audio decoding; it does not guarantee the same result as every media tool.
