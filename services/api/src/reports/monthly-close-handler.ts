import { createHash } from 'node:crypto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { monthKeyInZone, previousCalendarMonth } from '@finance/domain';
import { database, tableName } from '../http/clients.js';
import {
  analyzeMonthlyClose,
  fallbackMonthlyCloseAnalysis,
  MONTHLY_CLOSE_ANALYSIS_VERSION,
  type MonthlyCloseAnalysis,
} from './monthly-close-analysis.js';
import { renderMonthlyCloseEmail, type MonthlyCloseEmail } from './monthly-close-email.js';
import { buildMonthlyCloseFacts, type MonthlyCloseFacts } from './monthly-close.js';

const ses = new SESClient({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });

type AnalysisSource = 'bedrock' | 'fallback';

export interface PreparedMonthlyClose {
  readonly facts: MonthlyCloseFacts;
  readonly analysis: MonthlyCloseAnalysis;
  readonly analysisSource: AnalysisSource;
  readonly analysisErrorName?: string;
  readonly email: MonthlyCloseEmail;
}

export interface MonthlyCloseDependencies {
  readonly getRecord: (owner: string, month: string) => Promise<Record<string, unknown> | undefined>;
  readonly prepare: (
    owner: string,
    month: string,
    prepared: PreparedMonthlyClose,
    now: Date,
  ) => Promise<void>;
  readonly markSent: (
    owner: string,
    month: string,
    messageId: string,
    now: Date,
  ) => Promise<void>;
  readonly buildFacts: (owner: string, month: string, now: Date) => Promise<MonthlyCloseFacts>;
  readonly analyze: (facts: MonthlyCloseFacts) => Promise<MonthlyCloseAnalysis>;
  readonly send: (email: MonthlyCloseEmail) => Promise<string>;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const reportKey = (owner: string, month: string) => ({
  PK: `USER#${owner}`,
  SK: `MONTHLY_CLOSE#${month}`,
});

const getRecord = async (owner: string, month: string): Promise<Record<string, unknown> | undefined> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: reportKey(owner, month),
    ConsistentRead: true,
  }));
  return result.Item as Record<string, unknown> | undefined;
};

const prepare = async (
  owner: string,
  month: string,
  prepared: PreparedMonthlyClose,
  now: Date,
): Promise<void> => {
  const contentSha256 = createHash('sha256')
    .update(prepared.email.subject)
    .update('\0')
    .update(prepared.email.html)
    .update('\0')
    .update(prepared.email.text)
    .digest('hex');
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...reportKey(owner, month),
      entityType: 'monthly_close_report',
      owner,
      month,
      status: 'prepared',
      preparedAt: now.toISOString(),
      facts: prepared.facts,
      analysis: prepared.analysis,
      analysisVersion: MONTHLY_CLOSE_ANALYSIS_VERSION,
      analysisSource: prepared.analysisSource,
      ...(prepared.analysisErrorName ? { analysisErrorName: prepared.analysisErrorName } : {}),
      email: prepared.email,
      contentSha256,
    },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
};

const markSent = async (
  owner: string,
  month: string,
  messageId: string,
  now: Date,
): Promise<void> => {
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: reportKey(owner, month),
    UpdateExpression: 'SET #status = :sent, sentAt = :sentAt, sesMessageId = :messageId',
    ConditionExpression: '#status = :prepared',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':sent': 'sent',
      ':prepared': 'prepared',
      ':sentAt': now.toISOString(),
      ':messageId': messageId,
    },
  }));
};

const send = async (email: MonthlyCloseEmail): Promise<string> => {
  const response = await ses.send(new SendEmailCommand({
    Source: requiredEnvironment('ALERT_SENDER_EMAIL'),
    Destination: { ToAddresses: [requiredEnvironment('ALERT_RECIPIENT_EMAIL')] },
    Message: {
      Subject: { Charset: 'UTF-8', Data: email.subject },
      Body: {
        Html: { Charset: 'UTF-8', Data: email.html },
        Text: { Charset: 'UTF-8', Data: email.text },
      },
    },
    Tags: [
      { Name: 'feature', Value: 'monthly-close' },
    ],
  }));
  if (!response.MessageId) throw new Error('SES returned no MessageId for monthly close email.');
  return response.MessageId;
};

