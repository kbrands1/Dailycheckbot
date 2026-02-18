# Daily Check-in Bot

Google Chat bot for daily team check-ins and EOD reports.

## Development Workflow

### 1. Local Development
All Apps Script files are located in the `script/` directory.

### 2. Pushing Changes to Google Apps Script (Clasp)
Before deploying, always push your local changes to the Apps Script project:

```powershell
cd script
clasp push
```

### 3. Deploying a New Version
To make your changes live in Google Chat:

```powershell
# 1. Create a new version
clasp version "Summary of changes"

# 2. Deploy using the established Deployment ID
clasp deploy -i AKfycbwf9nAwRSz7FZaytfRPUB7picL7KDW4QbBlEIdQsf1v-z-k6MARY-fZ-7pDEKYXEHlu -V <version_number> 
```

### 4. Git Workflow
To sync changes with GitHub:

```powershell
git add *
git commit -m "Your commit message"
git push -u origin main
```

## Technical Notes
- **Response Format**: This bot operates as a Workspace Add-on. All trigger responses (`onMessage`, `onAddToSpace`, etc.) must be wrapped using the `createChatResponse()` helper found in `Utils.js`.
- **Manifest**: The `appsscript.json` contains mandatory `addOns` and `chat` blocks for Google Chat integration.
