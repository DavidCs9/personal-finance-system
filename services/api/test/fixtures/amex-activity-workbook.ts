import { strToU8, zipSync } from 'fflate';

export type ActivityTestRow = { date?: string; purchaseDate?: string; merchant?: string; amount?: number; reference?: string; detail?: string };
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const activityWorkbook = (rows: readonly ActivityTestRow[] = [{}], suffix = '23456', period = '07 Oct 2026 a 06 Nov 2026') => {
  const data: (string | number | null)[][] = [
    ['Detalles de la operación', `The Gold Elite Credit Card American Express / ${period}`], ['Preparado para'], ['Owner'],
    ['Número de Cuenta'], [`XXXX-XXXXXX-${suffix}`], [],
    ['Fecha', 'Fecha de Compra', 'Descripción', 'Importe', 'Monto en moneda extranjera', 'Tipo de Cambio', 'Información Adicional',
      'Aparece en su Estado de Cuenta como', 'Dirección', 'Población/Provincia', 'Código postal', 'País', 'Referencia'],
    ...rows.map((row, index) => [row.date ?? '14 Oct 2026', row.purchaseDate ?? row.date ?? '14 Oct 2026', row.merchant ?? 'Example shop',
      row.amount ?? 599, null, null, row.detail ?? '', row.merchant ?? 'Example shop', null, null, null, 'MEXICO', row.reference ?? `AT-bank-${index}`]),
  ];
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data.map((row, i) =>
    `<row r="${i + 1}">${row.map((value, col) => value == null ? '' : typeof value === 'number'
      ? `<c r="${String.fromCharCode(65 + col)}${i + 1}"><v>${value}</v></c>`
      : `<c r="${String.fromCharCode(65 + col)}${i + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Detalles de la operación" r:id="rId1" sheetId="1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
};
