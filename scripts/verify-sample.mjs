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
  // Match the HTTP default explicitly; the low-level parser defaults to physical frames.
  const frameCount = await countMp3Frames(createReadStream(path, { highWaterMark: 4096 }), {
    includeVbrHeaderFrame: false,
  });
  const physicalFrameCount = await countMp3Frames(createReadStream(path, { highWaterMark: 4096 }), {
    includeVbrHeaderFrame: true,
  });
  if (frameCount !== 6089)
    throw new Error(`Expected 6089 frames excluding metadata, got ${frameCount}`);
  if (physicalFrameCount !== 6090) {
    throw new Error(`Expected 6090 physical frames, got ${physicalFrameCount}`);
  }
  console.log(
    JSON.stringify({ frameCount, physicalFrameCount, bytes: bytes.length, sha256: digest }),
  );
}
