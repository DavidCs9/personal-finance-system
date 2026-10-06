/** Statement originals travel directly to S3, outside Lambda's request payload. */
export const MAX_STATEMENT_PDF_BYTES = 50 * 1024 * 1024;

export interface StatementUploadInput {
  readonly sha256: string;
  readonly size: number;
}

export interface StatementUploadTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}
