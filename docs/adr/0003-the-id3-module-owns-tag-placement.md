# The ID3 module owns tag placement

`src/mp3/id3.ts` used to be three signature predicates and a header decoder, while the rules about where tags may appear lived in `count-frames.ts`: the eight-tag limit, leading versus trailing placement passed as a string, footer verification, the 128-byte ID3v1 skip and the rule that nothing follows trailing metadata. We moved those rules into the ID3 module, which now skips leading tags and trailing metadata against the byte reader; frame traversal only asks whether trailing metadata starts at a frame boundary.

## Decisions

- **Restructure, not a behaviour change.** Every count, error kind, offset and message through `countMp3Frames` is unchanged.
- **The interface is three operations:** skip leading tags, recognize the start of trailing metadata, skip trailing metadata to the end of the stream. Header decoding, signatures and footers are internal.
- **Unreachable checks go.** The header decoder's own "Incomplete ID3v2 header" error could never fire, because the reader confirms ten bytes first with a different message; the signature predicates' length guards were redundant for the same reason. The unused `totalLength` field goes too.
- **Placement is a code path, not a string.** An appended ID3v2 tag in trailing metadata must have a footer, checked in the trailing path itself, which removes the equivalent mutant that existed only because placement was a string argument.
- **Tests go through `countMp3Frames`.** Header validation is asserted with exact kinds, offsets and messages at the parser's interface; the direct header-decoder tests are gone.
