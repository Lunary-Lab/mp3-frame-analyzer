import { stdin, stderr } from 'node:process';

const target = process.argv[2];
if (target !== 'raw' && target !== 'structured') {
  throw new Error('Target must be raw or structured');
}
const data = [];
let totalBytes = 0;
for await (const chunk of stdin) {
  totalBytes += chunk.length;
  if (totalBytes > 128 * 1024) throw new Error('Crash input too large for replay');
  data.push(chunk);
}
// Module loading is infrastructure setup, not an input-dependent fuzz failure.
const { fuzz } = await import(`../fuzz/${target}.fuzz.mjs`);
try {
  await fuzz(Buffer.concat(data));
} catch (error) {
  // This fixed marker is parsed by the reducer; the full stack is not needed.
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const family = message.startsWith('Chunk-boundary dependence:')
    ? 'chunk-invariance'
    : message.startsWith('Valid MPEG-1 Layer III structure:')
      ? 'incorrect-frame-count'
      : message.startsWith('Excluding the initial encoder frame:')
        ? 'incorrect-audio-frame-count'
        : message.startsWith('Impossible frame count:')
          ? 'impossible-frame-count'
          : message.slice(0, 90);
  stderr.write(`FUZZ_FAILURE ${JSON.stringify({ name, family })}\n`);
  process.exitCode = 1;
}
