import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
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
import {
  deletePushSubscription,
  InvalidPushSubscriptionError,
  listOwnerPushSubscriptions,
  parsePushSubscriptionInput,
  savePushSubscription,
} from '@finance/notify';
import { database, tableName } from './clients.js';
import { errorMessage, principal, requestBody, response } from './response.js';

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/cards') {
      const cards = await listCards({
        database,
        tableName,
        owner: principal(event),
      });
      return response(200, { cards: cards.map(toPublicCard) });
    }
    const cardId = event.pathParameters?.cardId;
    if (cardId && event.rawPath.startsWith('/cards/')) {
      const owner = principal(event);
      if (!isValidCardId(cardId)) return response(400, { message: 'cardId is invalid.' });
      if (event.requestContext.http.method === 'PUT') {
        const input = parseCardInput(requestBody(event));
        const saved = await saveCard({
          database,
          tableName,
          owner,
          cardId,
          body: input,
        });
        return response(200, toPublicCard(saved));
      }
      if (event.requestContext.http.method === 'DELETE') {
        await deleteCard({
          database,
          tableName,
          owner,
          cardId,
        });
        return response(200, { deleted: true });
      }
      return response(405, { message: 'Method not allowed.' });
    }
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/push/subscriptions') {
      const subscriptions = await listOwnerPushSubscriptions({
        database,
        tableName,
        owner: principal(event),
      });
      return response(200, {
        subscriptions: subscriptions.map((subscription) => ({
          subscriptionId: subscription.subscriptionId,
          contentMode: subscription.contentMode,
          createdAt: subscription.createdAt,
          updatedAt: subscription.updatedAt,
        })),
      });
    }
    const pushSubscriptionId = event.pathParameters?.subscriptionId;
    if (pushSubscriptionId && event.rawPath.startsWith('/push/subscriptions/')) {
      const owner = principal(event);
      if (event.requestContext.http.method === 'PUT') {
        const input = parsePushSubscriptionInput(requestBody(event), pushSubscriptionId);
        const saved = await savePushSubscription({
          database,
          tableName,
          owner,
          endpoint: input.endpoint,
          keys: input.keys,
          contentMode: input.contentMode,
        });
        return response(200, {
          subscriptionId: saved.subscriptionId,
          contentMode: saved.contentMode,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        });
      }
      if (event.requestContext.http.method === 'DELETE') {
        await deletePushSubscription({
          database,
          tableName,
          owner,
          subscriptionId: pushSubscriptionId.toLowerCase(),
        });
        return response(200, { deleted: true });
      }
      return response(405, { message: 'Method not allowed.' });
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/events/manual') {
      return response(201, await createManualEvent(requestBody(event), principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/santander/preview') {
      return response(200, await previewSantanderImport(requestBody(event), principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/santander-statement/preview') {
      return response(200, await previewSantanderStatementImport(event, principal(event)));
    }
    if (event.requestContext.http.method === 'POST' && event.rawPath === '/imports/amex/preview') {
      return response(200, await previewAmexImport(event, principal(event)));
    }
    const importId = event.pathParameters?.importId;
    if (importId && event.rawPath.includes('/imports/santander-statement/')) {
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getSantanderStatementImport(importId, principal(event)));
      }
      if (event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
        return response(200, await applySantanderStatementImport(importId, principal(event), requestBody(event)));
      }
    }
    if (importId && event.rawPath.includes('/imports/amex/')) {
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getAmexImport(importId, principal(event)));
      }
      if (event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
        return response(200, await applyAmexImport(importId, principal(event), requestBody(event)));
      }
    }
    if (importId && event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/apply')) {
      return response(200, await applySantanderImport(importId, principal(event), requestBody(event)));
    }
    const month = event.pathParameters?.month;
    if (month !== undefined) {
      if (!isValidMonth(month)) return response(400, { message: 'Month must use YYYY-MM format.' });
      const owner = principal(event);
      if (event.requestContext.http.method === 'GET') {
        return response(200, await getMonthlyPlan(owner, month));
      }
      if (event.requestContext.http.method === 'PUT') {
        const input = parseMonthlyPlan(requestBody(event));
        return response(200, await saveMonthlyPlan(owner, month, input));
      }
      return response(405, { message: 'Method not allowed.' });
    }
    const eventId = event.pathParameters?.eventId;
    const exceptionId = event.pathParameters?.exceptionId;
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/events') {
      const month = event.queryStringParameters?.month;
      if (!month || !isValidMonth(month)) {
        return response(400, { message: 'Query parameter month (YYYY-MM) is required.' });
      }
      return response(200, await listEventsForMonth(month));
    }
    if (event.requestContext.http.method === 'GET' && event.rawPath === '/exceptions') {
      return response(200, { exceptions: await listExceptions() });
    }
    if (exceptionId && event.requestContext.http.method === 'POST' && event.rawPath.endsWith('/retry')) {
      return response(202, await requestRetry(exceptionId, principal(event)));
    }
    if (exceptionId && event.requestContext.http.method === 'GET' && event.rawPath.endsWith('/raw')) {
      return response(200, { rawEmail: await readExceptionRawEmail(exceptionId) });
    }
    if (exceptionId && event.requestContext.http.method === 'DELETE') {
      return response(200, await discardException(exceptionId, principal(event)));
    }
    if (!eventId) return response(404, { message: 'Route not found.' });
    if (event.requestContext.http.method === 'GET' && event.rawPath.endsWith('/raw')) {
      return response(200, { rawEmail: await readRawEmail(eventId) });
    }
    if (event.requestContext.http.method === 'GET') {
      const detail = await getEventDetail(eventId);
      return detail ? response(200, detail) : response(404, { message: 'Event not found.' });
    }
    if (event.requestContext.http.method === 'PATCH') {
      const updated = await patchEvent(eventId, principal(event), requestBody(event));
      return updated ? response(200, updated) : response(404, { message: 'Event not found.' });
    }
    return response(405, { message: 'Method not allowed.' });
  } catch (error) {
    if (
      error instanceof InvalidMonthlyPlanError
      || error instanceof InvalidSantanderCsvError
      || error instanceof InvalidSantanderStatementError
      || error instanceof InvalidAmexStatementError
      || error instanceof TextractDocumentError
      || error instanceof InvalidPushSubscriptionError
      || error instanceof InvalidManualEntryError
      || error instanceof InvalidMsiError
      || error instanceof InvalidCardError
    ) {
      return response(400, { message: error.message });
    }
    console.error('API request failed', { message: errorMessage(error) });
    return response(500, { message: 'Unable to complete this request.' });
  }
};
