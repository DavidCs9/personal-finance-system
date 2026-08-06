import {
  HttpStatusCodes,
  Router,
} from '@aws-lambda-powertools/event-handler/http';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import {
  deleteCard,
  InvalidCardError,
  isValidCardId,
  listCards,
  parseCardInput,
  saveCard,
  toPublicCard,
} from '../cards/cards.js';
import { InvalidManualEntryError } from '../events/manual-entry-input.js';
import { createManualEvent } from '../events/manual-entry.js';
import { getEventDetail, listEventsForMonth, readRawEmail } from '../events/queries.js';
import { InvalidMsiError, patchEvent } from '../events/mutations.js';
import { discardException, listExceptions, readExceptionRawEmail, requestRetry } from '../exceptions/service.js';
import { applySantanderImport, previewSantanderImport } from '../imports/santander-csv-flow.js';
import {
  applyAmexImport,
  getAmexImport,
  previewAmexImport,
} from '../imports/amex-statement-flow.js';
import {
  applySantanderStatementImport,
  getSantanderStatementImport,
  previewSantanderStatementImport,
} from '../imports/santander-statement-flow.js';
import { InvalidSantanderCsvError } from '../imports/santander-csv.js';
import { InvalidSantanderStatementError } from '../imports/santander-statement.js';
import { InvalidAmexStatementError } from '../imports/amex-statement.js';
import { TextractDocumentError } from '../imports/textract-document.js';
import { InvalidMonthlyPlanError, isValidMonth, parseMonthlyPlan } from '../months/monthly-plan.js';
import { getMonthlyPlan, saveMonthlyPlan } from '../months/service.js';
import { InvalidWealthSnapshotError } from '../wealth/input.js';
import {
  assertCajitaAccountParam,
  createCajitaSnapshot,
  getWealthOverview,
} from '../wealth/service.js';
import { syncBitsoForOwner } from '../wealth/bitso-sync.js';
import {
  deletePushSubscription,
  InvalidPushSubscriptionError,
  listOwnerPushSubscriptions,
  parsePushSubscriptionInput,
  savePushSubscription,
} from '@finance/notify';
import { database, tableName } from './clients.js';
import { errorMessage, principal, requestBody } from './response.js';

const app = new Router();

const json = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

const ownerOf = (event: APIGatewayProxyEventV2): string => principal(event);

const asHttpEvent = (event: unknown): APIGatewayProxyEventV2 => event as APIGatewayProxyEventV2;

const clientErrors = [
  InvalidMonthlyPlanError,
  InvalidSantanderCsvError,
  InvalidSantanderStatementError,
  InvalidAmexStatementError,
  TextractDocumentError,
  InvalidPushSubscriptionError,
  InvalidManualEntryError,
  InvalidMsiError,
  InvalidCardError,
  InvalidWealthSnapshotError,
] as const;

app.errorHandler([...clientErrors], async (error) =>
  json(HttpStatusCodes.BAD_REQUEST, { message: error.message }),
);

app.notFound(async () =>
  json(HttpStatusCodes.NOT_FOUND, { message: 'Route not found.' }),
);

app.methodNotAllowed(async () =>
  json(HttpStatusCodes.METHOD_NOT_ALLOWED, { message: 'Method not allowed.' }),
);

app.errorHandler(Error, async (error) => {
  console.error('API request failed', { message: errorMessage(error) });
  return json(HttpStatusCodes.INTERNAL_SERVER_ERROR, { message: 'Unable to complete this request.' });
});

app.get('/cards', async ({ event }) => {
  const cards = await listCards({
    database,
    tableName,
    owner: ownerOf(asHttpEvent(event)),
  });
  return json(HttpStatusCodes.OK, { cards: cards.map(toPublicCard) });
});

app.put('/cards/:cardId', async ({ event, params }) => {
  const cardId = params.cardId;
  if (!isValidCardId(cardId)) return json(HttpStatusCodes.BAD_REQUEST, { message: 'cardId is invalid.' });
  const input = parseCardInput(requestBody(asHttpEvent(event)));
  const saved = await saveCard({
    database,
    tableName,
    owner: ownerOf(asHttpEvent(event)),
    cardId,
    body: input,
  });
  return json(HttpStatusCodes.OK, toPublicCard(saved));
});

app.delete('/cards/:cardId', async ({ event, params }) => {
  const cardId = params.cardId;
  if (!isValidCardId(cardId)) return json(HttpStatusCodes.BAD_REQUEST, { message: 'cardId is invalid.' });
  await deleteCard({
    database,
    tableName,
    owner: ownerOf(asHttpEvent(event)),
    cardId,
  });
  return json(HttpStatusCodes.OK, { deleted: true });
});

app.get('/push/subscriptions', async ({ event }) => {
  const subscriptions = await listOwnerPushSubscriptions({
    database,
    tableName,
    owner: ownerOf(asHttpEvent(event)),
  });
  return json(HttpStatusCodes.OK, {
    subscriptions: subscriptions.map((subscription) => ({
      subscriptionId: subscription.subscriptionId,
      contentMode: subscription.contentMode,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    })),
  });
});

app.put('/push/subscriptions/:subscriptionId', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  const input = parsePushSubscriptionInput(requestBody(gatewayEvent), params.subscriptionId);
  const saved = await savePushSubscription({
    database,
    tableName,
    owner: ownerOf(gatewayEvent),
    endpoint: input.endpoint,
    keys: input.keys,
    contentMode: input.contentMode,
  });
  return json(HttpStatusCodes.OK, {
    subscriptionId: saved.subscriptionId,
    contentMode: saved.contentMode,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  });
});

