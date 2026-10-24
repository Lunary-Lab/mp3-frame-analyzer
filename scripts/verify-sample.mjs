import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { countMp3Frames } from '../dist/mp3/count-frames.js';

// Assessment audio stays outside Git; verify identity before asserting an oracle.
const path = process.argv[2] ?? process.env['ASSESSMENT_SAMPLE_PATH'];
if (!path) {
  console.error('Usage: npm run verify:sample -- /path/to/assessment_sample.mp3');
  process.exitCode = 2;
} else {
  const bytes = await readFile(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== '97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3') {
    throw new Error('Sample SHA-256 does not match the assessment sample');
  }
  const frameCount = await countMp3Frames(createReadStream(path, { highWaterMark: 4096 }));
  if (frameCount !== 6090) throw new Error(`Expected 6090 frames, got ${frameCount}`);
  console.log(JSON.stringify({ frameCount, bytes: bytes.length, sha256: digest }));
}
