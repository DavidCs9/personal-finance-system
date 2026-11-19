const { test, expect } = require('@playwright/test');

for (const width of [320, 390, 1000]) {
  test(`spending first, generic entries and detail at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Deployment generates this file; the development-only demo needs no runtime credentials.
    await page.route('**/runtime-config.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto('/?demo=1');
    await expect(page.getByRole('heading', { name: 'Entradas del mes' })).toBeVisible();
    await expect(page.getByText('Gasto total del mes', { exact: true })).toBeVisible();
    const headings = await page.locator('.summary-scroll h2').allTextContents();
    expect(headings).toEqual(['Presupuesto mensual', 'Ritmo de gasto', 'En qué se fue', 'Entradas del mes']);
    for (const removed of ['Saldos de efectivo', 'Nómina y compromisos', 'Abonos del mes', 'Avisos de Olbia']) {
      await expect(page.getByRole('heading', { name: removed })).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('.summary-budget-panel').evaluateAll(elements =>
      elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`summary-${width}.png`), fullPage: true });

    const entry = page.getByRole('button', { name: /Finiquito · Empresa de prueba/ });
    await entry.click();
    const detail = page.getByRole('dialog', { name: 'Detalle de entrada' });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('demo-severance', { exact: true })).toBeVisible();
    await expect(detail.getByText('Finiquito', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(entry).toBeFocused();

    await page.getByRole('button', { name: /Devolución · Tienda de prueba/ }).click();
    await expect(detail.getByText('Devolución a cuenta', { exact: true })).toBeVisible();
    await expect(detail.getByText(/no modifica la compra original/)).toBeVisible();
    await detail.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('heading', { name: 'Entradas del mes' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`entries-${width}.png`), fullPage: true });

    await page.getByRole('button', { name: 'Ocultar montos' }).click();
    await expect(page.locator('.summary-pace-chart')).toHaveCount(0);
    await expect(page.locator('.month-entries-totals .amt').first()).toHaveCSS('filter', 'blur(7px)');
    await entry.click();
    await expect(detail.locator('.amt').first()).toHaveCSS('filter', 'blur(7px)');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Mostrar montos' }).click();

    if (width === 320) {
      await page.getByRole('button', { name: 'Registrar total recibido' }).click();
      const form = page.getByRole('dialog', { name: 'Registrar total recibido' });
      await form.getByLabel('Total recibido en MXN').fill('150000,62');
      await form.getByRole('button', { name: 'Guardar total' }).click();
      await expect(page.getByText('Declarado por ti')).toBeVisible();
      await expect(page.locator('.month-entries-totals').getByText('$150,000.62', { exact: true })).toBeVisible();
      await expect(page.getByText(/Abonos en Olbia/)).toBeVisible();
      await page.getByRole('button', { name: 'Editar total recibido' }).click();
      const editForm = page.getByRole('dialog', { name: 'Editar total recibido' });
      await expect(editForm.getByLabel('Total recibido en MXN')).toHaveValue('150000.62');
      await editForm.getByLabel('Total recibido en MXN').fill('0');
      await editForm.getByRole('button', { name: 'Guardar total' }).click();
      await expect(page.locator('.month-entries-totals').getByText('$0', { exact: true })).toBeVisible();
    }

    await page.getByLabel('Elegir mes', { exact: true }).fill('2026-08');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Finiquito · Empresa de prueba/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Entradas del mes' })).toBeVisible();

    await page.getByRole('button', { name: 'Preferencias', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Preferencias' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salir del mock', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
}