app.delete('/push/subscriptions/:subscriptionId', async ({ event, params }) => {
  await deletePushSubscription({
    database,
    tableName,
    owner: ownerOf(asHttpEvent(event)),
    subscriptionId: params.subscriptionId.toLowerCase(),
  });
  return json(HttpStatusCodes.OK, { deleted: true });
});

app.post('/events/manual', async ({ event }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(HttpStatusCodes.CREATED, await createManualEvent(requestBody(gatewayEvent), ownerOf(gatewayEvent)));
});

app.get('/events', async ({ event }) => {
  const month = (asHttpEvent(event)).queryStringParameters?.month;
  if (!month || !isValidMonth(month)) {
    return json(HttpStatusCodes.BAD_REQUEST, { message: 'Query parameter month (YYYY-MM) is required.' });
  }
  return json(HttpStatusCodes.OK, await listEventsForMonth(month));
});

app.get('/events/:eventId/raw', async ({ params }) =>
  json(HttpStatusCodes.OK, { rawEmail: await readRawEmail(params.eventId) }),
);

app.get('/events/:eventId', async ({ params }) => {
  const detail = await getEventDetail(params.eventId);
  return detail
    ? json(HttpStatusCodes.OK, detail)
    : json(HttpStatusCodes.NOT_FOUND, { message: 'Event not found.' });
});

app.patch('/events/:eventId', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  const updated = await patchEvent(params.eventId, ownerOf(gatewayEvent), requestBody(gatewayEvent));
  return updated
    ? json(HttpStatusCodes.OK, updated)
    : json(HttpStatusCodes.NOT_FOUND, { message: 'Event not found.' });
});

app.get('/exceptions', async () =>
  json(HttpStatusCodes.OK, { exceptions: await listExceptions() }),
);

app.get('/exceptions/:exceptionId/raw', async ({ params }) =>
  json(HttpStatusCodes.OK, { rawEmail: await readExceptionRawEmail(params.exceptionId) }),
);

app.post('/exceptions/:exceptionId/retry', async ({ event, params }) =>
  json(HttpStatusCodes.ACCEPTED, await requestRetry(params.exceptionId, ownerOf(asHttpEvent(event)))),
);

app.delete('/exceptions/:exceptionId', async ({ event, params }) =>
  json(HttpStatusCodes.OK, await discardException(params.exceptionId, ownerOf(asHttpEvent(event)))),
);

app.get('/months/:month', async ({ event, params }) => {
  if (!isValidMonth(params.month)) {
    return json(HttpStatusCodes.BAD_REQUEST, { message: 'Month must use YYYY-MM format.' });
  }
  return json(HttpStatusCodes.OK, await getMonthlyPlan(ownerOf(asHttpEvent(event)), params.month));
});

app.put('/months/:month', async ({ event, params }) => {
  if (!isValidMonth(params.month)) {
    return json(HttpStatusCodes.BAD_REQUEST, { message: 'Month must use YYYY-MM format.' });
  }
  const gatewayEvent = asHttpEvent(event);
  const input = parseMonthlyPlan(requestBody(gatewayEvent));
  return json(HttpStatusCodes.OK, await saveMonthlyPlan(ownerOf(gatewayEvent), params.month, input));
});

app.get('/wealth', async ({ event }) =>
  json(HttpStatusCodes.OK, await getWealthOverview(ownerOf(asHttpEvent(event)))),
);

app.post('/wealth/accounts/:accountId/snapshots', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  assertCajitaAccountParam(params.accountId);
  return json(
    HttpStatusCodes.CREATED,
    await createCajitaSnapshot(requestBody(gatewayEvent), ownerOf(gatewayEvent)),
  );
});

app.post('/wealth/sync/bitso', async ({ event }) =>
  json(HttpStatusCodes.OK, await syncBitsoForOwner(ownerOf(asHttpEvent(event)))),
);

app.post('/imports/santander/preview', async ({ event }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(HttpStatusCodes.OK, await previewSantanderImport(requestBody(gatewayEvent), ownerOf(gatewayEvent)));
});

app.post('/imports/santander/:importId/apply', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(
    HttpStatusCodes.OK,
    await applySantanderImport(params.importId, ownerOf(gatewayEvent), requestBody(gatewayEvent)),
  );
});

app.post('/imports/santander-statement/preview', async ({ event }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(HttpStatusCodes.OK, await previewSantanderStatementImport(gatewayEvent, ownerOf(gatewayEvent)));
});

app.get('/imports/santander-statement/:importId', async ({ event, params }) =>
  json(HttpStatusCodes.OK, await getSantanderStatementImport(params.importId, ownerOf(asHttpEvent(event)))),
);

app.post('/imports/santander-statement/:importId/apply', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(
    HttpStatusCodes.OK,
    await applySantanderStatementImport(params.importId, ownerOf(gatewayEvent), requestBody(gatewayEvent)),
  );
});

app.post('/imports/amex/preview', async ({ event }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(HttpStatusCodes.OK, await previewAmexImport(gatewayEvent, ownerOf(gatewayEvent)));
});

app.get('/imports/amex/:importId', async ({ event, params }) =>
  json(HttpStatusCodes.OK, await getAmexImport(params.importId, ownerOf(asHttpEvent(event)))),
);

app.post('/imports/amex/:importId/apply', async ({ event, params }) => {
  const gatewayEvent = asHttpEvent(event);
  return json(
    HttpStatusCodes.OK,
    await applyAmexImport(params.importId, ownerOf(gatewayEvent), requestBody(gatewayEvent)),
  );
});

export const handler = async (event: APIGatewayProxyEventV2, context: Context) =>
  app.resolve(event, context);
