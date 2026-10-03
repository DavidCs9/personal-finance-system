import { assertMutationsAvailable } from '@finance/ledger/dsql-store';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { monthKeyInZone, previousCalendarMonth } from '@finance/domain';
import { getMonthlyEmailDelivery, prepareMonthlyEmailDelivery, markMonthlyEmailAccepted } from './delivery-store.js';
import type { NativeMonthlyDelivery } from '@finance/ledger/native-deliveries';
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
  readonly getRecord: (owner: string, month: string) => Promise<NativeMonthlyDelivery | undefined>;
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

const getRecord = (owner:string,month:string) => getMonthlyEmailDelivery(owner,'monthly_close',month);
const prepare = (owner:string,month:string,prepared:PreparedMonthlyClose,now:Date):Promise<void> =>
  prepareMonthlyEmailDelivery({kind:'monthly_close',owner,month,preparedAt:now.toISOString(),email:prepared.email,
    report:{facts:prepared.facts as unknown as Record<string,unknown>,analysis:prepared.analysis as unknown as Record<string,unknown>,
      analysisVersion:MONTHLY_CLOSE_ANALYSIS_VERSION,analysisSource:prepared.analysisSource,
      ...(prepared.analysisErrorName===undefined?{}:{analysisErrorName:prepared.analysisErrorName})}});
const markSent = (owner:string,month:string,messageId:string,now:Date):Promise<void> =>
  markMonthlyEmailAccepted({owner,kind:'monthly_close',month,messageId,sentAt:now.toISOString()});

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

const preparedFromRecord = (record:NativeMonthlyDelivery|undefined):PreparedMonthlyClose|undefined => {
  if(record?.kind!=='monthly_close'||record.status!=='prepared')return undefined;
  return {facts:record.report.facts as unknown as MonthlyCloseFacts,analysis:record.report.analysis as unknown as MonthlyCloseAnalysis,
    analysisSource:record.report.analysisSource,...(record.report.analysisErrorName===undefined?{}:{analysisErrorName:record.report.analysisErrorName}),email:record.email};
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
  await assertMutationsAvailable();
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
