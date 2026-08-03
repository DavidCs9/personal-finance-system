import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

export type JsonObject = Record<string, unknown>;

export const principal = (event: Parameters<APIGatewayProxyHandlerV2>[0]): string => {
  const context = event.requestContext as typeof event.requestContext & { authorizer?: { jwt?: { claims?: { sub?: string } } } };
  const subject = context.authorizer?.jwt?.claims?.sub;
  if (!subject) throw new Error('Missing authenticated principal.');
  return subject;
};

export const requestBody = (event: Parameters<APIGatewayProxyHandlerV2>[0]): string | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
};

export const response = (statusCode: number, body: JsonObject) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

export const errorName = (error: unknown): string | undefined => error && typeof error === 'object' && 'name' in error ? String(error.name) : undefined;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';
