# Queue-it Capture Checklist

Use this checklist while you are still subscribed to Queue-it.

## Before capture

- Confirm which Queue-it admin areas are business-critical.
- Make sure you can log in with an account that can view all settings.
- Decide where the final archive folder will be stored.
- Update `config/pages.json` with the exact admin URLs or paths for each important page.
- Add extra entries for every tab, modal-driven page, and settings area that matters for rebuild.

## During capture

- Log in and verify the correct environment or tenant is open.
- Expand collapsed sections before capturing.
- Open each important tab that is hidden behind secondary navigation.
- Capture one full-page screenshot per page.
- Focus especially on fields a future user would need to type, select, toggle, or re-enter manually.
- Capture extra screenshots for modals, dropdown menus, or flyouts that contain values not visible in the full page.
- Review each generated CSV or JSON file for missing labels or values.
- Manually record fields that are rendered in a non-standard way.

## Priority areas to document

- General configuration
- Waiting room rules
- Traffic / throttling settings
- Event timing and activation rules
- Target URLs and redirect rules
- Bypass / allow list logic
- Branding, messaging, and localization
- Integrations, tags, scripts, or webhooks
- Any custom queue or event pages

## After capture

- Open `archive-output/index.csv` and verify every important page is listed.
- Open `archive-output/fillable-fields.csv` and use it as the main rebuild reference sheet.
- Compare the archive against the admin navigation and confirm nothing was skipped.
- Copy missing values into `templates/queueit-settings-template.csv` or your team spreadsheet.
- Zip the whole project folder for long-term storage.
- Save a second copy in a shared company location.
