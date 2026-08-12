import type { Institution } from '@finance/domain';
import type { NormalizedEmail } from './email.js';

export const trustedInstitutionHint = (email: NormalizedEmail): Institution | undefined => {
  const content = `${email.from}\n${email.subject}\n${email.text.slice(0, 12_000)}`.toLocaleLowerCase('es-MX');
  if (/nu(?:@|\s|<)|nu\.com\.mx/.test(content) && /transfer/.test(content)) return 'nu_mx';
  if (/american\s+express|americanexpress\.com\.mx/.test(content)) return 'american_express_mx';
  if (/santander|envio\.santander\.com\.mx/.test(content)) return 'santander_mx';
  if (/invoicing@aws\.com|amazon web services billing statement/.test(content)) return 'amazon_web_services';
  return undefined;
};
