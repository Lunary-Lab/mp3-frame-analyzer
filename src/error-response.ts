import { ClientError } from './client-error.js';
import { Mp3ParseError } from './mp3/errors.js';
import type { UploadForm } from './upload.js';

export interface ErrorResponse {
  readonly status: number;
  readonly body: { readonly error: string; readonly message: string };
  /**
   * Close the connection after responding, because the upload may still have
   * an unread remainder. The upload module closes raw uploads it rejects on
   * its own, whatever this says.
   */
  readonly closeConnection: boolean;
  /** An internal failure: log it, and never show its details to the client. */
  readonly unexpected: boolean;
}

/**
 * Match the actual typed Fastify 5 / @fastify/multipart 10.1.6 errors, not just
 * their numeric HTTP status. These four multipart limit errors use 413, but only one
 * actually means that the uploaded file's bytes exceeded the size limit.
 */
const frameworkClientErrors = new Map<string, readonly [number, string, string]>([
  ['FST_REQ_FILE_TOO_LARGE', [413, 'file-too-large', 'MP3 file exceeds the upload limit']],
  ['FST_FILES_LIMIT', [413, 'too-many-files', 'Only one file part is allowed']],
  ['FST_FIELDS_LIMIT', [413, 'unexpected-fields', 'Multipart text fields are not allowed']],
  ['FST_PARTS_LIMIT', [413, 'too-many-parts', 'Only one multipart part is allowed']],
  ['FST_MP_PREMATURE_CLOSE', [400, 'invalid-upload', 'Multipart request ended early']],
  ['FST_PROTO_VIOLATION', [400, 'invalid-upload', 'Invalid multipart field name']],
  ['FST_INVALID_JSON_FIELD_ERROR', [400, 'invalid-upload', 'Invalid multipart field']],
  ['FST_INVALID_MULTIPART_CONTENT_TYPE', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_EMPTY_JSON_BODY', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_JSON_BODY', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', [400, 'invalid-request', 'Invalid Content-Length']],
  ['FST_ERR_CTP_BODY_TOO_LARGE', [413, 'request-too-large', 'Request body exceeds the limit']],
]);

// Busboy currently reports these protocol failures without a typed statusCode.
// Keep this list specific so unrelated application errors still become HTTP 500.
const multipartParseErrors = new Set([
  'Multipart: Boundary not found',
  'Unexpected end of multipart data',
  'Unexpected end of form',
  'Part terminated early due to unexpected end of multipart data',
  'Preamble terminated early due to unexpected end of multipart data',
]);

/**
 * Turn anything the route throws into the response the client receives.
 *
 * A ClientError keeps its status, code and message, and an MPEG parse error
 * maps by kind. Framework failures are matched by their typed code first,
 * then, on a multipart upload, by a form that ended early (a known Busboy
 * message or a stream that closed before the form ended), then by their HTTP
 * status class, and always get a sanitized message. Everything else is an
 * unexpected internal failure.
 */
export function errorResponseFor(error: unknown, form: UploadForm): ErrorResponse {
  return (
    fromClientError(error) ??
    fromParseError(error) ??
    fromFrameworkCode(error, form) ??
    fromMultipartProtocol(error, form) ??
    fromClientStatus(error, form) ??
    internalFailure
  );
}

function fromClientError(error: unknown): ErrorResponse | undefined {
  if (!(error instanceof ClientError)) return undefined;
  const { closeConnection } = error;
  return errorResponse(error.status, error.code, error.message, { closeConnection });
}

function fromParseError(error: unknown): ErrorResponse | undefined {
  if (!(error instanceof Mp3ParseError)) return undefined;
  return errorResponse(error.kind === 'unsupported-format' ? 415 : 422, error.kind, error.message);
}

function fromFrameworkCode(error: unknown, form: UploadForm): ErrorResponse | undefined {
  const frameworkCode = propertyOf(error, 'code');
  const mapped =
    typeof frameworkCode === 'string' ? frameworkClientErrors.get(frameworkCode) : undefined;
  if (mapped === undefined) return undefined;
  const [status, code, message] = mapped;
  return errorResponse(status, code, message, afterFrameworkFailure(form));
}

function fromMultipartProtocol(error: unknown, form: UploadForm): ErrorResponse | undefined {
  if (form !== 'multipart' || !(error instanceof Error)) return undefined;
  // When the end of a cut-off form reaches Busboy in the same burst as the
  // upload, its reader can see Node's premature-close error instead of a
  // Busboy message. The HTTP handler filters aborted requests or destroyed responses.
  const streamClosedEarly = propertyOf(error, 'code') === 'ERR_STREAM_PREMATURE_CLOSE';
  if (!streamClosedEarly && !multipartParseErrors.has(error.message)) return undefined;
  return errorResponse(400, 'invalid-upload', 'Invalid or incomplete multipart request');
}

/**
 * Unknown framework errors keep their HTTP category but never expose
 * potentially unsafe original messages or masquerade as multipart errors.
 */
function fromClientStatus(error: unknown, form: UploadForm): ErrorResponse | undefined {
  const status = propertyOf(error, 'statusCode');
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status >= 500)
    return undefined;
  if (status === 413) {
    return errorResponse(
      413,
      'request-too-large',
      'Request exceeds configured limits',
      afterFrameworkFailure(form),
    );
  }
  if (status === 415) {
    return errorResponse(
      415,
      'unsupported-media-type',
      'Expected an MP3 upload',
      afterFrameworkFailure(form),
    );
  }
  return errorResponse(
    status,
    'invalid-request',
    'Invalid HTTP request',
    afterFrameworkFailure(form),
  );
}

/**
 * A framework failure can leave a raw upload's remainder unread. Multipart
 * reuse is conditional on body completion; the upload guard independently
 * closes that connection if the aggregate body budget is exceeded.
 */
function afterFrameworkFailure(form: UploadForm): { closeConnection: boolean } {
  return { closeConnection: form === 'raw' };
}

const internalFailure: ErrorResponse = {
  ...errorResponse(500, 'internal-error', 'Unable to process upload'),
  unexpected: true,
};

function errorResponse(
  status: number,
  code: string,
  message: string,
  { closeConnection = false }: { closeConnection?: boolean } = {},
): ErrorResponse {
  return { status, body: { error: code, message }, closeConnection, unexpected: false };
}

function propertyOf(error: unknown, key: 'code' | 'statusCode'): unknown {
  return error instanceof Error && key in error
    ? (error as unknown as Record<string, unknown>)[key]
    : undefined;
}
