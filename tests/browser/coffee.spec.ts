import { test, expect } from '@playwright/test';

test('coffee entries, amount controls and responsive layout match Figma', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Preview scenario').selectOption('success');
  const panel = page.getByRole('region', { name: 'US Visa Scheduler for Canada' });
  const capture = async (name: string) => {
    await page.screenshot({ path: `test-results/${name}.png`, clip: (await panel.boundingBox())!, animations: 'disabled' });
  };
  await expect(panel.getByRole('button', { name: 'Buy me a coffee?' })).toBeVisible();
  await capture('booking-success-coffee-link');
  await panel.getByRole('button', { name: 'Buy me a coffee?' }).click();
  await expect(panel.getByRole('button', { name: 'Coffee', exact: true })).toHaveAttribute('aria-current', 'page');
  const amount = panel.getByRole('textbox', { name: 'Amount in USD' });
  await expect(amount).toHaveValue('5');
  await expect(panel.getByRole('button', { name: 'USD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await amount.fill('99');
  await expect(panel.getByRole('button', { name: 'Increase amount' })).toBeDisabled();
  await amount.fill('1');
  await expect(panel.getByRole('button', { name: 'Decrease amount' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Increase amount' }).click();
  await expect(amount).toHaveValue('2');
  await amount.fill('5');
  await panel.getByRole('heading', { name: 'Buy me a coffee?' }).click();
  await expect.poll(() => panel.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  for (const name of ['Increase amount', 'Decrease amount']) {
    const icon = panel.getByRole('button', { name }).locator('img');
    expect(await icon.evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height }))).toEqual({ width: 64, height: 64 });
  }
  const geometry = await amount.evaluate(input => {
    const box = input.parentElement!.getBoundingClientRect();
    const panel = input.closest('section[aria-label="US Visa Scheduler for Canada"]')!.getBoundingClientRect();
    return { width: box.width, height: box.height, top: box.top - panel.top, center: box.x + box.width / 2 - (panel.x + panel.width / 2) };
  });
  expect(geometry).toEqual({ width: 276, height: 135, top: 257, center: 0 });
  await capture('coffee-usd');
  await panel.getByRole('button', { name: 'CAD', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'CAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: 'USD', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.getByRole('textbox', { name: 'Amount in CAD' })).toHaveValue('5');
  await expect(panel.getByRole('button', { name: 'Continue to Stripe' })).toBeEnabled();
  await capture('coffee-cad');
  await panel.getByRole('button', { name: 'Booking', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Appointment booked' })).toBeVisible();
  await panel.getByRole('button', { name: 'Coffee', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 500 });
  await expect(panel.getByRole('button', { name: 'Continue to Stripe' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Amount in USD' })).toBeVisible();
  await panel.getByRole('textbox', { name: 'Amount in USD' }).locator('..').scrollIntoViewIfNeeded();
  const amountBox = (await panel.getByRole('textbox', { name: 'Amount in USD' }).locator('..').boundingBox())!;
  const arrowBox = (await panel.getByRole('button', { name: 'Continue to Stripe' }).boundingBox())!;
  expect(amountBox.y + amountBox.height).toBeLessThan(arrowBox.y);
  await capture('coffee-small');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
