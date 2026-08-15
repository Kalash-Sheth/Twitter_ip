/**
 * STANDALONE test — opens x.com in a real browser via Playwright, logs in with
 * X_USERNAME/X_PASSWORD, and posts one tweet. Completely separate from
 * lib/poster.ts / lib/x.ts (the OAuth1 API path) — nothing in the main
 * pipeline calls this file. For manual, local testing only.
 *
 * Setup:
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Env (add to .env, do NOT commit):
 *   X_USERNAME=your_handle_or_email
 *   X_PASSWORD=your_password
 *
 * Run:
 *   npx tsx scripts/playwright-post-test.ts "hello from playwright"
 *
 * Notes:
 * - Runs headed (visible browser) on purpose — X frequently throws login
 *   checkpoints (email code, phone, "unusual activity") that need a human to
 *   click through once. Watch the window when you run this the first time.
 * - Saves cookies to scripts/.playwright-x-session.json after a successful
 *   login so subsequent runs can skip the login form. Delete that file to
 *   force a fresh login.
 * - This drives the UI like a human would; it is NOT the official API and is
 *   against X's automation terms — use only for your own account, for testing.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, ".playwright-x-session.json");

async function main() {
  const text = process.argv.slice(2).join(" ") || `Playwright test post [${new Date().toISOString()}]`;
  const username = process.env.X_USERNAME;
  const password = process.env.X_PASSWORD;

  if (!username || !password) {
    console.log("✗ Set X_USERNAME and X_PASSWORD in .env first.");
    process.exit(1);
  }

  const fs = await import("node:fs");
  const hasSession = fs.existsSync(SESSION_FILE);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext(hasSession ? { storageState: SESSION_FILE } : {});
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });

    const loggedIn = await page
      .getByTestId("SideNav_NewTweet_Button")
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!loggedIn) {
      console.log("Not logged in — running login flow (solve any captcha/verification manually if it appears)...");
      await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      // X's login inputs currently have no aria-label/associated <label> — match by
      // name attribute instead. The DOM renders duplicate copies of the form
      // (responsive layout), so always take .first().
      const userField = page.locator('input[name="username_or_email"]').first();
      await userField.click();
      await userField.pressSequentially(username, { delay: 30 });
      await page.getByRole("button", { name: "Continue", exact: true }).first().click();

      // X sometimes asks to re-confirm username/phone as an extra checkpoint.
      const extraField = page.getByTestId("ocfEnterTextTextInput");
      if (await extraField.isVisible({ timeout: 4000 }).catch(() => false)) {
        await extraField.fill(username);
        await page.getByRole("button", { name: "Next" }).click();
      }

      const passwordField = page.locator('input[name="password"]').first();
      await passwordField.waitFor({ timeout: 15000 });
      await passwordField.click();
      await passwordField.pressSequentially(password, { delay: 30 });
      await page.getByRole("button", { name: "Log in", exact: true }).first().click();

      await page.getByTestId("SideNav_NewTweet_Button").waitFor({ timeout: 60000 });
      console.log("✓ Logged in.");
      await context.storageState({ path: SESSION_FILE });
    } else {
      console.log("✓ Reused saved session, already logged in.");
    }

    console.log("Posting:", text);
    await page.getByTestId("SideNav_NewTweet_Button").click();
    const composer = page.getByTestId("tweetTextarea_0");
    await composer.waitFor({ timeout: 15000 });
    await composer.fill(text);
    await page.getByTestId("tweetButton").click();

    await page.waitForTimeout(3000);
    console.log("✓ Post submitted — check your profile to confirm it landed.");
  } catch (e) {
    console.log("✗ FAILED:", e instanceof Error ? e.message : String(e));
    await page.screenshot({ path: path.join(__dirname, "playwright-x-error.png") }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
