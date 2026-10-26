import { readFile } from 'node:fs/promises';
import { metadataTag, type Id3Version } from './metadata-fixtures.js';

interface Fixture {
  rate: number;
  channels: number;
  crc: boolean;
  kbps: number;
  pcmSamples: number;
  sha256: string;
  base64: string;
}
const manifest = JSON.parse(
  await readFile(new URL('../fixtures/short-free-format.json', import.meta.url), 'utf8'),
) as { fixtures: Fixture[] };
export const singletonFixture = manifest.fixtures.find(
  (item) =>
    item.rate === 44100 &&
    item.channels === 1 &&
    !item.crc &&
    item.kbps === 128 &&
    item.pcmSamples === 0,
)!;
export const singleton = Buffer.from(singletonFixture.base64, 'base64');

export interface PrefixCase {
  name: string;
  family: 'header' | 'footer';
  available: number;
  changedAt: number | undefined;
  impossibleUnderSupportedPolicy: boolean;
  prefix: Buffer;
}

// Independent author-spec oracle: only a changed byte that is actually present
// can disprove the supported envelope. A missing byte has no guessed value.
// ID3v2.2/2.3 §3.1 and ID3v2.4 Structure §§3.1/3.4; version 5 is unsupported
// under project policy, not intrinsically invalid under all future ID3 formats.
function headerCases(): PrefixCase[] {
  const cases: PrefixCase[] = [];
  for (const version of [2, 3, 4] as const) {
    const template = metadataTag(version).subarray(0, 10);
    const changes = [
      { label: 'plausible', at: undefined, value: 0 },
      { label: 'unsupported-version-5', at: 3, value: 5 },
      { label: 'forbidden-version-255', at: 3, value: 255 },
      { label: 'forbidden-revision-255', at: 4, value: 255 },
      ...reservedFlags(version).map((value) => ({
        label: `reserved-flag-${value}`,
        at: 5,
        value,
      })),
      ...[6, 7, 8, 9].map((at) => ({ label: `size-high-bit-${at - 6}`, at, value: 128 })),
    ];
    // Length 10 is a complete-header control beyond the requested 3–9 matrix.
    for (let available = 3; available <= 10; available++) {
      for (const change of changes) {
        const header = Buffer.from(template);
        if (change.at !== undefined) header[change.at] = change.value;
        cases.push({
          name: `v2.${version}-header-${available}-${change.label}`,
          family: 'header',
          available,
          changedAt: change.at,
          impossibleUnderSupportedPolicy: change.at !== undefined && change.at < available,
          prefix: header.subarray(0, available),
        });
      }
    }
  }
  return cases;
}

function reservedFlags(version: Id3Version): number[] {
  // The author-spec header diagrams reserve low 6, 5, or 4 bits respectively.
  return Array.from({ length: version === 2 ? 6 : version === 3 ? 5 : 4 }, (_, bit) => 2 ** bit);
}

function footerCases(): PrefixCase[] {
  const cases: PrefixCase[] = [];
  const template = metadataTag(4, { footer: true });
  const footerStart = template.length - 10;
  for (let available = 0; available <= 9; available++) {
    for (const changedAt of [undefined, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const envelope = Buffer.from(template);
      if (changedAt !== undefined) envelope[footerStart + changedAt]! ^= 1;
      cases.push({
        name: `v2.4-footer-${available}-${changedAt === undefined ? 'plausible' : `mismatch-${changedAt}`}`,
        family: 'footer',
        available,
        changedAt,
        impossibleUnderSupportedPolicy: changedAt !== undefined && changedAt < available,
        prefix: envelope.subarray(0, footerStart + available),
      });
    }
  }
  return cases;
}

export const prefixCases = [...headerCases(), ...footerCases()];

export function withAncillarySuffix(prefix: Uint8Array): Buffer {
  const bytes = Buffer.from(singleton);
  const start = bytes.length - prefix.length;
  if (start < 21) throw new Error('Fixture would modify MPEG header/side information');
  bytes.set(prefix, start);
  return bytes;
}
