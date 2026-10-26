import { DEFAULT_MAX_ACTIVE_UPLOADS, MAX_ACTIVE_UPLOADS_LIMIT } from './upload-admission.js';
import { defaultMaxMultipartBytes, MAX_UPLOAD_BYTES } from './upload.js';

/** Parse deployment configuration without numeric coercions or an unlimited mode. */
function byteLimit(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const bytes = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(
      `${name} must be a positive safe integer in decimal bytes (1 to 9007199254740991)`,
    );
  }
  return bytes;
}

export function maxUploadBytesFromEnvironment(value: string | undefined): number {
  return byteLimit(value, MAX_UPLOAD_BYTES, 'MAX_UPLOAD_BYTES');
}

export function maxMultipartBytesFromEnvironment(
  value: string | undefined,
  maxUploadBytes: number,
): number {
  return byteLimit(value, defaultMaxMultipartBytes(maxUploadBytes), 'MAX_MULTIPART_BYTES');
}

/** Admission has no unlimited mode and no pending request queue. */
export function maxActiveUploadsFromEnvironment(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ACTIVE_UPLOADS;
  const maximum = Number(value);
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_ACTIVE_UPLOADS_LIMIT
  ) {
    throw new Error('MAX_ACTIVE_UPLOADS must be an integer between 1 and 1024');
  }
  return maximum;
}
