import { formatMxnWhole } from '@finance/domain';
import type { MonthlyCloseAnalysis } from './monthly-close-analysis.js';
import type {
  MonthlyCloseCategoryFact,
  MonthlyCloseFacts,
  MonthlyCloseSignal,
} from './monthly-close.js';

export interface MonthlyCloseEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

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

const compactMonthLabel = (month: string): string => monthLabel(month).replace(/ de /g, ' ');

const formatDay = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
};

const percent = (basisPoints: number): string => `${(basisPoints / 100).toLocaleString('es-MX', {
  minimumFractionDigits: basisPoints % 100 === 0 ? 0 : 1,
  maximumFractionDigits: 1,
})}%`;

const signedMoney = (amountMinor: number): string => {
  if (amountMinor === 0) return 'Sin cambio';
  return `${amountMinor > 0 ? '+' : '−'}${formatMxnWhole(Math.abs(amountMinor))}`;
};

const selectedSignals = (
  facts: MonthlyCloseFacts,
  analysis: MonthlyCloseAnalysis,
): readonly MonthlyCloseSignal[] => {
  const byId = new Map(facts.signals.map((signal) => [signal.id, signal]));
  return analysis.selectedSignalIds
    .map((id) => byId.get(id))
    .filter((signal): signal is MonthlyCloseSignal => Boolean(signal));
};

const categoryRows = (facts: MonthlyCloseFacts): readonly MonthlyCloseCategoryFact[] => {
  if (facts.spending.categories.length <= 5) return facts.spending.categories;
  const visible = facts.spending.categories.slice(0, 4);
  const remainder = facts.spending.categories.slice(4);
  const amountMinor = remainder.reduce((sum, category) => sum + category.amountMinor, 0);
  const againstAmountMinor = remainder.reduce((sum, category) => sum + category.againstAmountMinor, 0);
  const averageMinor = remainder.reduce((sum, category) => sum + category.priorThreeMonthAverageMinor, 0);
  return [...visible, {
    key: '_other',
    label: 'Otras',
    amountMinor,
    eventCount: remainder.reduce((sum, category) => sum + category.eventCount, 0),
    shareBasisPoints: facts.spending.totalSpentMinor > 0
      ? Math.round((amountMinor / facts.spending.totalSpentMinor) * 10_000)
      : 0,
    againstAmountMinor,
    deltaMinor: amountMinor - againstAmountMinor,
    priorThreeMonthAverageMinor: averageMinor,
    versusAverageMinor: amountMinor - averageMinor,
    uncertainMinor: remainder.reduce((sum, category) => sum + category.uncertainMinor, 0),
    topMerchants: [],
  }];
};

const row = (input: {
  readonly label: string;
  readonly meta?: string;
  readonly amount: string;
  readonly delta?: string;
  readonly deltaTone?: 'negative' | 'positive' | 'neutral';
}): string => {
  const deltaColor = input.deltaTone === 'negative' ? '#9c332d'
    : input.deltaTone === 'positive' ? '#52604a' : '#756e62';
  return `<tr>
    <td style="padding:14px 8px 14px 0;border-bottom:1px solid #d7cfc1;color:#25251f;font:13px/1.35 Arial,sans-serif;">${html(input.label)}${input.meta ? `<br><span style="color:#756e62;font-size:11px;">${html(input.meta)}</span>` : ''}</td>
    <td style="padding:14px 0;border-bottom:1px solid #d7cfc1;color:#1d1e1b;font:bold 13px/1.35 Arial,sans-serif;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${html(input.amount)}</td>
    ${input.delta ? `<td style="padding:14px 0 14px 12px;border-bottom:1px solid #d7cfc1;color:${deltaColor};font:11px/1.35 Arial,sans-serif;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${html(input.delta)}</td>` : ''}
  </tr>`;
};

const categoryTable = (facts: MonthlyCloseFacts): string => {
  const rows = categoryRows(facts);
  if (rows.length === 0) return '<p style="margin:0;color:#756e62;font:13px/1.5 Arial,sans-serif;">Sin gasto registrado durante el mes.</p>';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">
    ${rows.map((category) => row({
      label: category.label,
      meta: `${percent(category.shareBasisPoints)} del total · ${category.eventCount} movimientos`,
      amount: formatMxnWhole(category.amountMinor),
      delta: signedMoney(category.deltaMinor),
      deltaTone: category.deltaMinor > 0 ? 'negative' : category.deltaMinor < 0 ? 'positive' : 'neutral',
    })).join('')}
  </table>`;
};

