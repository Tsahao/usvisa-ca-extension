import { expect, test } from '@playwright/test';

for (const manual of [false, true]) {
  test(`interval rollback remembers automatic increases across saving (manual override: ${manual})`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Fill synthetic preferences' }).click();
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await page.getByRole('button', { name: 'Consulate', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Calgary', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Halifax', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    const interval = page.getByLabel('Checking interval (s)');
    await expect(interval).toHaveValue('90');
    if (manual) {
      await interval.fill('91');
      await interval.fill('90'); // Explicitly retyping the auto value is manual.
    }
    await page.getByRole('button', { name: 'Consulate', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Halifax', exact: true }).click();
    await expect(interval).toHaveAttribute('min', '60');
    await expect(interval).toHaveValue(manual ? '90' : '60');
    await page.getByRole('menuitemcheckbox', { name: 'Calgary', exact: true }).click();
    await expect(interval).toHaveAttribute('min', '30');
    await expect(interval).toHaveValue(manual ? '90' : '60');
    // A later mandatory increase remains reversible back to the user's choice.
    for (const city of ['Calgary', 'Halifax', 'Ottawa']) await page.getByRole('menuitemcheckbox', { name: city, exact: true }).click();
    await expect(interval).toHaveValue('120');
    for (const city of ['Calgary', 'Halifax', 'Ottawa']) await page.getByRole('menuitemcheckbox', { name: city, exact: true }).click();
    await expect(interval).toHaveValue(manual ? '90' : '60');
  });
}
