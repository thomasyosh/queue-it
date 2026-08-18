# Queue-it Config Archiver

This project archives Queue-it admin settings so your team can rebuild the current configuration later if needed.

It produces:

- full-page screenshots for each important settings page
- a JSON export of detected field labels and values
- a CSV export for easier review in Excel
- a master `fillable-fields.csv` focused on fields a future user may need to re-enter
- a master `index.csv` linking each page to its screenshot and data files

## Folder layout

- `config/pages.json`: list of Queue-it pages to capture
- `scripts/capture-queueit.js`: Playwright capture script
- `templates/queueit-settings-template.csv`: manual backup template for missing fields
- `docs/capture-checklist.md`: capture process checklist
- `archive-output/`: generated screenshots and data files

## Setup

Install browser binaries once:

```powershell
npx playwright install chromium
```

Create a local `.env` file from `.env.example` and fill in your preferred values:

```powershell
Copy-Item .env.example .env
```

Supported `.env` values:

- `QUEUEIT_BASE_URL`
- `QUEUEIT_LOGIN_URL`
- `QUEUEIT_CUSTOMER_ACCOUNT_ID`
- `QUEUEIT_EMAIL`
- `QUEUEIT_PASSWORD`

The `.env` file is gitignored.

## Configure the pages to capture

Edit `config/pages.json` and replace the sample entries with your real Queue-it admin pages.

You can keep `baseUrl` and `loginUrl` in `config/pages.json`, but `.env` values take priority if both are set.

Example:

```json
{
  "baseUrl": "https://go.queue-it.net/",
  "pages": [
    {
      "label": "Event Config",
      "path": "/admin/events/123/settings",
      "navigationPath": "Events > Summer Sale > Settings",
      "notes": "Main event traffic controls"
    }
  ]
}
```

Tips:

- Use a separate entry for each important tab or form.
- Add entries for pages that require separate URLs.
- If a page is easier to reach by clicking a visible nav tab, use `clickText` instead of `path`.
- If a page has inner tabs or subpages, add them under `children` so the script captures both the parent tab and each nested page.
- If a page has collapsible sections, you can add `expandSelectors`.

Example:

```json
{
  "label": "Manage",
  "clickText": "Manage",
  "clickRole": "any",
  "children": [
    {
      "label": "Branding",
      "clickText": "Branding",
      "clickRole": "any",
      "navigationPath": "Manage > Branding",
      "expandSelectors": [
        "[data-testid='advanced-settings-toggle']",
        "button[aria-controls='localization-panel']"
      ]
    }
  ]
}
```

## Run the capture

First run, with manual login and saved session:

```powershell
npm run capture:save
```

What happens:

1. Chromium opens.
2. The script opens the Queue-it login page from `.env` or `config/pages.json`.
3. If `.env` contains login details, the script will try to prefill them when the page structure allows it.
4. Complete any remaining login steps manually.
5. After login is complete, return to the terminal and press Enter.
6. The script visits each configured page, takes a full-page screenshot, records navigation items, and exports fillable field data.
7. Your login session is saved in `config/storage-state.json`.

Later runs, reusing the saved session:

```powershell
npm run capture:resume
```

One-off run without saving the session:

```powershell
npm run capture
```

## Output

After a successful run, check:

- `archive-output/screenshots/`
- `archive-output/data/`
- `archive-output/fillable-fields.csv`
- `archive-output/index.csv`

## Recommended operating process

Use the script for the main archive, then review the output and manually fill any gaps:

1. Capture all important Queue-it pages with the script.
2. Review `archive-output/fillable-fields.csv` first, because it is the main rebuild worksheet.
3. Add missing modal-only or custom-widget values to `templates/queueit-settings-template.csv` or your internal spreadsheet.
4. Zip the entire project folder and store it in your company archive.

## Known limitations

- Some custom UI controls may not expose values in standard HTML fields.
- Hidden modal content is only captured if opened before the screenshot.
- Pages behind multi-step navigation may need their own URL entries.
- Extremely dynamic pages may need a longer `waitAfterLoadMs` value in `config/pages.json`.
