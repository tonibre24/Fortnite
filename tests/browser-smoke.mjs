/**
 * Two-browser smoke check.
 *
 * Launches the built client in two real Chromium pages, joins both to the same room,
 * drives keyboard/mouse input and asserts that the HUD, movement synchronisation and
 * shooting all work end to end in an actual browser.
 *
 * Run with:  node tests/browser-smoke.mjs
 * Expects the server and a static host for `apps/client/dist` to already be running;
 * `pnpm verify:browser` starts both for you.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

/**
 * Uses the environment's pre-installed Chromium when present (the browser download is
 * disabled here), otherwise falls back to Playwright's own resolution.
 */
function resolveChromium() {
  const candidates = [
    process.env.RIFTFRONT_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path));
}

const CLIENT_URL = process.env.RIFTFRONT_CLIENT_URL ?? 'http://127.0.0.1:4173';
const HEADLESS = process.env.RIFTFRONT_HEADED !== '1';
const SCREENSHOT_PATH = process.env.RIFTFRONT_SCREENSHOT ?? '';

const failures = [];
const notes = [];

function check(label, condition, detail = '') {
  if (condition) {
    notes.push(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(label, page, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn)) return true;
    await sleep(120);
  }
  failures.push(`  FAIL  timed out waiting for ${label}`);
  return false;
}

/** Reads gameplay state out of the page for assertions. */
const readState = () => {
  const hud = document.getElementById('hud');
  const health = document.querySelector('.bar.health b')?.textContent ?? '';
  const shield = document.querySelector('.bar.shield b')?.textContent ?? '';
  const ammo = document.querySelector('.weapon .ammo span')?.textContent ?? '';
  const weapon = document.querySelector('.weapon .name')?.textContent ?? '';
  const timer = document.querySelector('.matchbar .timer')?.textContent ?? '';
  const players = document.querySelectorAll('.netstat span')[1]?.textContent ?? '';
  return { hudVisible: hud ? !hud.hidden : false, health, shield, ammo, weapon, timer, players };
};

async function openClient(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(CLIENT_URL, { waitUntil: 'networkidle' });
  return { label, context, page, errors };
}

