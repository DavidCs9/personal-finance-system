import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";

export class TextractDocumentError extends Error {}

export type TextractJobStatus = "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "PARTIAL_SUCCESS";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const startTextractTextDetection = async (
  client: TextractClient,
  bucket: string,
  key: string,
): Promise<string> => {
  const result = await client.send(new StartDocumentTextDetectionCommand({
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
  }));
  if (!result.JobId) throw new TextractDocumentError("Textract no devolvió un JobId.");
  return result.JobId;
};

export const getTextractJobStatus = async (
  client: TextractClient,
  jobId: string,
): Promise<{ readonly status: TextractJobStatus; readonly statusMessage?: string }> => {
  const result = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1 }));
  const status = (result.JobStatus ?? "FAILED") as TextractJobStatus;
  return { status, statusMessage: result.StatusMessage };
};

const collectLineBlocks = async (client: TextractClient, jobId: string): Promise<readonly Block[]> => {
  const lines: Block[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetDocumentTextDetectionCommand({
      JobId: jobId,
      MaxResults: 1000,
      NextToken: nextToken,
    }));
    for (const block of page.Blocks ?? []) {
      if (block.BlockType === "LINE" && block.Text) lines.push(block);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return lines;
};

export const textractLinesToText = (blocks: readonly Block[]): string =>
  blocks
    .slice()
    .sort((left, right) => {
      const leftPage = left.Page ?? 1;
      const rightPage = right.Page ?? 1;
      if (leftPage !== rightPage) return leftPage - rightPage;
      const leftTop = left.Geometry?.BoundingBox?.Top ?? 0;
      const rightTop = right.Geometry?.BoundingBox?.Top ?? 0;
      if (leftTop !== rightTop) return leftTop - rightTop;
      const leftLeft = left.Geometry?.BoundingBox?.Left ?? 0;
      const rightLeft = right.Geometry?.BoundingBox?.Left ?? 0;
      return leftLeft - rightLeft;
    })
    .map((block) => block.Text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");

export const fetchTextractDocumentText = async (
  client: TextractClient,
  jobId: string,
): Promise<string> => {
  const status = await getTextractJobStatus(client, jobId);
  if (status.status === "IN_PROGRESS") {
    throw new TextractDocumentError("Textract sigue procesando el documento.");
  }
  if (status.status === "FAILED") {
    throw new TextractDocumentError(status.statusMessage ?? "Textract falló al leer el PDF.");
  }
  const lines = await collectLineBlocks(client, jobId);
  const text = textractLinesToText(lines);
  if (!text.trim()) throw new TextractDocumentError("Textract no encontró texto en el PDF.");
  return text;
};

/** Poll helper for non-API Gateway contexts/tests. Prefer the two-step import status endpoint in production. */
export const waitForTextractDocumentText = async (
  client: TextractClient,
  jobId: string,
  options?: { readonly timeoutMs?: number; readonly intervalMs?: number },
): Promise<string> => {
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const intervalMs = options?.intervalMs ?? 2_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getTextractJobStatus(client, jobId);
    if (status.status === "SUCCEEDED" || status.status === "PARTIAL_SUCCESS") {
      return fetchTextractDocumentText(client, jobId);
    }
    if (status.status === "FAILED") {
      throw new TextractDocumentError(status.statusMessage ?? "Textract falló al leer el PDF.");
    }
    await sleep(intervalMs);
  }
  throw new TextractDocumentError("Textract tardó demasiado en procesar el PDF.");
};
