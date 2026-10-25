/** A failure this service raises deliberately, already sanitized for the client. */
export class ClientError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Close the connection after responding. Set it when the upload may still
   * have an unread remainder that nothing else will deal with, as when a
   * request is rejected before its upload is read at all.
   */
  readonly closeConnection: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    { closeConnection = false }: { closeConnection?: boolean } = {},
  ) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.code = code;
    this.closeConnection = closeConnection;
  }
}
