import { test, expect } from '@playwright/test';

test('Settings waits for field completion instead of warning ahead of the user', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Book or reschedule For Paid Visa Group' }).click();
  const panel = page.getByRole('region', { name: 'US Visa Scheduler for Canada' });
  const alert = panel.getByRole('alert');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(alert).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.invalid');
  await expect(alert).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await expect(alert).toHaveCount(0);
  await page.getByLabel('Consulate', { exact: true }).selectOption('Calgary');
  await expect(alert).toHaveCount(0);
  await page.getByLabel('Earliest Acceptable').fill('2026-11-01');
  await page.getByLabel('Latest Acceptable').focus();
  await expect(alert).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByLabel('Latest Acceptable').fill('2027-12-31');
  await expect(alert).toHaveCount(0);
  await expect(save).toBeEnabled();
  await page.getByLabel('Password', { exact: true }).fill('');
  await expect(alert).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByLabel('Email', { exact: true }).focus();
  await expect(alert).toHaveText('Enter your visa account password.');
  await page.getByLabel('Password', { exact: true }).focus();
  await expect(alert).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByLabel('Email', { exact: true }).focus();
  await expect(alert).toHaveCount(0);
  await save.click();
  await expect(panel.getByRole('button', { name: 'Start preview' })).toBeVisible();
});

test('Figma screens, assets and responsive panel', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'US Visa Scheduler for Canada' });
  const capture = async (name: string) => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await panel.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await panel.screenshot({ path: `test-results/${name}.png`, animations: 'disabled' });
  };
  await expect(page.getByRole('button', { name: 'Get date alerts For Unpaid Visa Group' })).toBeVisible();
  await expect(panel.getByRole('navigation')).toHaveCount(0);
  await capture('home');
  await expect(panel).toHaveCSS('height', '586px');
  const logo = panel.locator('img[src="assets/maple.svg"]');
  await expect(logo).toHaveJSProperty('naturalWidth', 35);
  expect(await logo.evaluate(image => (image as HTMLImageElement).getBoundingClientRect().width)).toBeCloseTo(35, 1);
  await page.getByRole('button', { name: 'Fill synthetic preferences' }).click();
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('preview@example.invalid');
  await expect(panel.getByRole('navigation').getByRole('button')).toHaveCount(5);
  await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  const termsLink = panel.getByRole('link', { name: 'Terms & Conditions' });
  const collapsedLinkBox = (await termsLink.boundingBox())!;
  const footerBox = (await panel.locator('footer').boundingBox())!;
  expect(footerBox.y - collapsedLinkBox.y - collapsedLinkBox.height).toBeGreaterThanOrEqual(0);
  expect(footerBox.y - collapsedLinkBox.y - collapsedLinkBox.height).toBeLessThan(40);
  await capture('configuration');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const configScroll = panel.locator('form > div');
  const expandedScroll = await configScroll.evaluate(node => ({ client: node.clientHeight, full: node.scrollHeight }));
  expect(expandedScroll.full).toBeGreaterThan(expandedScroll.client);
  await termsLink.scrollIntoViewIfNeeded();
  const resetBox = (await page.getByRole('button', { name: 'Reset Advanced' }).boundingBox())!;
  const expandedLinkBox = (await termsLink.boundingBox())!;
  expect(expandedLinkBox.y).toBeGreaterThanOrEqual(resetBox.y + resetBox.height);
  const retainedScroll = await configScroll.evaluate(node => node.scrollTop);
  await termsLink.click();
  await expect(panel.getByRole('navigation').getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect(await configScroll.evaluate(node => node.scrollTop)).toBe(retainedScroll);
  await page.getByLabel('Checking interval (s)').fill('120');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset Advanced' }).click();
  await page.getByRole('switch', { name: 'Test Mode' }).scrollIntoViewIfNeeded();
  await capture('advanced');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Preview scenario').selectOption('running');
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  const calendar = page.getByLabel('Appointment availability calendar');
  await expect(calendar.getByRole('button')).toHaveCount(2);
  await expect(calendar.locator('span[aria-label]')).toHaveCount(42);
  const calendarHeight = (await calendar.boundingBox())!.height;
  const calendarLayout = await calendar.evaluate(node => {
    const box = node.getBoundingClientRect();
    const days = node.lastElementChild!;
    const lastDay = days.lastElementChild!.getBoundingClientRect();
    const scroll = node.parentElement!;
    return { bottomInset: box.bottom - lastDay.bottom, leftInset: days.firstElementChild!.getBoundingClientRect().left - box.left, overflow: scroll.scrollHeight - scroll.clientHeight };
  });
  expect(calendarLayout.bottomInset).toBeCloseTo(calendarLayout.leftInset, 0);
  expect(calendarLayout.overflow).toBe(0);
  await capture('booking');
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(calendar).toContainText('January 2027');
  for (let month = 0; month < 12; month++) {
    await expect(calendar.locator('span[aria-label]')).toHaveCount(42);
    expect((await calendar.boundingBox())!.height).toBeCloseTo(calendarHeight, 1);
    await page.getByRole('button', { name: 'Next month' }).click();
  }
  await page.getByRole('button', { name: 'Hide panel' }).click();
  await page.getByRole('button', { name: 'Show scheduler · running' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await page.getByLabel('Preview workflow').selectOption('alerts');
  await page.getByLabel('Preview scenario').selectOption('running');
  await expect(page.getByLabel('Other consulate dates').locator(':scope > div')).toHaveCount(6);
  await expect(page.getByRole('heading', { name: 'Vancouver', exact: true })).toBeVisible();
  await capture('alerts');
  for (const status of ['success', 'failure:generic']) {
    await page.getByLabel('Preview scenario').selectOption(status);
    await capture(status.replace(':', '-'));
  }
  await expect(page.getByRole('heading', { name: 'That didn’t work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry preview' })).toBeVisible();
  for (const scenario of [
    { value: 'failure:paid-ivr-not-found', title: 'Couldn’t find paid group' },
    { value: 'failure:unpaid-ivr-not-found', title: 'Couldn’t find unpaid group' },
  ]) {
    await page.getByLabel('Preview scenario').selectOption(scenario.value);
    await expect(panel.getByRole('heading', { name: scenario.title, exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Check configurations', exact: true })).toBeVisible();
    await capture(scenario.value.replace(':', '-'));
  }
  await page.getByRole('button', { name: 'Review terms' }).click();
  await expect(panel.getByRole('navigation').getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await capture('terms');
  expect(await panel.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.setViewportSize({ width: 360, height: 500 });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Get date alerts For Unpaid Visa Group' })).toBeVisible();
  await capture('small-viewport');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
