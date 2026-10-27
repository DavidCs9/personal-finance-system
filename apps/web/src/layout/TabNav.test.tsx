import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabNav } from './TabNav';

for (const variant of ['mobile', 'desktop'] as const) {
  describe(`${variant} primary navigation`, () => {
    it('offers four named screens with a distinct selected planning destination', () => {
      const html = renderToStaticMarkup(<TabNav tab="planning" onTabChange={() => {}} variant={variant} />);
      const names = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]);
      expect(names).toEqual(['Resumen', 'Movimientos', 'Planificación', 'Patrimonio']);
      expect(html.match(/role="tab"/g)).toHaveLength(4);
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
      expect(html).toMatch(/aria-selected="true">[\s\S]*?<span>Planificación<\/span>/);
      const paths = [...html.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);
      expect(new Set(paths).size).toBe(4);
    });
  });
}
