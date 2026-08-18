# Queue-it Config Archiver

This project archives Queue-it admin settings so your team can rebuild the current configuration later if needed.

It produces:

- full-page screenshots for each important settings page
- a JSON export of detected field labels and values
- a CSV export for easier review in Excel
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

## Configure the pages to capture

Edit `config/pages.json` and replace the sample entries with your real Queue-it admin pages.

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
- If a page has collapsible sections, you can add `expandSelectors`.

Example:

```json
{
  "label": "Branding",
  "path": "/admin/events/123/branding",
  "navigationPath": "Events > Summer Sale > Branding",
  "expandSelectors": [
    "[data-testid='advanced-settings-toggle']",
    "button[aria-controls='localization-panel']"
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
2. You log in to Queue-it manually.
3. After login is complete, return to the terminal and press Enter.
4. The script visits each configured page, takes a full-page screenshot, and exports field data.
5. Your login session is saved in `config/storage-state.json`.

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
- `archive-output/index.csv`

## Recommended operating process

Use the script for the main archive, then review the output and manually fill any gaps:

1. Capture all important Queue-it pages with the script.
2. Review the generated CSV files in Excel.
3. Add missing modal-only or custom-widget values to `templates/queueit-settings-template.csv` or your internal spreadsheet.
4. Zip the entire project folder and store it in your company archive.

## Known limitations

- Some custom UI controls may not expose values in standard HTML fields.
- Hidden modal content is only captured if opened before the screenshot.
- Pages behind multi-step navigation may need their own URL entries.
- Extremely dynamic pages may need a longer `waitAfterLoadMs` value in `config/pages.json`.
