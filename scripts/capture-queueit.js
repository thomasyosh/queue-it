const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = process.cwd();
const ENV_PATH = path.join(ROOT_DIR, '.env');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'pages.json');
const OUTPUT_DIR = path.join(ROOT_DIR, 'archive-output');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');
const DATA_DIR = path.join(OUTPUT_DIR, 'data');
const STORAGE_STATE_PATH = path.join(ROOT_DIR, 'config', 'storage-state.json');
const FILLABLE_FIELDS_PATH = path.join(OUTPUT_DIR, 'fillable-fields.csv');

require('dotenv').config({ path: ENV_PATH });

const args = new Set(process.argv.slice(2));
const saveStorage = args.has('--save-storage');
const useStorage = args.has('--use-storage');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function warnIfEnvMissing() {
  if (!fs.existsSync(ENV_PATH)) {
    console.warn(`No .env file found at ${ENV_PATH}. The script will use config/pages.json and manual login.`);
    console.warn('Create .env from .env.example if you want to preload Queue-it URLs or login fields.');
  }
}

function slugify(value) {
  return String(value || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  const resolvedBaseUrl = process.env.QUEUEIT_BASE_URL || parsed.baseUrl;
  const resolvedLoginUrl = process.env.QUEUEIT_LOGIN_URL || parsed.loginUrl || resolvedBaseUrl;

  if (!resolvedBaseUrl || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error('Set QUEUEIT_BASE_URL in .env or provide baseUrl in config/pages.json, plus a non-empty pages array.');
  }

  return {
    ...parsed,
    baseUrl: resolvedBaseUrl,
    loginUrl: resolvedLoginUrl,
  };
}

async function tryFill(locator, value) {
  if (!value || !await locator.count()) return false;
  try {
    await locator.first().fill(value, { timeout: 1500 });
    return true;
  } catch (error) {
    return false;
  }
}

async function tryClick(locator) {
  if (!await locator.count()) return false;
  try {
    await locator.first().click({ timeout: 1500 });
    return true;
  } catch (error) {
    return false;
  }
}

async function prefillLogin(page) {
  const customerAccountId = process.env.QUEUEIT_CUSTOMER_ACCOUNT_ID;
  const email = process.env.QUEUEIT_EMAIL;
  const password = process.env.QUEUEIT_PASSWORD;

  if (customerAccountId) {
    const filledCustomerId = await tryFill(
      page.locator([
        'input[name*="customer" i]',
        'input[id*="customer" i]',
        'input[placeholder*="customer" i]',
        'input[aria-label*="customer" i]',
        'input[type="text"]',
      ].join(', ')),
      customerAccountId,
    );

    if (filledCustomerId) {
      await tryClick(page.getByRole('button', { name: /continue/i }));
      await page.waitForTimeout(1000);
    }
  }

  if (email) {
    await tryFill(
      page.locator([
        'input[type="email"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
        'input[placeholder*="email" i]',
        'input[aria-label*="email" i]',
      ].join(', ')),
      email,
    );
  }

  if (password) {
    await tryFill(page.locator('input[type="password"]'), password);
  }
}

async function waitForManualLogin(page, loginUrl) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await prefillLogin(page);
  console.log('');
  console.log('Log in to Queue-it in the opened browser window.');
  console.log('If .env values were provided, the script may prefill Customer Account ID, Email, or Password when possible.');
  console.log('After login is complete and you can access admin pages, press Enter here to continue.');

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function openHiddenSections(page, pageConfig) {
  const selectors = pageConfig.expandSelectors || [];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(500);
      } catch (error) {
        console.warn(`Could not click expand selector "${selector}": ${error.message}`);
      }
    }
  }
}

