import { describe, expect, it } from 'vitest';
import { assessGoldenThreadResponse } from './golden-thread-evaluation.js';

describe('assessGoldenThreadResponse', () => {
  it('accepts the golden decision-support answer', () => {
    const response = [
      'Te quedan $5,955.51 MXN después de las deudas.',
      'De viernes a miércoles son 6 días calendario y 5 noches.',
      'Con $100 USD diarios te pasas $4,244.49 MXN; con $150, $9,344.49; con $200, $14,444.49.',
    ].join(' ');
    expect(assessGoldenThreadResponse(response, ['olbia-tools___plan_month_scenario']))
      .toEqual({ passed: true, failures: [] });
  });

  it('rejects the failed pattern even when it sounds conversational', () => {
    const result = assessGoldenThreadResponse(
      '¿Cuánto quieres gastar? De viernes a miércoles son seis noches.',
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('response pushed budget discovery back to the user');
    expect(result.failures).toContain('plan_month_scenario was not used');
  });

  it('rejects the exact production regression after the CDMX correction', () => {
    const result = assessGoldenThreadResponse(
      'Perfecto, corregido. Las Vegas es del 21 al 25. Son 5 días calendario, 4 noches. ¿Cuánto quieres gastar por día en Las Vegas? Dame un número o rango y calculo el cierre.',
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('plan_month_scenario was not used');
    expect(result.failures).toContain('response pushed budget discovery back to the user');
  });
});
