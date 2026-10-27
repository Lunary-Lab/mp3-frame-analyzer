import { sha256 } from './mutation-policy.mjs';

// Reviewed complete test-root source closures, not observed read sets or a
// general filesystem resolver. This binds the caller, every imported helper,
// and parser source as well as the reader: a helper cannot silently redefine
// URL, Buffer, a callback, or an encoder before an otherwise unchanged read.
// Every read in these exact closures targets the named committed regular files.
// Unknown/changed closures stay affected; no baseline can refresh these hashes.
// Resource bytes/modes remain global and the final snapshot is mandatory.
const reviewed = {
  'tests/count-frames.test.ts': {
    closureSha256: 'acb68306635ed8679131e9aba19d4ff8da818f0c65149934d9668c667ef3774d',
    resources: ['tests/fixtures/cbr.mp3', 'tests/fixtures/vbr.mp3', 'tests/fixtures/no-xing.mp3'],
  },
  'tests/free-format-real.test.ts': {
    closureSha256: '099e614acffb5edca01435b77a82b424b0e16328ef904f9ca100438b5391d956',
    resources: ['tests/fixtures/lame-free-format.json'],
  },
  'tests/short-free-format.test.ts': {
    closureSha256: 'f324a515ec743ba7a03d0dce92c1bf498a4bb63f34298c9fb7a0e37dbb8a569d',
    resources: ['tests/fixtures/short-free-format.json'],
  },
  'tests/free-format-metadata.test.ts': {
    closureSha256: 'bddb78a6c6af22a18b3e48bdcf22c450527b1e5f375b7cce19cf8418de609696',
    resources: ['tests/fixtures/short-free-format.json'],
  },
  'tests/partial-metadata-prefix.test.ts': {
    closureSha256: '52f37174002bb449746904617b94faf9ea683609de559d10fc66d6e50571c6ff',
    resources: ['tests/fixtures/short-free-format.json'],
  },
  'tests/fuzz-regressions.test.ts': {
    closureSha256: 'eabfdaa1a9e906c158a20b5e38682464b5fadb151bb7dd8294be585b9b2d70a4',
    resources: [
      'fuzz/regressions/raw/reserved-emphasis.bin',
      'fuzz/regressions/raw/truncated-header.bin',
      'fuzz/regressions/raw/oversized-id3-length.bin',
      'fuzz/regressions/raw/free-format-three-short-frames.bin',
      'fuzz/regressions/raw/free-format-minimum.bin',
      'fuzz/regressions/raw/free-format-prefix-only.bin',
      'fuzz/regressions/raw/free-format-prefix-crc.bin',
    ],
  },
};

export function reviewedResourceInputs(test, files, closure, inventory = []) {
  const contract = reviewed[test];
  if (!contract || closure.uncertain || closure.writes) return null;
  const sourceIdentities = [...closure.files].sort().map((path) => {
    const source = files.get(path);
    return [path, typeof source === 'string' ? sha256(source) : null];
  });
  if (sha256(JSON.stringify(sourceIdentities)) !== contract.closureSha256) return null;
  const entries = new Map(inventory.map(([path, ...identity]) => [path, identity]));
  if (entries.size !== inventory.length) return null;
  if (
    !contract.resources.every((path) => {
      const entry = entries.get(path);
      return entry?.length === 2 && entry[0] === 0o644 && /^[a-f0-9]{64}$/.test(entry[1]);
    })
  )
    return null;
  return new Set(contract.resources);
}
