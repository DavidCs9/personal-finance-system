import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

/** Authenticated API placeholder until the domain/API implementation is added. */
export const handler: APIGatewayProxyHandlerV2 = async () => ({
  statusCode: 501,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'API implementation pending' }),
});
