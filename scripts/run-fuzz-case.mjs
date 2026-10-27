import { stdin, stderr } from 'node:process';

const target = process.argv[2];
if (!['raw', 'structured', 'sequences'].includes(target)) {
  throw new Error('Target must be raw, structured or sequences');
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
  const families = [
    ['Chunk-boundary dependence:', 'chunk-invariance'],
    ['Valid MPEG-1 Layer III structure:', 'incorrect-frame-count'],
    ['Excluding the initial encoder frame:', 'incorrect-audio-frame-count'],
    ['Impossible frame count:', 'impossible-frame-count'],
    ['Sequence count ', 'incorrect-sequence-count'],
    ['Expected explicit sequence ambiguity:', 'missing-sequence-ambiguity'],
    ['Impossible sequence count:', 'impossible-sequence-count'],
  ];
  const family =
    families.find(([prefix]) => message.startsWith(prefix))?.[1] ?? message.slice(0, 90);
  stderr.write(`FUZZ_FAILURE ${JSON.stringify({ name, family })}\n`);
  process.exitCode = 1;
}