const defaultDependencies: MonthlyCloseDependencies = {
  getRecord,
  prepare,
  markSent,
  buildFacts: buildMonthlyCloseFacts,
  analyze: analyzeMonthlyClose,
  send,
};

const preparedFromRecord = (record: Record<string, unknown> | undefined): PreparedMonthlyClose | undefined => {
  if (record?.status !== 'prepared') return undefined;
  const email = record.email;
  const facts = record.facts;
  const analysis = record.analysis;
  if (!email || typeof email !== 'object' || Array.isArray(email)) return undefined;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return undefined;
  const emailRecord = email as Record<string, unknown>;
  if (typeof emailRecord.subject !== 'string' || typeof emailRecord.html !== 'string' || typeof emailRecord.text !== 'string') {
    return undefined;
  }
  return {
    facts: facts as unknown as MonthlyCloseFacts,
    analysis: analysis as unknown as MonthlyCloseAnalysis,
    analysisSource: record.analysisSource === 'bedrock' ? 'bedrock' : 'fallback',
    ...(typeof record.analysisErrorName === 'string' ? { analysisErrorName: record.analysisErrorName } : {}),
    email: { subject: emailRecord.subject, html: emailRecord.html, text: emailRecord.text },
  };
};

const errorName = (error: unknown): string => error instanceof Error ? error.name : 'UnknownError';

export const runMonthlyClose = async (
  now: Date = new Date(),
  dependencies: MonthlyCloseDependencies = defaultDependencies,
): Promise<{
  readonly month: string;
  readonly status: 'sent' | 'already_sent';
  readonly messageId?: string;
  readonly analysisSource?: AnalysisSource;
}> => {
  const owner = requiredEnvironment('MONTHLY_CLOSE_OWNER');
  const currentMonth = monthKeyInZone(now);
  const month = previousCalendarMonth(currentMonth);
  if (!month) throw new Error(`Cannot derive monthly close before ${currentMonth}.`);
  let record = await dependencies.getRecord(owner, month);
  if (record?.status === 'sent') {
    console.info(JSON.stringify({ message: 'Monthly close already sent', month }));
    return { month, status: 'already_sent' };
  }

  let prepared = preparedFromRecord(record);
  if (!prepared) {
    const facts = await dependencies.buildFacts(owner, month, now);
    let analysis: MonthlyCloseAnalysis;
    let analysisSource: AnalysisSource = 'bedrock';
    let analysisErrorName: string | undefined;
    try {
      analysis = await dependencies.analyze(facts);
    } catch (error) {
      analysis = fallbackMonthlyCloseAnalysis(facts);
      analysisSource = 'fallback';
      analysisErrorName = errorName(error);
      console.warn(JSON.stringify({ message: 'Monthly close AI analysis fell back', month, errorName: analysisErrorName }));
    }
    prepared = {
      facts,
      analysis,
      analysisSource,
      ...(analysisErrorName ? { analysisErrorName } : {}),
      email: renderMonthlyCloseEmail(facts, analysis, requiredEnvironment('WEB_APP_URL')),
    };
    try {
      await dependencies.prepare(owner, month, prepared, now);
    } catch (error) {
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
      record = await dependencies.getRecord(owner, month);
      if (record?.status === 'sent') return { month, status: 'already_sent' };
      prepared = preparedFromRecord(record);
      if (!prepared) throw new Error('Monthly close preparation raced without a reusable report.');
    }
  }

  const messageId = await dependencies.send(prepared.email);
  await dependencies.markSent(owner, month, messageId, now);
  console.info(JSON.stringify({
    message: 'Monthly close sent',
    month,
    analysisSource: prepared.analysisSource,
    messageId,
  }));
  return { month, status: 'sent', messageId, analysisSource: prepared.analysisSource };
};

export const handler = async (): Promise<Awaited<ReturnType<typeof runMonthlyClose>>> => runMonthlyClose();