async function main() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: resolveChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  let alpha;
  let bravo;

  try {
    // --- 1. Both clients load ------------------------------------------------
    alpha = await openClient(browser, 'alpha');
    check('client loads without a fatal error', (await alpha.page.$('.fatal')) === null);
    check('landing screen is visible', (await alpha.page.isVisible('#landing-screen')) === true);
    check('canvas is present', (await alpha.page.$('#render-canvas')) !== null);

    // --- 2. Create a match ---------------------------------------------------
    await alpha.page.fill('#display-name', 'AlphaOne');
    await alpha.page.click('button:has-text("Create match")');

    const alphaJoined = await waitUntil(
      'alpha to enter the match',
      alpha.page,
      () => {
        const hud = document.getElementById('hud');
        return hud !== null && !hud.hidden;
      },
    );
    check('creating a match enters the HUD', alphaJoined);

    const roomCode = await alpha.page.evaluate(() => {
      return new URLSearchParams(window.location.search).get('room') ?? '';
    });
    check('a room code was allocated', /^[A-Z0-9]{5}$/.test(roomCode), roomCode);

    // --- 3. Second client joins the same room --------------------------------
    bravo = await openClient(browser, 'bravo');
    await bravo.page.fill('#display-name', 'BravoTwo');
    await bravo.page.fill('#room-code', roomCode);
    await bravo.page.click('button:has-text("Join match")');

    const bravoJoined = await waitUntil(
      'bravo to enter the match',
      bravo.page,
      () => {
        const hud = document.getElementById('hud');
        return hud !== null && !hud.hidden;
      },
    );
    check('a second client can join by room code', bravoJoined);

    // --- 4. Both clients see two players -------------------------------------
    const bothSeeTwo = await waitUntil(
      'both clients to report two players',
      alpha.page,
      () => (document.querySelectorAll('.netstat span')[1]?.textContent ?? '') === '2',
    );
    check('both players appear in the player count', bothSeeTwo);

    // --- 5. The match starts -------------------------------------------------
    const started = await waitUntil(
      'the match to reach PLAYING',
      alpha.page,
      () => {
        const meta = document.querySelector('.matchbar .meta')?.textContent ?? '';
        return meta.includes('Rank') || meta.includes('Deathmatch');
      },
      30000,
    );
    check('the match transitions to PLAYING', started);

    const alphaState = await alpha.page.evaluate(readState);
    check('HUD shows full health', alphaState.health === '100', alphaState.health);
    check('HUD shows full shield', alphaState.shield === '50', alphaState.shield);
    check('HUD shows the rifle', alphaState.weapon.length > 0, alphaState.weapon);
    check('HUD shows a full magazine', alphaState.ammo === '30', alphaState.ammo);
    check('match timer is counting', /^\d+:\d{2}$/.test(alphaState.timer), alphaState.timer);

    // --- 6. Movement is simulated and synchronised ---------------------------
    // Pointer lock needs a click on the canvas first.
    await alpha.page.click('#render-canvas');
    await sleep(300);

// A screenshot is written so the rendered arena can be inspected after a run.
    if (SCREENSHOT_PATH) {
      await alpha.page.screenshot({ path: SCREENSHOT_PATH });
      notes.push(`  INFO  screenshot written to ${SCREENSHOT_PATH}`);
    }

    await alpha.page.keyboard.down('KeyW');
    await sleep(1500);
    await alpha.page.keyboard.up('KeyW');
    await sleep(600);

    // The scoreboard is the client-visible proof that both players are in one match.
    await alpha.page.keyboard.down('Tab');
    await sleep(400);
    const scoreboardRows = await alpha.page.evaluate(() =>
      [...document.querySelectorAll('.scoreboard tbody tr td:nth-child(2)')].map(
        (n) => n.textContent,
      ),
    );
    await alpha.page.keyboard.up('Tab');
    check(
      'scoreboard lists both display names',
      scoreboardRows.includes('AlphaOne') && scoreboardRows.includes('BravoTwo'),
      scoreboardRows.join(', '),
    );

    // --- 7. Firing works -----------------------------------------------------
    const ammoBefore = await alpha.page.evaluate(
      () => document.querySelector('.weapon .ammo span')?.textContent ?? '',
    );

    await alpha.page.mouse.down({ button: 'left' });
    await sleep(700);
    await alpha.page.mouse.up({ button: 'left' });
    await sleep(500);

    const ammoAfter = await alpha.page.evaluate(
      () => document.querySelector('.weapon .ammo span')?.textContent ?? '',
    );
    check(
      'firing consumes server-tracked ammunition',
      Number(ammoAfter) < Number(ammoBefore),
      `${ammoBefore} -> ${ammoAfter}`,
    );

    // --- 8. Reloading works --------------------------------------------------
    await alpha.page.keyboard.press('KeyR');
    await sleep(300);
    const reloading = await alpha.page.evaluate(() => {
      const bar = document.querySelector('.reload-bar');
      return bar !== null && !bar.hidden;
    });
    check('reloading shows reload progress', reloading);

    await sleep(2400);
    const ammoReloaded = await alpha.page.evaluate(
      () => document.querySelector('.weapon .ammo span')?.textContent ?? '',
    );
    check('reload refills the magazine', ammoReloaded === '30', ammoReloaded);

    // --- 9. Weapon switching -------------------------------------------------
    await alpha.page.keyboard.press('Digit2');
    await sleep(700);
    const shotgunName = await alpha.page.evaluate(
      () => document.querySelector('.weapon .name')?.textContent ?? '',
    );
    const shotgunAmmo = await alpha.page.evaluate(
      () => document.querySelector('.weapon .ammo span')?.textContent ?? '',
    );
    check('weapon switching reaches the shotgun', shotgunAmmo === '6', `${shotgunName} ${shotgunAmmo}`);

    // --- 10. Pause menu ------------------------------------------------------
    await alpha.page.keyboard.press('Escape');
    await sleep(400);
    check('escape opens the pause menu', await alpha.page.isVisible('#pause-screen'));
    await alpha.page.click('#pause-screen button:has-text("Resume")');
    await sleep(300);
    check('resume closes the pause menu', !(await alpha.page.isVisible('#pause-screen')));

    // --- 11. Disconnect leaves no ghost --------------------------------------
    await bravo.context.close();
    bravo = null;

    const ghostCleared = await waitUntil(
      'the player count to drop back to one',
      alpha.page,
      () => (document.querySelectorAll('.netstat span')[1]?.textContent ?? '') === '1',
      15000,
    );
    check('disconnecting removes the player (no ghosts)', ghostCleared);

    // --- 12. No console errors ----------------------------------------------
    const realErrors = alpha.errors.filter(
      (text) => !/favicon|Failed to load resource.*404/i.test(text),
    );
    check('no console errors on the client', realErrors.length === 0, realErrors.join(' | '));
  } finally {
    await bravo?.context.close().catch(() => {});
    await alpha?.context.close().catch(() => {});
    await browser.close();
  }
}

main()
  .then(() => {
    console.log('\nBrowser smoke check\n');
    for (const line of notes) console.log(line);
    for (const line of failures) console.log(line);
    console.log(
      `\n${notes.length} passed, ${failures.length} failed\n`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('Browser smoke check crashed:', error);
    for (const line of notes) console.log(line);
    for (const line of failures) console.log(line);
    process.exit(1);
  });
