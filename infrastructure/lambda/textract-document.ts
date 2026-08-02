import {
  GetDocumentAnalysisCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentAnalysisCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
  type Query,
} from "@aws-sdk/client-textract";

export class TextractDocumentError extends Error {}

export type TextractJobStatus = "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "PARTIAL_SUCCESS";

export type StatementProvider = "amex" | "santander";

export interface TextractQueryAnswer {
  readonly alias: string;
  readonly question: string;
  readonly answer?: string;
  readonly confidence?: number;
}

export interface TextractTable {
  readonly page: number;
  readonly rows: readonly (readonly string[])[];
}

/** Normalized Textract analysis result — the only OCR contract statement mappers should use. */
export interface TextractStatementExtraction {
  readonly provider: StatementProvider;
  readonly jobId: string;
  readonly status: TextractJobStatus;
  readonly lines: readonly string[];
  readonly text: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly queryAnswers: readonly TextractQueryAnswer[];
  readonly tables: readonly TextractTable[];
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const amexQueries: readonly Query[] = [
  { Text: "What is the billing period start date?", Alias: "PERIOD_FROM" },
  { Text: "What is the billing period end date?", Alias: "PERIOD_TO" },
  { Text: "What is the full billing period text?", Alias: "PERIOD_TEXT" },
  { Text: "What are the last 4 digits of the account number?", Alias: "ACCOUNT_LAST_FOUR" },
  { Text: "What is the card product name?", Alias: "PRODUCT" },
];

const santanderQueries: readonly Query[] = [
  { Text: "What is the statement period start date?", Alias: "PERIOD_FROM" },
  { Text: "What is the statement period end date?", Alias: "PERIOD_TO" },
  { Text: "What is the full statement period text?", Alias: "PERIOD_TEXT" },
  { Text: "What are the last 4 digits of the card number?", Alias: "ACCOUNT_LAST_FOUR" },
  { Text: "What is the card product name?", Alias: "PRODUCT" },
];

export const statementQueries = (provider: StatementProvider): readonly Query[] =>
  provider === "amex" ? amexQueries : santanderQueries;

/** @deprecated Prefer startTextractDocumentAnalysis for statement imports. */
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

export const startTextractDocumentAnalysis = async (
  client: TextractClient,
  bucket: string,
  key: string,
  provider: StatementProvider,
): Promise<string> => {
  const result = await client.send(new StartDocumentAnalysisCommand({
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    FeatureTypes: ["TABLES", "QUERIES"],
    QueriesConfig: { Queries: [...statementQueries(provider)] },
  }));
  if (!result.JobId) throw new TextractDocumentError("Textract no devolvió un JobId.");
  return result.JobId;
};

export const getTextractAnalysisJobStatus = async (
  client: TextractClient,
  jobId: string,
): Promise<{ readonly status: TextractJobStatus; readonly statusMessage?: string }> => {
  const result = await client.send(new GetDocumentAnalysisCommand({ JobId: jobId, MaxResults: 1 }));
  const status = (result.JobStatus ?? "FAILED") as TextractJobStatus;
  return { status, statusMessage: result.StatusMessage };
};

/** @deprecated Prefer getTextractAnalysisJobStatus. */
export const getTextractJobStatus = async (
  client: TextractClient,
  jobId: string,
): Promise<{ readonly status: TextractJobStatus; readonly statusMessage?: string }> => {
  const result = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1 }));
  const status = (result.JobStatus ?? "FAILED") as TextractJobStatus;
  return { status, statusMessage: result.StatusMessage };
};

const collectAnalysisBlocks = async (client: TextractClient, jobId: string): Promise<readonly Block[]> => {
  const blocks: Block[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetDocumentAnalysisCommand({
      JobId: jobId,
      MaxResults: 1000,
      NextToken: nextToken,
    }));
    blocks.push(...(page.Blocks ?? []));
    nextToken = page.NextToken;
  } while (nextToken);
  return blocks;
};

export const textractLinesToText = (blocks: readonly Block[]): string =>
  blocks
    .filter((block) => block.BlockType === "LINE" && block.Text)
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

