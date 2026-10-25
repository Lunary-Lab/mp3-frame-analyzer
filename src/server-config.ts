import { MAX_UPLOAD_BYTES } from './upload.js';

/** Parse deployment configuration without accepting numeric coercions or an unlimited mode. */
export function maxUploadBytesFromEnvironment(value: string | undefined): number {
  if (value === undefined) return MAX_UPLOAD_BYTES;
  const bytes = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(
      'MAX_UPLOAD_BYTES must be a positive safe integer in decimal bytes (1 to 9007199254740991)',
    );
  }
  return bytes;
}
