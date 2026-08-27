import { InvalidManualEntryError } from './manual-entry-input.js';

export const parsePersonalAmountMinor = (value: unknown, grossAmountMinor: number): number => {
  if (typeof value !== 'number') {
    throw new InvalidManualEntryError('Mi parte debe ser un monto válido en centavos, mayor o igual a cero.');
  }
  const personalAmountMinor = value;
  if (!Number.isSafeInteger(personalAmountMinor) || personalAmountMinor < 0) {
    throw new InvalidManualEntryError('Mi parte debe ser un monto válido en centavos, mayor o igual a cero.');
  }
  if (!Number.isSafeInteger(grossAmountMinor) || grossAmountMinor <= 0 || personalAmountMinor > grossAmountMinor) {
    throw new InvalidManualEntryError('Mi parte no puede superar el total pagado.');
  }
  return personalAmountMinor;
};
