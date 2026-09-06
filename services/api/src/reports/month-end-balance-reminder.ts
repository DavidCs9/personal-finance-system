import { createHash } from 'node:crypto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dayKeyInZone, formatMxnWhole, monthKeyInZone } from '@finance/domain';
import { database, tableName } from '../http/clients.js';
import { getWealthOverview, type WealthBalanceOverview } from '../wealth/service.js';

const ses = new SESClient({ region: process.env.AWS_REGION, maxAttempts: 5, retryMode: 'adaptive' });

export interface MonthEndBalanceReminderEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface PreparedMonthEndBalanceReminder {
  readonly asOfDay: string;
  readonly email: MonthEndBalanceReminderEmail;
}

export interface MonthEndBalanceReminderDependencies {
  readonly getRecord: (owner: string, month: string) => Promise<Record<string, unknown> | undefined>;
  readonly prepare: (
    owner: string,
    month: string,
    prepared: PreparedMonthEndBalanceReminder,
    now: Date,
  ) => Promise<void>;
  readonly markSent: (owner: string, month: string, messageId: string, now: Date) => Promise<void>;
  readonly loadOverview: (owner: string, now: Date) => Promise<WealthBalanceOverview>;
  readonly send: (email: MonthEndBalanceReminderEmail) => Promise<string>;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const reminderKey = (owner: string, month: string) => ({
  PK: `USER#${owner}`,
  SK: `MONTH_END_BALANCE_REMINDER#${month}`,
});

const html = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const monthLabel = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  const label = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const shortMonthLabel = (month: string): string => monthLabel(month).split(' de ')[0] ?? month;

const formatDay = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
};

const reminderRow = (input: {
  readonly label: string;
  readonly amountMinor: number | null;
  readonly status: string;
  readonly ready: boolean;
}): string => `<tr>
  <td width="14" valign="top" style="padding:16px 0;border-bottom:1px solid #d7cfc1;"><span style="display:block;width:7px;height:7px;margin-top:5px;border-radius:50%;background:${input.ready ? '#52604a' : '#9c332d'};"></span></td>
  <td style="padding:14px 8px 14px 7px;border-bottom:1px solid #d7cfc1;color:#25251f;font:13px/1.35 Arial,sans-serif;">${html(input.label)}<br><span style="color:#756e62;font-size:11px;">${html(input.status)}</span></td>
  <td style="padding:14px 0;border-bottom:1px solid #d7cfc1;color:#1d1e1b;font:bold 13px/1.35 Arial,sans-serif;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${input.amountMinor === null ? '—' : html(formatMxnWhole(input.amountMinor))}</td>
</tr>`;

export const renderMonthEndBalanceReminder = (
  overview: WealthBalanceOverview,
  month: string,
  asOfDay: string,
  webAppUrl: string,
): MonthEndBalanceReminderEmail => {
  const manualAccounts = overview.accounts.filter((account) => account.sync === 'manual');
  const automaticAccounts = overview.accounts.filter((account) => account.sync !== 'manual');
  const manualRows = [
    ...manualAccounts.map((account) => {
      const snapshot = account.latestSnapshot;
      const ready = snapshot?.day === asOfDay;
      return reminderRow({
        label: account.name,
        amountMinor: snapshot?.totalMxnMinor ?? null,
        status: ready
          ? 'Capturado hoy'
          : snapshot ? `Actualiza hoy · última captura ${formatDay(snapshot.day)}` : 'Sin captura · agrégala hoy',
        ready,
      });
    }),
    ...overview.liabilities.map((liability) => {
      const snapshot = liability.latestSnapshot;
      const ready = snapshot?.day === asOfDay;
      return reminderRow({
        label: liability.name,
        amountMinor: snapshot?.totalMxnMinor ?? null,
        status: ready
          ? 'Saldo pendiente capturado hoy'
          : snapshot ? `Actualiza hoy · última captura ${formatDay(snapshot.day)}` : 'Sin captura · agrega el saldo pendiente total',
        ready,
      });
    }),
  ];
  const automaticRows = automaticAccounts.map((account) => {
    const snapshot = account.latestSnapshot;
    const isDerived = account.sync === 'derived';
    const ready = snapshot?.day === asOfDay;
    return reminderRow({
      label: account.name,
      amountMinor: snapshot?.totalMxnMinor ?? null,
      status: isDerived
        ? 'Derivado de las nóminas cargadas'
        : ready ? 'Automático · actualizado hoy'
          : snapshot ? `Automático sin actualizar hoy · último dato ${formatDay(snapshot.day)}` : 'Automático · sin datos disponibles',
      ready,
    });
  });
  const safeUrl = html(webAppUrl.endsWith('/') ? webAppUrl : `${webAppUrl}/`);
  const reportLabel = monthLabel(month).replace(/ de /g, ' ');
  const closeDayLabel = formatDay(asOfDay);
  const subject = `Cierra tus saldos de ${shortMonthLabel(month)} · Olbia`;
  const emailHtml = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(subject)}</title>
