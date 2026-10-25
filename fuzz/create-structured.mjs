/**
 * Independent construction oracle for MPEG-1 Layer III byte streams.
 * The parser under test is never consulted when deriving the frame count.
 * Input bytes control indexed/free-format bitrate, frame count, sample rate,
 * padding, CRC, channel mode, payload and optional ID3/Xing/Info/VBRI metadata,
 * including CRC-shifted placements and decoy signatures in later frames.
 * These are known-boundary structural fixtures, not encoded audio: side
 * information, the bit reservoir, compressed samples and CRC are not validated.
 */
const BITRATE_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SAMPLE_RATE_HZ = [44_100, 48_000, 32_000];
const FREE_BITRATE_KBPS = [8, 32, 128, 137, 256, 320, 384, 400, 500, 640];

function synchsafe(value) {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function id3(body, version, footer) {
  const flags = version === 4 && footer ? 0x10 : 0;
  const header = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, 0, flags]),
    synchsafe(body.length),
  ]);
  if (!flags) return Buffer.concat([header, body]);
  const tail = Buffer.from(header);
  tail.set([0x33, 0x44, 0x49], 0);
  return Buffer.concat([header, body, tail]);
}

/**
 * Write encoder metadata of `kind` (0 Xing, 1 Info, 2 VBRI) into a frame and
 * report whether it forms an encoder frame under the documented placement
 * rules: Xing/Info at byte 21 in mono or 36 otherwise, or two bytes later
 * after a CRC; VBRI at byte 36. `shifted` writes Xing/Info two bytes later,
 * which is payload, not metadata, in a frame without a CRC.
 */
function writeEncoderMetadata(frame, { channelMode, hasCrc, kind, count, shifted }) {
  // Make the optional metadata policy independent of chance payload signatures.
  for (const offset of [21, 23, 36, 38]) {
    if (offset < frame.length) frame.fill(0, offset, Math.min(offset + 4, frame.length));
  }
  if (kind === undefined) return false;
  if (kind < 2) return writeXingMetadata(frame, { channelMode, hasCrc, kind, count, shifted });
  if (frame.length < 64) return false;
  frame.write('VBRI', 36, 'ascii');
  frame.fill(0, 40, 64);
  frame.writeUInt16BE(1, 40); // Version.
  frame.writeUInt32BE(count + 123, 50);
  frame.writeUInt16BE(1, 54); // One table entry.
  frame.writeUInt16BE(1, 56); // Scale.
  frame.writeUInt16BE(2, 58); // Two bytes per entry.
  frame.writeUInt16BE(count, 60);
  return true;
}

function writeXingMetadata(frame, { channelMode, hasCrc, kind, count, shifted }) {
  const offset = (channelMode === 3 ? 21 : 36) + (shifted ? 2 : 0);
  if (offset + 12 > frame.length) return false;
  frame.write(kind === 0 ? 'Xing' : 'Info', offset, 'ascii');
  frame.writeUInt32BE(1, offset + 4);
  // Deliberately disagree with the real count: metadata is never the oracle.
  frame.writeUInt32BE(count + 123, offset + 8);
  return !shifted || hasCrc;
}

function constructionParameters(at, flags) {
  const freeFormat = Boolean(flags & 8);
  // Bit 6 of byte 2 enables short free-format construction. Payload masking
  // below excludes competing sync/tag anchors: the count oracle is unambiguous.
  const minimumFrames = freeFormat && (at(2) & 64) === 0 ? 3 : 1;
  const frameCount = minimumFrames + (at(0) % 24);
  const freeSampleRateIndex = at(5) % 3;
  const freeBaseLength = Math.floor(
    (144000 * FREE_BITRATE_KBPS[at(4) % FREE_BITRATE_KBPS.length]) /
      SAMPLE_RATE_HZ[freeSampleRateIndex],
  );
  const metadataKind = flags & 16 ? at(6) % 3 : undefined;
  const metadataShifted = Boolean(at(6) & 4);
  // A valid signature in a later frame is ordinary payload and stays counted.
  const decoyFrame = flags & 32 && frameCount > 1 ? 1 + (at(7) % (frameCount - 1)) : undefined;
  return {
    freeFormat,
    frameCount,
    freeSampleRateIndex,
    freeBaseLength,
    metadataKind,
    metadataShifted,
    decoyFrame,
  };
}

