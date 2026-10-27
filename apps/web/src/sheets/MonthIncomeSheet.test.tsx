import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoPlans, emptyPlanFor } from '../monthly-plan';
import { MonthIncomeSheet } from './MonthIncomeSheet';

for (const plan of [emptyPlanFor('2026-07'), demoPlans['2026-07']!]) {
  it(`keeps XML upload available with ${plan.payslips?.length ?? 0} existing payslips`, () => {
    const html = renderToStaticMarkup(<MonthIncomeSheet plan={plan} onClose={() => {}}
      onOpenPayslip={() => {}} onUploadNomina={() => {}} />);
    expect(html).toContain('Subir nómina XML');
    if (plan.estimateActive) {
      expect(html).toContain('2ª quincena estimada');
      expect(html).toContain('Nómina ordinaria');
    }
  });
}