<style>@media only screen and (max-width:620px){.olbia-wrap{width:100%!important}.olbia-pad{padding-left:20px!important;padding-right:20px!important}.olbia-title{font-size:34px!important}}</style></head>
<body style="margin:0;padding:0;background:#eee8dd;color:#25251f;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Actualiza Cajita y cada tarjeta hoy para cerrar ${html(reportLabel)} con cifras correctas.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#eee8dd;"><tr><td align="center" style="padding:24px 10px;">
<table class="olbia-wrap" role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:620px;max-width:100%;border-collapse:separate;border-spacing:0;background:#f4efe5;border:1px solid #d7cfc1;border-radius:18px;overflow:hidden;">
<tr><td class="olbia-pad" style="padding:32px 36px 28px;">
  <table role="presentation" width="100%"><tr><td style="color:#1d1e1b;font:22px/1 Georgia,serif;letter-spacing:.07em;">OLBIA</td><td align="right" style="color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;">Precierre</td></tr></table>
  <p style="margin:32px 0 10px;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">${html(reportLabel)}</p>
  <h1 class="olbia-title" style="margin:0 0 16px;color:#1d1e1b;font:normal 44px/1.06 Georgia,serif;letter-spacing:-.025em;">Hoy cierra el mes</h1>
  <p style="margin:0;color:#4d4a42;font:15px/1.62 Arial,sans-serif;">Actualiza Cajita y el saldo pendiente total de cada tarjeta antes de terminar hoy. El cierre de mañana usará la última captura disponible al ${html(closeDayLabel)}.</p>