async function collectFields(page) {
  return await page.evaluate(() => {
    const FIELD_SELECTOR = [
      'input',
      'textarea',
      'select',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[contenteditable="true"]',
    ].join(', ');

    const getLabelText = (el) => {
      const parts = [];
      const id = el.getAttribute('id');

      if (id) {
        const explicit = document.querySelector(`label[for="${id}"]`);
        if (explicit && explicit.innerText.trim()) parts.push(explicit.innerText.trim());
      }

      const wrappingLabel = el.closest('label');
      if (wrappingLabel && wrappingLabel.innerText.trim()) parts.push(wrappingLabel.innerText.trim());

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) parts.push(ariaLabel.trim());

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((ref) => document.getElementById(ref)?.innerText?.trim())
          .filter(Boolean)
          .join(' ');
        if (text) parts.push(text);
      }

      const nearby = el.closest('[class*="form"], [class*="field"], [class*="setting"], [role="group"]');
      if (nearby) {
        const heading = nearby.querySelector('h1, h2, h3, h4, h5, h6, legend, .label, .title');
        if (heading && heading.innerText.trim()) parts.push(heading.innerText.trim());
      }

      const unique = [...new Set(parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean))];
      return unique.join(' | ');
    };

    const getVisibleText = (el) => el.innerText ? el.innerText.replace(/\s+/g, ' ').trim() : '';

    const getSectionText = (el) => {
      const container = el.closest('section, fieldset, [class*="section"], [class*="panel"], [class*="card"]');
      if (!container) return '';
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6, legend');
      return heading ? heading.innerText.trim() : '';
    };

    const getOptionsSummary = (el, role, tagName) => {
      if (tagName === 'select') {
        return [...el.options].map((option) => option.textContent.trim()).filter(Boolean).join(' | ');
      }

      if (role === 'combobox') {
        const listboxId = el.getAttribute('aria-controls');
        const listbox = listboxId ? document.getElementById(listboxId) : null;
        if (listbox) {
          return [...listbox.querySelectorAll('[role="option"]')]
            .map((option) => option.innerText.trim())
            .filter(Boolean)
            .join(' | ');
        }
      }

      return '';
    };

    const getSelectorHint = (el) => {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
      if (el.getAttribute('role')) return `[role="${el.getAttribute('role')}"]`;
      return el.tagName.toLowerCase();
    };

    const elements = [...document.querySelectorAll(FIELD_SELECTOR)];
    const rows = [];
    const seen = new Set();

    for (const el of elements) {
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const inputType = el.getAttribute('type') || '';
      const label = getLabelText(el) || el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '(unlabelled field)';
      const section = getSectionText(el);
      const isVisible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      let value = '';
      if (tagName === 'input') {
        if (inputType === 'checkbox' || inputType === 'radio') {
          value = el.checked ? 'true' : 'false';
        } else {
          value = el.value || '';
        }
      } else if (tagName === 'textarea' || tagName === 'select') {
        value = el.value || '';
      } else if (role === 'switch') {
        const checked = el.getAttribute('aria-checked');
        value = checked === 'true' ? 'true' : checked === 'false' ? 'false' : el.innerText.trim();
      } else if (role === 'checkbox' || role === 'radio') {
        const checked = el.getAttribute('aria-checked');
        value = checked === 'true' ? 'true' : checked === 'false' ? 'false' : getVisibleText(el);
      } else if (role === 'combobox') {
        value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-label') || getVisibleText(el);
      } else {
        value = el.innerText.trim();
      }

      const selectorHint = getSelectorHint(el);
      const optionsSummary = getOptionsSummary(el, role, tagName);
      const key = [section, label, selectorHint].join('||');
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        section,
        label,
        value,
        controlType: role || tagName,
        inputType,
        visible: isVisible,
        selectorHint,
        optionsSummary,
        fillable: true,
      });
    }

    return rows;
  });
}

