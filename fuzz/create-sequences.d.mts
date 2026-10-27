export interface SequenceFixture {
  bytes: Buffer;
  configurations: { rate: number; free: boolean; kbps: number; count: number }[];
  frameOffsets: number[];
  frameLengths: number[];
  alternative?: number[];
  expectation: { kind: 'structural' | 'ambiguous' } | { kind: 'count'; count: number };
}
export function createSequenceMp3(input: Uint8Array): SequenceFixture;
