/**
 * ID3 author-spec fixtures, independent of the production tag skipper.
 * These records carry real title/RBUF/SEEK content; a footer never follows padding.
 * Sources: ID3v2.2/2.3 §3.1 and §4.19; ID3v2.4 Structure §§3–5 and Frames §§4.18,4.29.
 */
export type Id3Version = 2 | 3 | 4;

function size28(value: number): Buffer {
  return Buffer.from([value >>> 21, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
}

function record(version: Id3Version, id: string, data: Buffer, unsync = false): Buffer {
  const header = Buffer.alloc(version === 2 ? 6 : 10);
  header.write(id, 0, 'ascii');
  if (version === 2) header.writeUIntBE(data.length, 3, 3);
  else if (version === 3) header.writeUInt32BE(data.length, 4);
  else {
    header.set(size28(data.length), 4);
    if (unsync) header[9] = 2;
  }
  return Buffer.concat([header, data]);
}

function extendedHeader(version: Id3Version, padding: number, update: boolean): Buffer {
  if (version === 3) {
    const bytes = Buffer.alloc(10);
    bytes.writeUInt32BE(6);
    bytes.writeUInt32BE(padding, 6);
    return bytes;
  }
  return update ? Buffer.from([0, 0, 0, 7, 1, 0x40, 0]) : Buffer.from([0, 0, 0, 6, 1, 0]);
}

interface MetadataOptions {
  footer?: boolean;
  unsync?: boolean;
  extended?: boolean;
  experimental?: boolean;
  update?: boolean;
  padding?: number;
  embedded?: boolean;
  seek?: number;
}

function metadataRecords(version: Id3Version, options: MetadataOptions, unsync: boolean): Buffer[] {
  const records = [record(version, version === 2 ? 'TT2' : 'TIT2', Buffer.from([0, 65]), unsync)];
  if (options.embedded) {
    // Recommended buffer: embedded-info flag=1; no optional offset field.
    records.push(
      record(version, version === 2 ? 'BUF' : 'RBUF', Buffer.from([0, 1, 0, 1]), unsync),
    );
  }
  if (options.seek !== undefined) {
    if (version !== 4) throw new Error('SEEK requires ID3v2.4');
    const offset = Buffer.alloc(4);
    offset.writeUInt32BE(options.seek);
    records.push(record(version, 'SEEK', offset, unsync));
  }
  return records;
}

export function metadataTag(version: Id3Version, options: MetadataOptions = {}): Buffer {
  const { footer, unsync, extended, experimental } = {
    footer: false,
    unsync: false,
    extended: false,
    experimental: false,
    ...options,
  };
  if ((footer && version !== 4) || (extended && version === 2)) throw new Error('Invalid fixture');
  const records = metadataRecords(version, options, unsync);
  const padding = options.padding ?? 0;
  if (footer && padding !== 0) throw new Error('Footer and padding are mutually exclusive');
  const extension = extended
    ? extendedHeader(version, padding, options.update ?? false)
    : Buffer.alloc(0);
  const body = Buffer.concat([extension, ...records, Buffer.alloc(padding)]);
  const flags =
    (unsync ? 0x80 : 0) | (extended ? 0x40 : 0) | (experimental ? 0x20 : 0) | (footer ? 0x10 : 0);
  const header = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, 0, flags]),
    size28(body.length),
  ]);
  if (!footer) return Buffer.concat([header, body]);
  const end = Buffer.from(header);
  end.set([0x33, 0x44, 0x49]);
  return Buffer.concat([header, body, end]);
}

export function metadataV1(track?: number): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'ascii');
  tag.write('Boundary fixture', 3, 'ascii');
  tag.write('2026', 93, 'ascii');
  if (track !== undefined) tag[126] = track;
  return tag;
}
