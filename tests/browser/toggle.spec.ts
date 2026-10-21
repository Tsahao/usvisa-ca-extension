import { expect, test, type Locator } from '@playwright/test';

async function expectFigmaToggle(control: Locator, checked: boolean) {
  await expect(control).toHaveCSS('width', '36px');
  await expect(control).toHaveCSS('height', '16px');
  // Chromium may serialize 8.5% alpha at its nearest 8-bit value, 0.086.
  await expect(control).toHaveCSS('background-color', checked ? 'rgb(0, 136, 255)' : /^rgba\(0, 0, 0, 0\.08[56]\)$/);
  expect(await control.evaluate(input => {
    const thumb = getComputedStyle(input, '::after');
    return { width: thumb.width, height: thumb.height, top: thumb.top, left: thumb.left, radius: thumb.borderRadius, fill: thumb.backgroundColor };
  })).toEqual({ width: '21px', height: '13px', top: '1.5px', left: checked ? '13px' : '2px', radius: '100px', fill: 'rgb(255, 255, 255)' });
}

test('all setup and Settings switches share the Figma capsule geometry in both states', async ({ page }) => {
  await page.goto('/');
  const setup = page.getByRole('switch', { name: 'Auto Book', exact: true });
  await expectFigmaToggle(setup, true);
  await setup.uncheck();
  await expectFigmaToggle(setup, false);
  await page.getByRole('button', { name: 'Fill synthetic preferences' }).click();
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  for (const label of ['Auto Mode', 'Earlier appointments only']) {
    const control = page.getByRole('switch', { name: label, exact: true });
    await expectFigmaToggle(control, true);
    await control.uncheck();
    await expectFigmaToggle(control, false);
    await control.focus();
    await page.keyboard.press('Space');
    await expectFigmaToggle(control, true);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Start preview' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  for (const label of ['Auto Mode', 'Earlier appointments only']) {
    const control = page.getByRole('switch', { name: label, exact: true });
    await expect(control).toBeDisabled();
    await expectFigmaToggle(control, true);
  }
});