</td></tr>
<tr><td class="olbia-pad" style="padding:28px 36px;border-top:1px solid #d7cfc1;">
  <p style="margin:0;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Captura hoy</p>
  <h2 style="margin:4px 0 18px;color:#1d1e1b;font:normal 28px/1.1 Georgia,serif;">Saldos manuales</h2>
  ${manualRows.length > 0 ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">${manualRows.join('')}</table>` : '<p style="margin:0;color:#756e62;font:13px/1.5 Arial,sans-serif;">No hay saldos manuales configurados.</p>'}
  <p style="margin:12px 0 0;color:#756e62;font:11px/1.55 Arial,sans-serif;">En tarjetas captura todo lo que debes hoy, incluyendo compras a meses sin intereses.</p>
</td></tr>
<tr><td class="olbia-pad" style="padding:28px 36px;border-top:1px solid #d7cfc1;">
  <p style="margin:0;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Sin captura manual</p>
  <h2 style="margin:4px 0 18px;color:#1d1e1b;font:normal 28px/1.1 Georgia,serif;">Derivados y automáticos</h2>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">${automaticRows.join('')}</table>
</td></tr>
<tr><td class="olbia-pad" style="padding:28px 36px 34px;border-top:1px solid #d7cfc1;">
  <a href="${safeUrl}" style="display:block;padding:16px 22px;border-radius:10px;background:#1d1e1b;color:#fbf8f1;font:bold 13px/1.3 Arial,sans-serif;letter-spacing:.02em;text-align:center;text-decoration:none;">Abrir Olbia</a>
  <p style="margin:12px 0 0;color:#756e62;font:10px/1.55 Arial,sans-serif;text-align:center;">Entra a Patrimonio para registrar los saldos manuales.</p>
</td></tr>
<tr><td class="olbia-pad" style="padding:23px 36px;background:#e7dfd2;border-top:1px solid #d7cfc1;color:#756e62;font:10px/1.5 Arial,sans-serif;">Olbia · Precierre de Patrimonio<br>${html(closeDayLabel)} · America/Chihuahua</td></tr>
</table></td></tr></table></body></html>`;

  const manualTextRows = [
    ...manualAccounts.map((account) => {
      const snapshot = account.latestSnapshot;
      const status = snapshot?.day === asOfDay
        ? 'capturado hoy'
        : snapshot ? `actualiza hoy; última captura ${formatDay(snapshot.day)}` : 'sin captura; agrégala hoy';
      return `- ${account.name}: ${snapshot ? formatMxnWhole(snapshot.totalMxnMinor) : 'Sin captura'} · ${status}`;
    }),
    ...overview.liabilities.map((liability) => {
      const snapshot = liability.latestSnapshot;
      const status = snapshot?.day === asOfDay
        ? 'capturado hoy'
        : snapshot ? `actualiza hoy; última captura ${formatDay(snapshot.day)}` : 'sin captura; agrega el saldo pendiente total';
      return `- ${liability.name}: ${snapshot ? formatMxnWhole(snapshot.totalMxnMinor) : 'Sin captura'} · ${status}`;
    }),
  ];
  const automaticTextRows = automaticAccounts.map((account) => {
    const snapshot = account.latestSnapshot;
    const ready = snapshot?.day === asOfDay;
    const status = account.sync === 'derived'
      ? 'derivado de las nóminas cargadas'
      : ready ? 'automático; actualizado hoy'
        : snapshot ? `automático sin actualizar hoy; último dato ${formatDay(snapshot.day)}` : 'automático; sin datos disponibles';
    return `- ${account.name}: ${snapshot ? formatMxnWhole(snapshot.totalMxnMinor) : 'Sin datos'} · ${status}`;
  });
  const emailText = [
    `OLBIA · PRECIERRE · ${reportLabel.toUpperCase()}`,
    '',
    'HOY CIERRA EL MES',
    `Actualiza Cajita y el saldo pendiente total de cada tarjeta antes de terminar hoy. El cierre de mañana usará la última captura disponible al ${closeDayLabel}.`,
    '',
    'SALDOS MANUALES',
    ...(manualTextRows.length > 0 ? manualTextRows : ['- No hay saldos manuales configurados.']),
    'En tarjetas captura todo lo que debes hoy, incluyendo compras a meses sin intereses.',
    '',
    'DERIVADOS Y AUTOMÁTICOS',
    ...automaticTextRows,
    '',
    `Abrir Olbia y entrar a Patrimonio: ${webAppUrl}`,
    `${closeDayLabel} · America/Chihuahua`,
  ].join('\n');
  return { subject, html: emailHtml, text: emailText };
};

const getRecord = async (owner: string, month: string): Promise<Record<string, unknown> | undefined> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: reminderKey(owner, month),
    ConsistentRead: true,
  }));
  return result.Item as Record<string, unknown> | undefined;
};

const prepare = async (
  owner: string,
  month: string,
  prepared: PreparedMonthEndBalanceReminder,
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
      ...reminderKey(owner, month),
      entityType: 'month_end_balance_reminder',
      owner,
      month,
      asOfDay: prepared.asOfDay,
      status: 'prepared',
      preparedAt: now.toISOString(),
      email: prepared.email,
      contentSha256,
    },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
};

const markSent = async (owner: string, month: string, messageId: string, now: Date): Promise<void> => {
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: reminderKey(owner, month),
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

const send = async (email: MonthEndBalanceReminderEmail): Promise<string> => {
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
    Tags: [{ Name: 'feature', Value: 'month-end-balance-reminder' }],
  }));
  if (!response.MessageId) throw new Error('SES returned no MessageId for month-end balance reminder.');
  return response.MessageId;
};

const defaultDependencies: MonthEndBalanceReminderDependencies = {
  getRecord,
  prepare,
  markSent,
  loadOverview: async (owner, now) => await getWealthOverview(owner, now) as unknown as WealthBalanceOverview,
  send,
};

const preparedFromRecord = (
  record: Record<string, unknown> | undefined,
): PreparedMonthEndBalanceReminder | undefined => {
  if (record?.status !== 'prepared' || typeof record.asOfDay !== 'string') return undefined;
  const email = record.email;
  if (!email || typeof email !== 'object' || Array.isArray(email)) return undefined;
  const emailRecord = email as Record<string, unknown>;
  if (typeof emailRecord.subject !== 'string' || typeof emailRecord.html !== 'string' || typeof emailRecord.text !== 'string') {
    return undefined;
  }
  return {
    asOfDay: record.asOfDay,
    email: { subject: emailRecord.subject, html: emailRecord.html, text: emailRecord.text },
  };
};

const errorName = (error: unknown): string => error instanceof Error ? error.name : 'UnknownError';

export const runMonthEndBalanceReminder = async (
  now: Date = new Date(),
  dependencies: MonthEndBalanceReminderDependencies = defaultDependencies,
): Promise<{ readonly month: string; readonly status: 'sent' | 'already_sent'; readonly messageId?: string }> => {
  const owner = requiredEnvironment('MONTH_END_REMINDER_OWNER');
  const month = monthKeyInZone(now);
  const asOfDay = dayKeyInZone(now);
  let record = await dependencies.getRecord(owner, month);
  if (record?.status === 'sent') {
    console.info(JSON.stringify({ message: 'Month-end balance reminder already sent', month }));
    return { month, status: 'already_sent' };
  }

  let prepared = preparedFromRecord(record);
  if (!prepared) {
    const overview = await dependencies.loadOverview(owner, now);
    prepared = {
      asOfDay,
      email: renderMonthEndBalanceReminder(overview, month, asOfDay, requiredEnvironment('WEB_APP_URL')),
    };
    try {
      await dependencies.prepare(owner, month, prepared, now);
    } catch (error) {
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
      record = await dependencies.getRecord(owner, month);
      if (record?.status === 'sent') return { month, status: 'already_sent' };
      prepared = preparedFromRecord(record);
      if (!prepared) throw new Error('Month-end reminder preparation raced without a reusable email.');
    }
  }

  const messageId = await dependencies.send(prepared.email);
  await dependencies.markSent(owner, month, messageId, now);
  console.info(JSON.stringify({ message: 'Month-end balance reminder sent', month, messageId }));
  return { month, status: 'sent', messageId };
};

export const handler = async (): Promise<Awaited<ReturnType<typeof runMonthEndBalanceReminder>>> =>
  runMonthEndBalanceReminder();
