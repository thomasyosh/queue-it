const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = process.cwd();
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'pages.json');
const OUTPUT_DIR = path.join(ROOT_DIR, 'archive-output');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');
const DATA_DIR = path.join(OUTPUT_DIR, 'data');
const STORAGE_STATE_PATH = path.join(ROOT_DIR, 'config', 'storage-state.json');

const args = new Set(process.argv.slice(2));
const saveStorage = args.has('--save-storage');
const useStorage = args.has('--use-storage');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

  if (!parsed.baseUrl || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error('config/pages.json must contain baseUrl and a non-empty pages array.');
  }

  return parsed;
}

async function waitForManualLogin(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  console.log('');
  console.log('Log in to Queue-it in the opened browser window.');
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

    const getSectionText = (el) => {
      const container = el.closest('section, fieldset, [class*="section"], [class*="panel"], [class*="card"]');
      if (!container) return '';
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6, legend');
      return heading ? heading.innerText.trim() : '';
    };

    const elements = [...document.querySelectorAll('input, textarea, select, [role="switch"], [contenteditable="true"]')];
    const rows = [];

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
      } else {
        value = el.innerText.trim();
      }

      rows.push({
        section,
        label,
        value,
        controlType: role || tagName,
        inputType,
        visible: isVisible,
      });
    }

    return rows;
  });
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
      csvEscape(pageConfig.notes || ''),
    ].join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

async function main() {
  ensureDir(SCREENSHOT_DIR);
  ensureDir(DATA_DIR);

  const config = loadConfig();
  const browser = await chromium.launch({ headless: false });
  const contextOptions = useStorage && fs.existsSync(STORAGE_STATE_PATH)
    ? { storageState: STORAGE_STATE_PATH }
    : {};
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  if (!useStorage || !fs.existsSync(STORAGE_STATE_PATH)) {
    await waitForManualLogin(page, config.baseUrl);
  }

  const indexRows = [];

  for (let i = 0; i < config.pages.length; i += 1) {
    const pageConfig = config.pages[i];
    const order = String(i + 1).padStart(2, '0');
    const fileBase = `${order}-${slugify(pageConfig.label)}`;
    const pageUrl = new URL(pageConfig.path, config.baseUrl).toString();

    console.log(`Capturing ${pageConfig.label} -> ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(pageConfig.waitAfterLoadMs || 1500);
    await openHiddenSections(page, pageConfig);

    const screenshotPath = path.join(SCREENSHOT_DIR, `${fileBase}.png`);
    const jsonPath = path.join(DATA_DIR, `${fileBase}.json`);
    const csvPath = path.join(DATA_DIR, `${fileBase}.csv`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const fields = await collectFields(page);

    const data = {
      capturedAt: new Date().toISOString(),
      label: pageConfig.label,
      navigationPath: pageConfig.navigationPath || '',
      pageUrl,
      notes: pageConfig.notes || '',
      fields,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    writeCsv(csvPath, pageConfig, pageUrl, fields);

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
