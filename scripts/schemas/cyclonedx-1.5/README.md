# Reviewed CycloneDX 1.5 schema

These files are byte-for-byte copies from the official
[CycloneDX specification tag 1.5](https://github.com/CycloneDX/specification/tree/c320fc0f0b46873864927d9d5684eea7ba439728),
commit `c320fc0f0b46873864927d9d5684eea7ba439728`. The accompanying Apache-2.0
license is retained. No schema is fetched while packaging or testing.

| File                   | Upstream path                 | SHA-256                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `bom-1.5.schema.json`  | `schema/bom-1.5.schema.json`  | `067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b` |
| `spdx.schema.json`     | `schema/spdx.schema.json`     | `4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc` |
| `jsf-0.82.schema.json` | `schema/jsf-0.82.schema.json` | `8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae` |
| `LICENSE`              | `LICENSE`                     | `6c29f22a4a7385285c6f579ec9f33c5e989f00739d6b257243a0b082ec9447ae` |

The pinned npm 11.19.0 generator emits CycloneDX 1.5. `sbom-schema.mjs` validates
that exact version with Ajv and `ajv-formats`. International URL/email formats
use the maintained [`@hyperjump/json-schema-formats`](https://github.com/hyperjump-io/json-schema-formats)
functions through Ajv's documented [`addFormat` extension](https://ajv.js.org/guide/formats.html).
The older `ajv-formats-draft2019` plugin was
rejected because its IRI parser silently accepts malformed input; the negative
controls retain those cases. The upstream
schema's `specVersion` field is only typed as a string, so the supported version
is also checked explicitly. Ajv's nonstandard-keyword strictness is disabled for
the upstream descriptive annotations, **not** schema or format validation.
Validation never coerces data, supplies defaults, or removes properties.

The schema permits graphs and hashes that are structurally valid but wrong for
this release. Separate checks require exact production lock identities and
SHA-512 digests, and compare the graph with native `npm ls` resolution. Neither
schema validation nor an SBOM claims that dependencies are vulnerability-free.

The validator dependencies are development-only tooling. Ajv and ajv-formats
already occur in the production graph through Fastify; declaring their tooling
use does not add runtime components. The only new lock records are development-only
`@hyperjump/json-schema-formats` 1.1.0, `@hyperjump/uri` 1.3.9 and `idn-hostname`
15.1.19 (all MIT); their `punycode` dependency was already locked. They add standard
format checks, not a second SBOM generator, package resolver or vulnerability scanner.
They are not included in the production SBOM or installed runtime.
