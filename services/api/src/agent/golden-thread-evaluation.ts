export type GoldenThreadAssessment = {
  readonly passed: boolean;
  readonly failures: readonly string[];
};

const normalize = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const numericValues = (text: string): readonly number[] => {
  const tokens = text.match(/\d[\d., ]*\d|\d/g) ?? [];
  return tokens.flatMap((raw) => {
    const compact = raw.replace(/\s/g, '');
    const lastComma = compact.lastIndexOf(',');
    const lastDot = compact.lastIndexOf('.');
    const decimalIndex = Math.max(lastComma, lastDot);
    let canonical: string;
    if (decimalIndex >= 0 && compact.length - decimalIndex - 1 === 2) {
      canonical = `${compact.slice(0, decimalIndex).replace(/[.,]/g, '')}.${compact.slice(decimalIndex + 1)}`;
    } else {
      canonical = compact.replace(/[.,]/g, '');
    }
    const parsed = Number(canonical);
    return Number.isFinite(parsed) ? [parsed] : [];
  });
};

const mentions = (values: readonly number[], expected: number, tolerance = 0.51): boolean =>
  values.some((value) => Math.abs(value - expected) <= tolerance);

export const assessGoldenThreadResponse = (
  response: string,
  toolNames: readonly string[],
): GoldenThreadAssessment => {
  const normalized = normalize(response);
  const numbers = numericValues(response);
  const failures: string[] = [];
  if (!toolNames.some((name) => name.endsWith('plan_month_scenario'))) {
    failures.push('plan_month_scenario was not used');
  }
  if (!/6\s+(dias|dia)\s+(calendario|calendarios)/.test(normalized)) {
    failures.push('response did not state 6 calendar days');
  }
  if (!/5\s+noches?/.test(normalized)) failures.push('response did not state 5 nights');
  for (const expected of [5_955.51, 4_244.49, 9_344.49, 14_444.49]) {
    if (!mentions(numbers, expected)) failures.push(`response did not include ${expected.toFixed(2)}`);
  }
  if (/cuanto\s+(quieres|piensas|planeas)\s+gastar/.test(normalized)
    || /cual\s+es\s+tu\s+presupuesto/.test(normalized)) {
    failures.push('response pushed budget discovery back to the user');
  }
  return { passed: failures.length === 0, failures };
};