function leadingTags(at, flags) {
  const intro = [];
  if ((flags & 1) !== 0) {
    const numberOfTags = 1 + (at(2) % 3);
    for (let tag = 0; tag < numberOfTags; tag++) {
      const length = at(3 + tag) % 48;
      const body = Buffer.alloc(length);
      for (let j = 0; j < length; j++) body[j] = at(5 + tag + j);
      const version = 2 + (at(8 + tag) % 3);
      intro.push(id3(body, version, Boolean(flags & 2)));
    }
  }
  return intro;
}

function createFrame(at, i, { freeFormat, freeSampleRateIndex, freeBaseLength }) {
  const bits = at(9 + 5 * i);
  const bitrateIndex = freeFormat ? 0 : 1 + (bits % 14);
  const sampleRateIndex = freeFormat ? freeSampleRateIndex : at(10 + 5 * i) % 3;
  const padding = at(11 + 5 * i) & 1;
  const hasCrc = Boolean(at(12 + 5 * i) & 1);
  const bitrate = BITRATE_KBPS[bitrateIndex];
  const sampleRate = SAMPLE_RATE_HZ[sampleRateIndex];
  const length =
    (freeFormat ? freeBaseLength : Math.floor((144000 * bitrate) / sampleRate)) + padding;
  const block = Buffer.alloc(length);
  // The smallest free-format spans have room for mono side information only.
  const channelMode = length < 38 ? 3 : at(14 + 5 * i) % 4;
  const emphasis = [0, 1, 3][at(13 + 5 * i) % 3];
  const header =
    ((0x7ff << 21) |
      (3 << 19) |
      (1 << 17) |
      ((hasCrc ? 0 : 1) << 16) |
      (bitrateIndex << 12) |
      (sampleRateIndex << 10) |
      (padding << 9) |
      (channelMode << 6) |
      emphasis) >>>
    0;
  for (let j = 0; j < length; j++) {
    // Exclude sync bytes and ASCII ID3/TAG from free-format payloads. Competing
    // patterns belong in a separate raw/ambiguity corpus, not this count oracle.
    block[j] = at(i * 7 + j + 16) & (freeFormat ? 0x3f : 0xff);
  }
  block.writeUInt32BE(header, 0);
  return { block, channelMode, hasCrc };
}

/** Complete title records supply new placement cases without empty-tag assumptions. */
function titleTag(version, footer = false) {
  return id3(
    version === 2
      ? Buffer.from([84, 84, 50, 0, 0, 2, 0, 65])
      : Buffer.from([84, 73, 84, 50, 0, 0, 0, 2, 0, 0, 0, 65]),
    version,
    footer,
  );
}

function trailingTags(at, flags) {
  const tail = [];
  if ((flags & 128) !== 0) {
    for (let i = 0; i < 1 + (at(3) % 3); i++) tail.push(titleTag(4, true));
  }
  if ((flags & 4) !== 0) {
    const id3v1 = Buffer.alloc(128, 0);
    id3v1.write('TAG', 0, 'ascii');
    tail.push(id3v1);
  }
  return tail;
}

export function createStructuredMp3(input) {
  const data = Buffer.from(input);
  const at = (index) => (data.length ? data[index % data.length] : 0);
  const frames = [];
  const flags = at(1);
  const parameters = constructionParameters(at, flags);
  const { frameCount, metadataKind, metadataShifted, decoyFrame } = parameters;
  const intro = leadingTags(at, flags);
  const frameOffsets = [];
  const frameLengths = [];
  let offset = intro.reduce((total, tag) => total + tag.length, 0);
  let metadataFrameCount = 0;
  for (let i = 0; i < frameCount; i++) {
    if (i > 0 && (flags & 64) !== 0) {
      const tag = titleTag(2 + (at(i + 8) % 3));
      frames.push(tag);
      offset += tag.length;
    }
    const { block, channelMode, hasCrc } = createFrame(at, i, parameters);
    if (i === 0) {
      const metadata = { channelMode, hasCrc, kind: metadataKind, shifted: metadataShifted };
      if (writeEncoderMetadata(block, { ...metadata, count: frameCount })) metadataFrameCount = 1;
    } else if (i === decoyFrame) {
      writeEncoderMetadata(block, { channelMode, hasCrc, kind: at(7) % 3, count: frameCount });
    }
    frames.push(block);
    frameOffsets.push(offset);
    frameLengths.push(block.length);
    offset += block.length;
  }
  return {
    bytes: Buffer.concat([...intro, ...frames, ...trailingTags(at, flags)]),
    expectedCount: frameCount,
    expectedAudioFrameCount: frameCount - metadataFrameCount,
    metadataFrameCount,
    frameOffsets,
    frameLengths,
  };
}
