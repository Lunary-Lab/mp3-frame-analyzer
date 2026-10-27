import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateSbomSchema } from './sbom-schema.mjs';

const minimal = () => ({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1 });

test('reviewed official schemas and license remain byte-exact with a closed local reference set', async () => {
  const hashes = {
    'bom-1.5.schema.json': '067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b',
    'spdx.schema.json': '4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc',
    'jsf-0.82.schema.json': '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
    LICENSE: '6c29f22a4a7385285c6f579ec9f33c5e989f00739d6b257243a0b082ec9447ae',
  };
  for (const [name, digest] of Object.entries(hashes)) {
    const data = await readFile(new URL(`./schemas/cyclonedx-1.5/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), digest, name);
  }
});

test('schema validation preserves valid input without adding defaults or deleting properties', () => {
  const bom = minimal();
  const before = structuredClone(bom);
  validateSbomSchema(bom);
  assert.deepEqual(bom, before);
  for (const specVersion of ['1.4', '1.6', '999', null, undefined]) {
    assert.throws(() => validateSbomSchema({ ...minimal(), specVersion }), /schema version/);
  }
});

test('schema international formats are validated, not silently ignored or reduced to ASCII', () => {
  const bom = {
    ...minimal(),
    metadata: {
      authors: [{ name: 'Author', email: 'user@例え.テスト' }],
      component: {
        name: 'Application',
        type: 'application',
        supplier: { url: ['https://例え.テスト/パス'] },
      },
      timestamp: '2026-10-27T03:00:00Z',
    },
  };
  validateSbomSchema(bom);
  for (const reference of ['../パス?値=1#節', 'custom:identifier']) {
    const relative = structuredClone(bom);
    relative.metadata.component.supplier.url = [reference];
    validateSbomSchema(relative);
  }
  for (const mutate of [
    (value) => {
      value.metadata.authors[0].email = 'not-an-email';
    },
    (value) => {
      value.metadata.component.supplier.url = ['https://[invalid'];
    },
    (value) => {
      value.metadata.component.supplier.url = ['https://example.com/\u0000'];
    },
    (value) => {
      value.metadata.component.supplier.url = ['https://example.com/hello world'];
    },
    (value) => {
      value.metadata.component.supplier.url = ['https://example.com/%XY'];
    },
    (value) => {
      value.metadata.timestamp = '2026-02-30T03:00:00Z';
    },
  ]) {
    const broken = structuredClone(bom);
    mutate(broken);
    assert.throws(() => validateSbomSchema(broken), /schema violation/);
  }
});
