# The upload module owns the upload lifecycle

The route used to inline two upload adapters, raw and multipart, that handled media type, size limit, empty uploads and the unread remainder of a rejected upload each in their own way. We moved both into `src/upload.ts` behind one interface: the route hands it a consumer, the frame counter, and never touches request bodies. The module also registers the raw content-type parser and the multipart plugin, so every per-upload limit lives in one place.

## Decisions

- **Restructure, not a behaviour change.** Status codes and error bodies are unchanged; existing HTTP regressions cover connection handling for the exercised failures. The one widening is below.
- **The consumer is passed in.** The module feeds an upload to a caller-supplied consumer and deals with the unread remainder whenever the consumer stops early, for any reason. Previously only MPEG parse errors drained a multipart remainder; the other consumer failures happen after the upload is fully read, come from a stream the transport already ended (draining it does nothing), or are unexpected internal errors, which used to leave the connection stalled until its timeout and now drain like the rest. The module knows nothing about MP3 parsing.
- **Rejected remainders:** a raw upload's connection closes after the error response, because its remainder is attacker-sized and unbounded by any multipart limit; a multipart upload's remainder drains in the background, bounded by the multipart file limit, so its connection stays usable.
- **The parser's cleanup contract stays.** `countMp3Frames` closes its input when it fails, which is correct for any async iterable. The Busboy stall that closing causes is Node-stream knowledge, so the upload module reads files with `destroyOnReturn: false` instead of the parser changing.
- **Failures outside an upload** (an invalid query option, a body Fastify rejects before the route runs) are not the upload module's concern; the route and the error handler decide their connection disposition (refined by [ADR 0002](0002-one-pure-mapping-from-failure-to-error-response.md)).
- **One accepted media-type list** serves raw uploads and multipart file parts, as the HTTP specification already defines.

## Considered options

- **Hand the route a byte stream** and have it report parser failures back: rejected, because every caller would have to remember to report back, in order.
- **Call the frame counter inside the module:** rejected, because upload handling would then depend on MPEG parse errors to decide what to do with a remainder.
