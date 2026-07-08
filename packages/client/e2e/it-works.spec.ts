import { expect, test } from "@playwright/test";

// Keep in sync with the fallback in components/common/lib/branding.ts
const BRAND_NAME = process.env.VITE_BRAND_NAME || "Ermine";

test("shows a working login page", async ({ page }) => {
  await page.goto("");
  await expect(page).toHaveTitle(new RegExp(BRAND_NAME));

  const login = page.getByRole("button", { name: "Log In" });
  await expect(login).toBeVisible();
  await login.click();

  await expect(page.getByText(/Sign in to continue/)).toBeVisible();
});
