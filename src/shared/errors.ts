export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}
