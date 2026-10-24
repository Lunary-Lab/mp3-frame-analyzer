/** Errors caused by the uploaded byte stream, not by the HTTP transport. */
export type Mp3ErrorKind = 'invalid-mp3' | 'unsupported-format' | 'truncated-mp3';

export class Mp3ParseError extends Error {
  constructor(
    public readonly kind: Mp3ErrorKind,
    public readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = 'Mp3ParseError';
  }
}