const tagsTable = (facts: MonthlyCloseFacts): string => {
  const tags = facts.spending.tags.slice(0, 3);
  if (tags.length === 0) return '<p style="margin:0;color:#756e62;font:13px/1.5 Arial,sans-serif;">Sin tags en los movimientos de este mes.</p>';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">
    ${tags.map((tag) => row({
      label: tag.key,
      meta: `${tag.eventCount} movimientos`,
      amount: formatMxnWhole(tag.amountMinor),
    })).join('')}
  </table>
  <p style="margin:9px 0 0;color:#756e62;font:11px/1.5 Arial,sans-serif;">Los tags pueden cruzar varias categorías y superponerse; sus importes no se suman entre sí.</p>`;
};

const wealthTable = (facts: MonthlyCloseFacts): string => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">
  ${facts.wealth.accounts.map((account) => row({
    label: account.name,
    meta: account.id === 'fondo_ahorro'
      ? 'Illíquido · se entrega en diciembre'
      : account.snapshotDay ? `${percent(account.shareBasisPoints)} de activos · corte ${formatDay(account.snapshotDay)}` : 'Sin captura',
    amount: account.snapshotDay ? formatMxnWhole(account.amountMinor) : '—',
    ...(facts.wealth.comparable && account.deltaMinor !== null
      ? { delta: signedMoney(account.deltaMinor), deltaTone: 'neutral' as const }
      : {}),
  })).join('')}
</table>`;

const liabilityTable = (facts: MonthlyCloseFacts): string => {
  if (facts.wealth.liabilities.length === 0) return '';
  return `<p style="margin:26px 0 8px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.13em;text-transform:uppercase;">Debes</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">
    ${facts.wealth.liabilities.map((liability) => row({
      label: liability.name,
      meta: liability.snapshotDay ? `Corte ${formatDay(liability.snapshotDay)}` : 'Sin captura',
      amount: liability.snapshotDay ? formatMxnWhole(liability.amountMinor) : '—',
      ...(facts.wealth.comparable && liability.deltaMinor !== null
        ? { delta: signedMoney(liability.deltaMinor), deltaTone: liability.deltaMinor > 0 ? 'negative' as const : 'positive' as const }
        : {}),
    })).join('')}
  </table>`;
};

const signalsBlock = (signals: readonly MonthlyCloseSignal[]): string => {
  if (signals.length === 0) return '<p style="margin:0;color:#756e62;font:13px/1.5 Arial,sans-serif;">No hay alertas relevantes con los datos disponibles.</p>';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #d7cfc1;">
    ${signals.map((signal) => `<tr><td width="18" valign="top" style="padding:16px 0;border-bottom:1px solid #d7cfc1;"><span style="display:block;width:7px;height:7px;margin-top:5px;border-radius:50%;background:#9c332d;"></span></td><td style="padding:14px 0 14px 6px;border-bottom:1px solid #d7cfc1;color:#49463f;font:13px/1.5 Arial,sans-serif;">${html(signal.message)}</td></tr>`).join('')}
  </table>`;
};

const actionsBlock = (signals: readonly MonthlyCloseSignal[]): string => {
  const actions = [...new Set(signals.map((signal) => signal.action))].slice(0, 3);
  if (actions.length === 0) return '';
  return actions.map((action, index) => `<tr>
    <td width="42" valign="top" style="padding:7px 0 10px;color:#1d1e1b;font:21px/1 Georgia,serif;">${String(index + 1).padStart(2, '0')}</td>
    <td valign="top" style="padding:5px 0 12px;color:#49463f;font:13px/1.5 Arial,sans-serif;">${html(action)}</td>
  </tr>`).join('');
};

export const renderMonthlyCloseEmail = (
  facts: MonthlyCloseFacts,
  analysis: MonthlyCloseAnalysis,
  webAppUrl: string,
): MonthlyCloseEmail => {
  const reportLabel = compactMonthLabel(facts.month);
  const againstLabel = compactMonthLabel(facts.againstMonth);
  const signals = selectedSignals(facts, analysis);
  const spendingDelta = signedMoney(facts.spending.deltaMinor);
  const wealthDelta = facts.wealth.netDeltaMinor === null ? 'Primer cierre comparable' : signedMoney(facts.wealth.netDeltaMinor);
  const safeUrl = html(webAppUrl.endsWith('/') ? webAppUrl : `${webAppUrl}/`);
  const subject = `Tu cierre de ${monthLabel(facts.month).split(' de ')[0] ?? facts.month} · lectura de Olbia`;
  const emailHtml = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(subject)}</title>
<style>@media only screen and (max-width:620px){.olbia-wrap{width:100%!important}.olbia-pad{padding-left:20px!important;padding-right:20px!important}.olbia-title{font-size:34px!important}.olbia-net{font-size:40px!important}.olbia-stats td{display:block!important;width:100%!important}.olbia-stat-gap{height:10px!important}}</style></head>
<body style="margin:0;padding:0;background:#eee8dd;color:#25251f;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Tu gasto, categorías, tags y patrimonio al cierre de ${html(reportLabel)}.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#eee8dd;"><tr><td align="center" style="padding:24px 10px;">
<table class="olbia-wrap" role="presentation" width="660" cellspacing="0" cellpadding="0" style="width:660px;max-width:100%;border-collapse:separate;border-spacing:0;background:#f4efe5;border:1px solid #d7cfc1;border-radius:18px;overflow:hidden;">
<tr><td class="olbia-pad" style="padding:32px 36px 0;">
  <table role="presentation" width="100%"><tr><td style="color:#1d1e1b;font:22px/1 Georgia,serif;letter-spacing:.07em;">OLBIA</td><td align="right" style="color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;">Cierre mensual</td></tr></table>
  <p style="margin:32px 0 10px;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">${html(reportLabel)}</p>
  <h1 class="olbia-title" style="margin:0 0 16px;color:#1d1e1b;font:normal 44px/1.06 Georgia,serif;letter-spacing:-.025em;">${html(analysis.headline)}</h1>
  <p style="margin:0 0 26px;color:#4d4a42;font:15px/1.62 Arial,sans-serif;">${html(analysis.executiveSummary)}</p>
</td></tr>
<tr><td class="olbia-pad" style="padding:0 36px 28px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;background:#1d1e1b;border-radius:14px;color:#fbf8f1;"><tr><td style="padding:25px 26px;">
    <span style="display:block;margin-bottom:8px;color:#c9c3b8;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Neto</span>
    <strong class="olbia-net" style="display:block;margin-bottom:7px;color:#fbf8f1;font:bold 52px/1 Arial,sans-serif;letter-spacing:-.045em;font-variant-numeric:tabular-nums;">${html(formatMxnWhole(facts.wealth.netMxnMinor))}</strong>
    <span style="color:#e5dfd4;font:13px/1.4 Arial,sans-serif;">${html(wealthDelta)}${facts.wealth.comparable ? ` desde ${html(againstLabel)}` : ''}</span>
  </td></tr></table>
</td></tr>
<tr><td class="olbia-pad" style="padding:0 36px 32px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;background:#fbf8f1;border:1px solid #c7bdb0;border-left:4px solid #1d1e1b;border-radius:11px;"><tr><td style="padding:21px;">
    <p style="margin:0;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Lectura de Olbia</p>
    <p style="margin:9px 0 0;color:#3e3c36;font:17px/1.55 Georgia,serif;">${html(analysis.spendingNarrative)} ${html(analysis.wealthNarrative)}</p>
  </td></tr></table>
</td></tr>

<tr><td class="olbia-pad" style="padding:30px 36px;border-top:1px solid #d7cfc1;">
  <table role="presentation" width="100%"><tr><td><p style="margin:0;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Tu mes</p><h2 style="margin:4px 0 0;color:#1d1e1b;font:normal 28px/1.1 Georgia,serif;">Dónde se fue</h2></td><td align="right"><strong style="display:block;color:#1d1e1b;font:bold 22px/1.2 Arial,sans-serif;font-variant-numeric:tabular-nums;">${html(formatMxnWhole(facts.spending.totalSpentMinor))}</strong><span style="color:${facts.spending.deltaMinor > 0 ? '#9c332d' : '#52604a'};font:bold 11px/1.3 Arial,sans-serif;">${html(spendingDelta)} vs ${html(againstLabel)}</span></td></tr></table>
  <p style="margin:24px 0 8px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.13em;text-transform:uppercase;">Por categoría</p>
  ${categoryTable(facts)}
  <p style="margin:26px 0 8px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.13em;text-transform:uppercase;">Contextos del mes</p>
  ${tagsTable(facts)}
</td></tr>

<tr><td class="olbia-pad" style="padding:30px 36px;border-top:1px solid #d7cfc1;">
  <p style="margin:0;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Tu patrimonio</p>
  <h2 style="margin:4px 0 21px;color:#1d1e1b;font:normal 28px/1.1 Georgia,serif;">Qué cambió</h2>
  <table class="olbia-stats" role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td width="49%" style="padding:18px;border:1px solid #d7cfc1;border-radius:11px;background:#fbf8f1;"><span style="display:block;margin-bottom:7px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;">Activos</span><strong style="color:#1d1e1b;font:bold 21px/1.2 Arial,sans-serif;font-variant-numeric:tabular-nums;">${html(formatMxnWhole(facts.wealth.assetsMxnMinor))}</strong></td>
    <td class="olbia-stat-gap" width="2%"></td>
    <td width="49%" style="padding:18px;border:1px solid #d7cfc1;border-radius:11px;background:#fbf8f1;"><span style="display:block;margin-bottom:7px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;">Debes</span><strong style="color:#1d1e1b;font:bold 21px/1.2 Arial,sans-serif;font-variant-numeric:tabular-nums;">${html(formatMxnWhole(facts.wealth.liabilitiesMxnMinor))}</strong></td>
  </tr></table>
  <p style="margin:26px 0 8px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.13em;text-transform:uppercase;">Dónde está</p>
  ${wealthTable(facts)}
  ${liabilityTable(facts)}
  <p style="margin:26px 0 8px;color:#756e62;font:bold 10px/1.3 Arial,sans-serif;letter-spacing:.13em;text-transform:uppercase;">Dónde poner atención</p>
  ${signalsBlock(signals)}
</td></tr>

<tr><td class="olbia-pad" style="padding:30px 36px 34px;border-top:1px solid #d7cfc1;">
  <p style="margin:0;color:#756e62;font:bold 11px/1.3 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;">Siguiente mes</p>
  <h2 style="margin:4px 0 20px;color:#1d1e1b;font:normal 28px/1.1 Georgia,serif;">Tus próximos pasos</h2>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${actionsBlock(signals)}</table>
  <a href="${safeUrl}" style="display:block;margin:10px 0 14px;padding:16px 22px;border-radius:10px;background:#1d1e1b;color:#fbf8f1;font:bold 13px/1.3 Arial,sans-serif;letter-spacing:.02em;text-align:center;text-decoration:none;">Abrir Olbia</a>
  <p style="margin:0;color:#756e62;font:10px/1.55 Arial,sans-serif;text-align:center;">Las cifras vienen del ledger y de los últimos snapshots disponibles. El análisis no modifica movimientos ni saldos.</p>
</td></tr>

<tr><td class="olbia-pad" style="padding:23px 36px;background:#e7dfd2;border-top:1px solid #d7cfc1;color:#756e62;font:10px/1.5 Arial,sans-serif;">Olbia · Finanzas personales, con evidencia.<br>Corte: ${html(formatDay(facts.closeDay))} · America/Chihuahua</td></tr>
</table></td></tr></table></body></html>`;

  const textRows = categoryRows(facts).map((category) =>
    `- ${category.label}: ${formatMxnWhole(category.amountMinor)} (${percent(category.shareBasisPoints)}; ${signedMoney(category.deltaMinor)} vs ${againstLabel})`,
  );
  const tagRows = facts.spending.tags.slice(0, 3).map((tag) =>
    `- ${tag.key}: ${formatMxnWhole(tag.amountMinor)} · ${tag.eventCount} movimientos`,
  );
  const accountRows = facts.wealth.accounts.map((account) =>
    `- ${account.name}: ${account.snapshotDay ? formatMxnWhole(account.amountMinor) : 'Sin captura'}${account.ageDays !== null && account.stale ? ` · hace ${account.ageDays} días` : ''}`,
  );
  const liabilityRows = facts.wealth.liabilities.map((liability) =>
    `- ${liability.name}: ${liability.snapshotDay ? formatMxnWhole(liability.amountMinor) : 'Sin captura'}${liability.ageDays !== null && liability.stale ? ` · hace ${liability.ageDays} días` : ''}`,
  );
  const emailText = [
    `OLBIA · CIERRE MENSUAL · ${reportLabel.toUpperCase()}`,
    '',
    analysis.headline,
    analysis.executiveSummary,
    '',
    `NETO: ${formatMxnWhole(facts.wealth.netMxnMinor)} · ${wealthDelta}`,
    '',
    'LECTURA DE OLBIA',
    `${analysis.spendingNarrative} ${analysis.wealthNarrative}`,
    '',
    `DÓNDE SE FUE: ${formatMxnWhole(facts.spending.totalSpentMinor)} · ${spendingDelta} vs ${againstLabel}`,
    ...textRows,
    '',
    'CONTEXTOS DEL MES',
    ...(tagRows.length > 0 ? tagRows : ['- Sin tags']),
    'Los tags pueden superponerse; sus importes no se suman entre sí.',
    '',
    `PATRIMONIO: Activos ${formatMxnWhole(facts.wealth.assetsMxnMinor)} · Debes ${formatMxnWhole(facts.wealth.liabilitiesMxnMinor)}`,
    ...accountRows,
    ...liabilityRows,
    '',
    'DÓNDE PONER ATENCIÓN',
    ...(signals.length > 0 ? signals.map((signal) => `- ${signal.message}`) : ['- Sin alertas relevantes con los datos disponibles.']),
    '',
    'PRÓXIMOS PASOS',
    ...signals.map((signal) => `- ${signal.action}`),
    '',
    `Abrir Olbia: ${webAppUrl}`,
    `Corte: ${formatDay(facts.closeDay)} · America/Chihuahua`,
  ].join('\n');
  return { subject, html: emailHtml, text: emailText };
};
