/** Errors caused by the uploaded byte stream, not by the HTTP transport. */
export type Mp3ErrorKind = 'invalid-mp3' | 'unsupported-format' | 'truncated-mp3';

export class Mp3ParseError extends Error {
  readonly kind: Mp3ErrorKind;
  readonly offset: number;

  constructor(kind: Mp3ErrorKind, offset: number, message: string) {
    super(message);
    this.name = 'Mp3ParseError';
    this.kind = kind;
    this.offset = offset;
  }
}
