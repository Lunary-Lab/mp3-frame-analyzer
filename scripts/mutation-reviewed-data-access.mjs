import { sha256 } from './mutation-policy.mjs';

// Reviewed source-bound exceptions ONLY for the listed numeric data-index sites.
// No runtime capture or baseline may refresh these hashes. All other capability
// checks still run, including the children of each allowed element access.
const reviewed = {
  'src/mp3/byte-reader.ts': {
    sourceSha256: 'bb74f57593547411c3d4bacf4d6bec9e79cb4f11facdbe53c74e8608decd5511',
    sites: ['this.queued[this.headIndex]', 'this.queued[i]'],
  },
  'src/mp3/encoder-frame.ts': {
    sourceSha256: 'c2ca9dba0d79d33ae816711eb2bfa344eae082cb45dc821498edb063a1f5e1e8',
    sites: [
      'frame[offset + index]',
      'bytes[offset]',
      'bytes[offset + 1]',
      'bytes[offset + 2]',
      'bytes[offset + 3]',
      'frame[position + 4]',
      'frame[position + 5]',
      'frame[position + 18]',
      'frame[position + 19]',
      'frame[position + 22]',
      'frame[position + 23]',
    ],
  },
  'src/mp3/frame-header.ts': {
    sourceSha256: '694f0b6cb50b4e5dc0d810a3350d3374a5601ecf38c5a37025ce1561b2a49418',
    sites: ['BITRATES_KBPS[bitrateIndex]', 'SAMPLE_RATES_HZ[sampleRateIndex]'],
  },
  'src/mp3/id3.ts': {
    sourceSha256: 'f13877e703b53e693eac737adf407af71eee039155000b7bef728ec8a96fbfa1',
    sites: ['ID3V2_DEFINED_FLAGS[version]', 'ID3V2_FOOTER_SIGNATURE[index]', 'header.bytes[index]'],
  },
  'tests/count-frames.test.ts': {
    sourceSha256: '71637999be6b92f3250817f81c2b7f737a6dbb834e71e9e37de3fb64b04f7f78',
    sites: ['tag[tag.length - 10 + index]', 'tag[footerOffset]'],
  },
  'tests/frame-header.test.ts': {
    sourceSha256: '712819ce7bc135ec8293734bb048e7adc943d618fa6154bbeefd81bf801552d3',
    sites: ['bitrates[bitrateIndex]', 'rates[sampleRateIndex]'],
  },
  'tests/helpers/mp3-fixtures.ts': {
    sourceSha256: 'efbafcf1ae4dc6b90410a640498e18bc8b18ae214c924be574d5975c3c4f37f9',
    sites: ['BITRATES[bitrateIndex]', 'SAMPLE_RATES[sampleRateIndex]'],
  },
  'tests/helpers/partial-metadata-prefix-fixtures.ts': {
    sourceSha256: '9faab240a4c9789954f8ee199fa4d64c31f0d9fc37c909f2d7112a57f5c2d704',
    sites: ['header[change.at]', 'envelope[footerStart + changedAt]'],
  },
  'tests/id3.test.ts': {
    sourceSha256: '0c0bdf787ad36f46cbed1300c86881f9b472d4e1f406d411e564afa078dd39ca',
    sites: ['tag[index]'],
  },
  'tests/metadata-layouts.test.ts': {
    sourceSha256: 'a79c3e75b54fa029a0dd49ee6e2d40bc03dbae80aab0792ecc6eca0daaf54aae',
    sites: ['changed[changed.length - 10 + byte]'],
  },
  'tests/parser-boundaries.test.ts': {
    sourceSha256: 'beeff67dbc315be302d9d0f640c5bf3e0b3e77a9f529d23584ac27a64b48c7df',
    sites: ['bad[19 + index]'],
  },
  'tests/runtime-characterization.test.ts': {
    sourceSha256: '2d5536c41302440af8745a15df7c813326d39fafbe91c5e95b6b72290c715681',
    sites: ['bytes[offset + 2]'],
  },
  'tests/short-free-format.test.ts': {
    sourceSha256: '248ba7c34d0dffe83a34e591ea8be306167a4a8ca5adc50dca2b2b9d40a7e87f',
    sites: ['bytes[offset + 2]'],
  },
};

export function reviewedDataAccess(file, source) {
  const entry = reviewed[file];
  return entry?.sourceSha256 === sha256(source) ? new Set(entry.sites) : new Set();
}
