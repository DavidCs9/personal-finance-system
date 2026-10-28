import { readSheet } from 'read-excel-file/node';
import { unzipSync } from 'fflate';
import { isAmexDeferralCreditMerchant } from './amex-deferral.js';
import { isAutomaticAmexLabel } from './msi-reconciliation.js';

export const MAX_AMEX_ACTIVITY_BYTES = 2_000_000;
export const AMEX_ACTIVITY_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export class InvalidAmexActivityError extends Error {}

export interface AmexActivityRow {
  readonly identity: string;
  readonly kind: 'purchase' | 'msi';
  readonly rowNumber: number;
  readonly transactionId: string;
  readonly merchantReference?: string;
  readonly occurredOn: string;
  readonly purchaseOn: string;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly credit: boolean;
  readonly msi: boolean;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
}
export interface AmexActivityDocument {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly rows: readonly AmexActivityRow[];
}

const invalid = (message: string): never => { throw new InvalidAmexActivityError(message); };
const text = (value: unknown): string => value == null ? '' : String(value).trim();
const months: Readonly<Record<string, number>> = {
  jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, ago: 8, sep: 9, oct: 10, nov: 11, dec: 12, dic: 12,
};
export const activityDate = (value: unknown): string => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const match = /^(\d{1,2})[ /-]([a-záéíóú]{3,})[ /-](\d{4})$/i.exec(text(value));
  if (!match) return invalid('Una fecha del Excel no es válida. Descarga el archivo original de Amex.');
  const month = months[match[2].toLowerCase().slice(0, 3)], day = Number(match[1]), year = Number(match[3]);
  if (!month || year < 2000 || year > 2100) return invalid('Una fecha del Excel no es válida.');
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return invalid('Una fecha del Excel no es válida.');
  return date;
};

/** Read the native workbook without evaluating formulas, macros or external links. */
export const parseAmexActivity = async (bytes: Uint8Array): Promise<AmexActivityDocument> => {
  if (!bytes.length || bytes.length > MAX_AMEX_ACTIVITY_BYTES) return invalid('Selecciona un Excel Amex de hasta 2 MB.');
  try {
    let expanded = 0, entries = 0;
    // Inspect central-directory sizes before the workbook library decompresses any XML.
    unzipSync(bytes, { filter: file => {
      expanded += file.originalSize; entries++;
      if (expanded > 12_000_000 || entries > 100 || /(?:vbaProject|externalLinks)/i.test(file.name))
        invalid('El Excel contiene elementos no admitidos o excede el tamaño permitido.');
      return false;
    } });
    const data = await readSheet(Buffer.from(bytes), 'Detalles de la operación');
    if (data.length > 1007) return invalid('El Excel supera el máximo de 1,000 movimientos.');
    const title = text(data[0]?.[1]);
    const titleMatch = /^(.*?)\s*\/\s*(\d{1,2} \w+ \d{4})\s+a\s+(\d{1,2} \w+ \d{4})$/.exec(title);
    if (!titleMatch || !/american express/i.test(titleMatch[1])) return invalid('Selecciona la actividad descargada de Amex México.');
    const accountLabel = data.findIndex(row => text(row[0]) === 'Número de Cuenta');
    const account = text(data[accountLabel + 1]?.[0]);
    const suffix = /(?:X|\d)[X\d-]*-(\d{5})$/i.exec(account)?.[1];
    if (accountLabel < 0 || !suffix) return invalid('No se pudo identificar la cuenta del Excel Amex.');
    const accountLastFour = suffix.slice(-4);
    const header = data.findIndex(row => text(row[0]) === 'Fecha' && text(row[2]) === 'Descripción');
    const columns = ['Fecha', 'Fecha de Compra', 'Descripción', 'Importe', 'Monto en moneda extranjera', 'Tipo de Cambio',
      'Información Adicional', 'Aparece en su Estado de Cuenta como', 'Dirección', 'Población/Provincia', 'Código postal', 'País', 'Referencia'];
    if (header < 0 || columns.some((label, i) => text(data[header][i]) !== label))
      return invalid('El formato del Excel Amex cambió. No se importó ningún movimiento.');
    const identities = new Set<string>();
    const rows = data.slice(header + 1).flatMap((row, index): AmexActivityRow[] => {
      if (row.every(value => value == null || text(value) === '')) return [];
      const rowNumber = header + index + 2;
      const amount = row[3];
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return invalid(`Importe no válido en la fila ${rowNumber}.`);
      const amountMinor = Math.round(amount * 100);
      if (!Number.isSafeInteger(amountMinor) || Math.abs(amount * 100 - amountMinor) > 0.0001)
        return invalid(`Importe no válido en la fila ${rowNumber}.`);
      const merchantRaw = text(row[2]);
      if (amountMinor < 0 && isAmexDeferralCreditMerchant(merchantRaw))
        return invalid('Este Excel incluye un ajuste de diferimiento automático. Importa el PDF Amex para conciliar las compras originales y sus cuotas sin duplicar el gasto.');
      const transactionId = text(row[12]);
      if (!merchantRaw || !/^[A-Za-z0-9_-]{4,128}$/.test(transactionId))
        return invalid(`Falta la referencia bancaria en la fila ${rowNumber}. Descarga con información adicional.`);
      const identity = `amex_activity:${suffix}:${transactionId}`;
      if (identities.has(identity)) return invalid(`La referencia de la fila ${rowNumber} está repetida. Revisa el archivo original.`);
      identities.add(identity);
      const detail = text(row[6]);
      const merchantReference = /\/REF\s*([A-Za-z0-9_-]+)/i.exec(detail)?.[1];
      const installment = /\bCARGO\s+(\d{1,2})\s+DE\s+(\d{1,2})\b/i.exec(detail);
      if (/\bCARGO\s+\d.*\bDE\b/i.test(detail) && !installment) return invalid(`MSI no válido en la fila ${rowNumber}.`);
      const installmentIndex = installment ? Number(installment[1]) : undefined;
      const installmentMonths = installment ? Number(installment[2]) : undefined;
      if (installmentIndex !== undefined && (!installmentMonths || installmentIndex < 1
        || installmentIndex > installmentMonths || installmentMonths > 48)) return invalid(`MSI no válido en la fila ${rowNumber}.`);
      const msi = Boolean(installment) || isAutomaticAmexLabel(merchantRaw);
      return [{ identity, kind: msi ? 'msi' : 'purchase', msi, rowNumber, transactionId,
        occurredOn: activityDate(row[0]), purchaseOn: activityDate(row[1]), merchantRaw, amountMinor,
        credit: amountMinor <= 0, ...(merchantReference ? { merchantReference } : {}),
        ...(installment ? { installmentIndex, installmentMonths } : {}) }];
    });
    const period = { from: activityDate(titleMatch[2]), to: activityDate(titleMatch[3]) };
    if (period.from > period.to) return invalid('El periodo del Excel Amex no es válido.');
    if (rows.some(row => row.occurredOn < period.from || row.occurredOn > period.to))
      return invalid('Hay movimientos fuera del periodo indicado por Amex. Revisa el archivo.');
    return { accountLastFour, product: titleMatch[1].trim(), period, rows };
  } catch (error) {
    if (error instanceof InvalidAmexActivityError) throw error;
    throw new InvalidAmexActivityError('No se pudo leer el Excel. Selecciona el .xlsx original descargado de Amex.');
  }
};