async function collectNavigation(page) {
  return await page.evaluate(() => {
    const navCandidates = [
      ...document.querySelectorAll('nav a, nav button, [role="tab"], [role="navigation"] a, [role="navigation"] button'),
    ];

    const items = navCandidates
      .map((el) => ({
        text: el.innerText ? el.innerText.replace(/\s+/g, ' ').trim() : '',
        role: el.getAttribute('role') || '',
        href: el.getAttribute('href') || '',
        ariaCurrent: el.getAttribute('aria-current') || '',
      }))
      .filter((item) => item.text);

    const deduped = [];
    const seen = new Set();
    for (const item of items) {
      const key = [item.text, item.href, item.role].join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  });
}

async function navigateToConfiguredPage(page, config, pageConfig) {
  if (pageConfig.clickText) {
    const role = pageConfig.clickRole || 'link';
    const exact = pageConfig.clickExact !== false;
    const candidates = [];

    if (role === 'tab' || role === 'any') {
      candidates.push(page.getByRole('tab', { name: pageConfig.clickText, exact }));
    }
    if (role === 'link' || role === 'any') {
      candidates.push(page.getByRole('link', { name: pageConfig.clickText, exact }));
    }
    if (role === 'button' || role === 'any') {
      candidates.push(page.getByRole('button', { name: pageConfig.clickText, exact }));
    }

    candidates.push(page.locator(`text="${pageConfig.clickText}"`));

    for (const locator of candidates) {
      if (!await locator.count()) continue;
      try {
        await locator.first().click({ timeout: 3000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(pageConfig.waitAfterLoadMs || 1500);
        return page.url();
      } catch (error) {
        // Try the next candidate.
      }
    }

    throw new Error(`Could not navigate using clickText "${pageConfig.clickText}" for page "${pageConfig.label}".`);
  }

  if (!pageConfig.path) {
    throw new Error(`Page "${pageConfig.label}" is missing both path and clickText.`);
  }

  const pageUrl = new URL(pageConfig.path, config.baseUrl).toString();
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(pageConfig.waitAfterLoadMs || 1500);
  return pageUrl;
}

function writeCsv(filePath, pageConfig, pageUrl, rows) {
  const header = [
    'section',
    'navigationPath',
    'pageLabel',
    'pageUrl',
    'fieldLabel',
    'value',
    'controlType',
    'inputType',
    'visible',
    'selectorHint',
    'optionsSummary',
    'fillable',
    'notes',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      csvEscape(row.section),
      csvEscape(pageConfig.navigationPath || ''),
      csvEscape(pageConfig.label || ''),
      csvEscape(pageUrl),
      csvEscape(row.label),
      csvEscape(row.value),
      csvEscape(row.controlType),
      csvEscape(row.inputType),
      csvEscape(row.visible),
      csvEscape(row.selectorHint),
      csvEscape(row.optionsSummary),
      csvEscape(row.fillable),
      csvEscape(pageConfig.notes || ''),
    ].join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function writeFillableFieldsCsv(filePath, rows) {
  const header = [
    'pageLabel',
    'navigationPath',
    'pageUrl',
    'section',
    'fieldLabel',
    'value',
    'controlType',
    'inputType',
    'optionsSummary',
    'selectorHint',
    'screenshot',
    'notes',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      csvEscape(row.pageLabel),
      csvEscape(row.navigationPath),
      csvEscape(row.pageUrl),
      csvEscape(row.section),
      csvEscape(row.fieldLabel),
      csvEscape(row.value),
      csvEscape(row.controlType),
      csvEscape(row.inputType),
      csvEscape(row.optionsSummary),
      csvEscape(row.selectorHint),
      csvEscape(row.screenshot),
      csvEscape(row.notes),
    ].join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

async function main() {
  ensureDir(SCREENSHOT_DIR);
  ensureDir(DATA_DIR);
  warnIfEnvMissing();

  const config = loadConfig();
  const browser = await chromium.launch({ headless: false });
  const contextOptions = useStorage && fs.existsSync(STORAGE_STATE_PATH)
    ? { storageState: STORAGE_STATE_PATH }
    : {};
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  if (!useStorage || !fs.existsSync(STORAGE_STATE_PATH)) {
    await waitForManualLogin(page, config.loginUrl);
  }

  const indexRows = [];
  const fillableFields = [];

  for (let i = 0; i < config.pages.length; i += 1) {
    const pageConfig = config.pages[i];
    const order = String(i + 1).padStart(2, '0');
    const fileBase = `${order}-${slugify(pageConfig.label)}`;

    console.log(`Capturing ${pageConfig.label}`);
    const pageUrl = await navigateToConfiguredPage(page, config, pageConfig);
    await openHiddenSections(page, pageConfig);

    const screenshotPath = path.join(SCREENSHOT_DIR, `${fileBase}.png`);
    const jsonPath = path.join(DATA_DIR, `${fileBase}.json`);
    const csvPath = path.join(DATA_DIR, `${fileBase}.csv`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const fields = await collectFields(page);
    const navigation = await collectNavigation(page);

    const data = {
      capturedAt: new Date().toISOString(),
      label: pageConfig.label,
      navigationPath: pageConfig.navigationPath || '',
      pageUrl,
      notes: pageConfig.notes || '',
      navigation,
      fields,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    writeCsv(csvPath, pageConfig, pageUrl, fields);

    for (const field of fields.filter((item) => item.fillable)) {
      fillableFields.push({
        pageLabel: pageConfig.label,
        navigationPath: pageConfig.navigationPath || '',
        pageUrl,
        section: field.section,
        fieldLabel: field.label,
        value: field.value,
        controlType: field.controlType,
        inputType: field.inputType,
        optionsSummary: field.optionsSummary,
        selectorHint: field.selectorHint,
        screenshot: path.relative(ROOT_DIR, screenshotPath),
        notes: pageConfig.notes || '',
      });
    }

    indexRows.push({
      order,
      label: pageConfig.label,
      navigationPath: pageConfig.navigationPath || '',
      pageUrl,
      screenshot: path.relative(ROOT_DIR, screenshotPath),
      csv: path.relative(ROOT_DIR, csvPath),
      json: path.relative(ROOT_DIR, jsonPath),
      notes: pageConfig.notes || '',
    });
  }

  const indexCsvPath = path.join(OUTPUT_DIR, 'index.csv');
  const indexHeader = ['order', 'label', 'navigationPath', 'pageUrl', 'screenshot', 'csv', 'json', 'notes'];
  const indexLines = [indexHeader.join(',')];
  for (const row of indexRows) {
    indexLines.push([
      csvEscape(row.order),
      csvEscape(row.label),
      csvEscape(row.navigationPath),
      csvEscape(row.pageUrl),
      csvEscape(row.screenshot),
      csvEscape(row.csv),
      csvEscape(row.json),
      csvEscape(row.notes),
    ].join(','));
  }
  fs.writeFileSync(indexCsvPath, indexLines.join('\n'), 'utf8');
  writeFillableFieldsCsv(FILLABLE_FIELDS_PATH, fillableFields);

  if (saveStorage) {
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Saved login state to ${STORAGE_STATE_PATH}`);
  }

  console.log(`Archive complete. Output saved to ${OUTPUT_DIR}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
