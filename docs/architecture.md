# Architecture and decisions

## Boundary definition

`POST /file-upload` receives one streamed multipart file. The HTTP adapter enforces upload resource limits and maps domain errors to JSON. The parser itself knows nothing about HTTP or Fastify and accepts a standard `AsyncIterable<Uint8Array>`, so it is easy to unit-test with arbitrary chunk partitions.

## MPEG-1 Layer III frame structure

A frame begins with a 32-bit header containing eleven sync bits, MPEG version, layer, CRC protection, bitrate index, sampling-rate index, and a padding bit. Bitrate indices 1..14 map to MPEG-1 Layer III rates from 32..320 kbps; sample-rate indices 0..2 map to 44,100 / 48,000 / 32,000 Hz.

For MPEG-1 Layer III, in bytes:

```
frameLength = floor(144000 * bitrateKbps / sampleRateHz) + padding
```

Every frame is parsed individually. This supports constant and variable bitrate streams. Audio payload bytes are skipped using the computed length, so MP3-like sync markers **inside** a frame never create false frames. CRC bytes are inside the declared frame and are not interpreted separately.

## Metadata and semantics

- ID3v2 tags at the beginning are detected through `ID3` and skipped by their **28-bit synchsafe size** (plus a 10-byte footer when present in v2.4). Tag contents and album art are never accumulated into a whole-tag buffer.
- ID3v1 at the end is recognized by the `TAG` prefix and excluded from the count (the trailing tag must be exactly 128 bytes).
- The returned count includes all physically present MPEG-1 Layer III frames, including metadata-bearing Xing/Info/VBRI frames. The count is obtained by traversal, not copied from any encoder metadata. Decoder tools may report one fewer _decoded audio_ frame than physical frame count.
- The stream must start at a frame or an ID3v2 tag; arbitrary leading garbage is not scanned away. Invalid bytes at expected frame boundaries are rejected rather than silently resynchronized.
- A truncated final frame, leftover partial header, or unrecognized trailing metadata is rejected.

This is intentionally a **structural parser**, not an MP3 decoder. Full validation would additionally examine side information, bit reservoir usage, Huffman data, optional CRC, appended APEv2 tags, and MPEG variants beyond the stated assessment scope.

## Resource model

The byte cursor queues incoming stream chunks only as required to read a four-byte header or ten-byte metadata header, then consumes frame/tag bytes incrementally. The cursor does not ask for more than 1,500 bytes of lookahead (actual parser maximum: 10). Time is linear in bytes consumed; memory is proportional to the largest chunk delivered by the upstream stream, **not** the total upload size.

Fastify's multipart implementation provides stream backpressure, a 50 MiB per-file cap, one file / one part limit, and dedicated error handling. Parsing terminates immediately on invalid headers. Request timeouts defend against slow or abandoned clients.

## Why no MPEG parser package or FFmpeg dependency?

The assignment explicitly requires deriving frame counts by parsing the MP3, without relying on an npm package that already performs frame parsing. The domain parser uses only TypeScript/standard Uint8Array operations. FFmpeg is used **only** to generate reproducible real-audio fixtures and independently compare results during development.

## References

- [MPEG frame header structure (MP3 frame reference)](https://www.mp3-tech.org/programmer/frame_header.html)
- [ID3v2.4 specification](https://id3.org/id3v2.4.0-structure)
- [Fastify multipart stream API](https://github.com/fastify/fastify-multipart)
