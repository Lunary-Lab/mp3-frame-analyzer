# One pure mapping from failure to error response

The Fastify error handler classified failures through five mechanisms in one function (deliberate upload errors, MPEG parse errors, typed framework codes, Busboy message strings, HTTP status classes) and decided connection handling in three places, including the route. Tests could reach the classification only by throwing from a request hook. We moved the classification into `errorResponseFor` in `src/error-response.ts`: a pure function from any thrown value and the upload form to the status, JSON body, connection disposition and whether the failure is unexpected. The error handler only applies its result.

## Decisions

- **Restructure, not a behaviour change.** Every status, body and `Connection` header is unchanged; the remaining HTTP tests pass, and the upload tests only rename the error type.
- **One deliberate failure type.** `ClientError`, in its own module so dependencies run one way, replaces the upload module's `UploadError` and also serves failures outside an upload, such as an invalid query option. It carries a sanitized status, code and message.
- **The thrower states what it knows about the upload.** A `ClientError` raised before the upload is read sets `closeConnection`; the route no longer sets headers itself. Framework failures on a raw upload close the connection as before. The upload module still closes raw uploads it rejects, because consumer failures it passes through are not its own errors.
- **Client disconnects stay in the error handler.** A request whose peer has gone cannot receive any response, so there is nothing to classify.
- **Parser input faults stay parser errors.** The byte reader reports non-byte chunks and streams that stop making progress as `invalid-mp3`. The upload module only ever hands it byte chunks, so HTTP never sees these, and changing the parser would reopen its audited mutation proofs for no visible gain.
- **Tests sit at the new interface.** A table drives `errorResponseFor` through every mechanism, including branches no HTTP test reached; the request-hook test for unknown 413s is replaced by it. One HTTP test still proves the handler wiring and sanitization.
- **Every request that is not a multipart form counts as an attempted raw upload** when classifying, as before; the upload module then rejects one with an unaccepted media type.

This refines ADR 0001's note that the route and the error handler decide connection handling for failures outside an upload: the thrower and `errorResponseFor` now decide it.