const blockText = (block: Block | undefined, byId: ReadonlyMap<string, Block>): string => {
  if (!block) return "";
  if (block.Text) return block.Text.trim();
  const childIds = block.Relationships?.find((relation) => relation.Type === "CHILD")?.Ids ?? [];
  return childIds
    .map((id) => byId.get(id))
    .filter((child): child is Block => Boolean(child && (child.BlockType === "WORD" || child.BlockType === "LINE")))
    .map((child) => child.Text?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
};

const extractQueryAnswers = (blocks: readonly Block[]): readonly TextractQueryAnswer[] => {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [block.Id!, block]));
  const answers: TextractQueryAnswer[] = [];
  for (const block of blocks) {
    if (block.BlockType !== "QUERY") continue;
    const alias = block.Query?.Alias ?? "";
    const question = block.Query?.Text ?? "";
    const resultIds = block.Relationships?.find((relation) => relation.Type === "ANSWER")?.Ids ?? [];
    const resultBlock = resultIds.map((id) => byId.get(id)).find((candidate) => candidate?.BlockType === "QUERY_RESULT");
    const answer = resultBlock?.Text?.trim();
    answers.push({
      alias,
      question,
      answer: answer || undefined,
      confidence: resultBlock?.Confidence,
    });
  }
  return answers;
};

const extractTables = (blocks: readonly Block[]): readonly TextractTable[] => {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [block.Id!, block]));
  const tables: TextractTable[] = [];
  for (const table of blocks.filter((block) => block.BlockType === "TABLE")) {
    const cellIds = table.Relationships?.find((relation) => relation.Type === "CHILD")?.Ids ?? [];
    const cells = cellIds
      .map((id) => byId.get(id))
      .filter((block): block is Block => block?.BlockType === "CELL");
    let maxRow = 0;
    let maxCol = 0;
    for (const cell of cells) {
      maxRow = Math.max(maxRow, cell.RowIndex ?? 0);
      maxCol = Math.max(maxCol, cell.ColumnIndex ?? 0);
    }
    if (maxRow === 0 || maxCol === 0) continue;
    const grid: string[][] = Array.from({ length: maxRow }, () => Array.from({ length: maxCol }, () => ""));
    for (const cell of cells) {
      const row = (cell.RowIndex ?? 1) - 1;
      const col = (cell.ColumnIndex ?? 1) - 1;
      if (row < 0 || col < 0) continue;
      grid[row][col] = blockText(cell, byId);
    }
    tables.push({ page: table.Page ?? 1, rows: grid });
  }
  return tables;
};

export const normalizeTextractAnalysis = (
  provider: StatementProvider,
  jobId: string,
  status: TextractJobStatus,
  blocks: readonly Block[],
): TextractStatementExtraction => {
  const lineBlocks = blocks.filter((block) => block.BlockType === "LINE" && block.Text);
  const text = textractLinesToText(lineBlocks);
  const queryAnswers = extractQueryAnswers(blocks);
  const answers: Record<string, string> = {};
  for (const item of queryAnswers) {
    if (item.alias && item.answer) answers[item.alias] = item.answer;
  }
  return {
    provider,
    jobId,
    status,
    lines: text.split("\n").filter(Boolean),
    text,
    answers,
    queryAnswers,
    tables: extractTables(blocks),
  };
};

export const fetchTextractStatementExtraction = async (
  client: TextractClient,
  jobId: string,
  provider: StatementProvider,
): Promise<TextractStatementExtraction> => {
  const status = await getTextractAnalysisJobStatus(client, jobId);
  if (status.status === "IN_PROGRESS") {
    throw new TextractDocumentError("Textract sigue procesando el documento.");
  }
  if (status.status === "FAILED") {
    throw new TextractDocumentError(status.statusMessage ?? "Textract falló al leer el PDF.");
  }
  const blocks = await collectAnalysisBlocks(client, jobId);
  const extraction = normalizeTextractAnalysis(provider, jobId, status.status, blocks);
  if (!extraction.text.trim() && Object.keys(extraction.answers).length === 0 && extraction.tables.length === 0) {
    throw new TextractDocumentError("Textract no encontró contenido útil en el PDF.");
  }
  return extraction;
};

/** @deprecated Prefer fetchTextractStatementExtraction. */
export const fetchTextractDocumentText = async (
  client: TextractClient,
  jobId: string,
): Promise<string> => {
  // Legacy text-detection jobs still use GetDocumentTextDetection.
  const status = await getTextractJobStatus(client, jobId);
  if (status.status === "IN_PROGRESS") {
    throw new TextractDocumentError("Textract sigue procesando el documento.");
  }
  if (status.status === "FAILED") {
    throw new TextractDocumentError(status.statusMessage ?? "Textract falló al leer el PDF.");
  }
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
