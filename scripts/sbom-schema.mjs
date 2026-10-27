import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { isIdnEmail, isIriReference } from '@hyperjump/json-schema-formats';

// The upstream schema contains descriptive extension keywords outside Ajv's
// strict dialect. Standard validation and every used format remain enabled;
// no coercion, defaults, property removal, or remote schema loading is allowed.
const ajv = new Ajv({ strict: false, validateFormats: true });
addFormats(ajv, ['date-time', 'uri']);
ajv.addFormat('iri-reference', isIriReference);
ajv.addFormat('idn-email', isIdnEmail);
for (const name of ['spdx.schema.json', 'jsf-0.82.schema.json', 'bom-1.5.schema.json']) {
  const path = new URL(`./schemas/cyclonedx-1.5/${name}`, import.meta.url);
  ajv.addSchema(JSON.parse(readFileSync(path, 'utf8')));
}
const validate = ajv.getSchema('http://cyclonedx.org/schema/bom-1.5.schema.json');

export function validateSbomSchema(sbom) {
  // The upstream schema's specVersion is a string, not a version constraint.
  assert.equal(sbom?.specVersion, '1.5', 'Unsupported production SBOM schema version');
  assert.ok(
    validate(sbom),
    `CycloneDX 1.5 schema violation: ${ajv.errorsText(validate.errors).slice(0, 1000)}`,
  );
}
