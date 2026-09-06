import { expect, test } from '@playwright/test'

/**
 * Smoke flows — docs/09 M4: "Playwright smoke: participant happy path, brand happy
 * path, ops verification path", plus the landing page, which is the one surface a real
 * user will hit before anything else exists.
 *
 * These run against a seeded database with the fake providers active.
 */

test.describe('landing page', () => {
  test('renders both languages, the estimator and the waitlist form', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // The estimator computes from lib/money/rates.ts, so a number must be present.
    await expect(page.getByText(/kr per kampanj|kr per campaign/)).toBeVisible()

    // The three example rows are recomputed, never hardcoded.
    await expect(page.getByText('38 kr')).toBeVisible()

    // Under 18 is not offered anywhere (docs/07 section 6).
    const ageOptions = await page.locator('#ageBracket option').allTextContents()
    expect(ageOptions.join(' ')).not.toMatch(/1[0-7]\b/)
    expect(ageOptions).toContain('18-20')

    // Language toggle switches the copy.
    await page.getByRole('button', { name: 'English' }).first().click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Post like you normally do/i)
  })

  test('validates the waitlist form and stores a signup', async ({ page }) => {
    await page.goto('/#waitlist')

    const unique = `e2e-${Date.now()}@example.se`

    await page.fill('#handle', '@e2e_tester')
    await page.selectOption('#city', 'stockholm')
    await page.selectOption('#ageBracket', '21-25')
    await page.selectOption('#followersBracket', '300-1k')
    await page.getByRole('button', { name: 'Gym' }).first().click()
    await page.fill('#email', unique)
    await page.check('input[name="consent"]')

    await page.getByRole('button', { name: /Ställ dig i kön|Join the waitlist/ }).click()

    // Success state shows a queue position and a referral link.
    await expect(page.getByText(/Du är med|You're in/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/\?ref=/)).toBeVisible()
  })

  test('serves the legal drafts', async ({ page }) => {
    await page.goto('/privacy')
    // The draft notice appears twice by design: as the page banner and again inside the
    // document body, so match the banner specifically.
    await expect(page.getByText(/UTKAST|DRAFT/).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /Integritetspolicy|Privacy policy/ })).toBeVisible()

    await page.goto('/terms')
    await expect(page.getByText(/UTKAST|DRAFT/).first()).toBeVisible()
  })

  test('serves the brands page with an enquiry form', async ({ page }) => {
    await page.goto('/brands')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('#company')).toBeVisible()
    await expect(page.locator('#budgetBracket')).toBeVisible()
  })
})

test.describe('accessibility and performance basics', () => {
  test('has no horizontal scroll on a phone viewport', async ({ page }) => {
    await page.goto('/')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })

  test('every form control has a label', async ({ page }) => {
    await page.goto('/#waitlist')
    const unlabelled = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('input, select, textarea')]
      return controls.filter((el) => {
        if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'range')) return false
        const id = el.getAttribute('id')
        const hasLabel = id ? document.querySelector(`label[for="${id}"]`) !== null : false
        const wrapped = el.closest('label') !== null
        const aria = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
        return !hasLabel && !wrapped && !aria
      }).length
    })
    expect(unlabelled).toBe(0)
  })

  test('protected surfaces are not publicly readable', async ({ page }) => {
    // Without a session these redirect rather than rendering data.
    const response = await page.goto('/ops/campaigns')
    expect(page.url()).not.toContain('/ops/campaigns')
    expect(response?.status()).toBeLessThan(500)
  })
})
