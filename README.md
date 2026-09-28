# Inoriginal Subtitle Translator

Click any word or select a phrase in subtitles on **inoriginal.cc** to see
translations from multiple sources, save them to your vocabulary, and review
with flashcards.

## Install

- **Chrome Web Store** — once published, install from the store page.
- **From a release** — download the zip from
  [Releases](../../releases), unzip it, then `chrome://extensions` →
  **Developer mode** → **Load unpacked** → select the unzipped folder.

## Development

Requires Node.js 22 (see `.nvmrc`).

```sh
npm install
npm run lint     # ESLint
npm run build    # -> dist/inoriginal-subtitle-translator-<version>.zip
npm run icons    # regenerate src/icons/*.png
```

To run from source: `chrome://extensions` → **Developer mode** →
**Load unpacked** → select the `src/` folder. After changes, click the reload
icon on the extension card, then **F5** the page with the video player.

### Project layout

```
src/                 extension sources (this folder is what gets packaged)
  manifest.json
  background.js      service worker: translation providers + vocabulary storage
  content.js/.css    subtitle word wrapping and tooltip on inoriginal.cc
  subtitle-style.js  subtitle appearance settings (shared by content script and popup)
  text-utils.js      word cleanup / context highlighting (content script and vocab page)
  popup.*            toolbar popup (settings)
  vocab.*            vocabulary list and flashcard review page
  icons/
scripts/             build helpers (version sync, icon generator)
.github/workflows/   CI and release pipelines
```

## Releasing

The version lives in `package.json` and is copied into `src/manifest.json`
automatically by `npm version`.

```sh
npm version patch   # or minor / major — bumps both files, commits, tags vX.Y.Z
git push --follow-tags
```

Pushing the tag runs the **Release** workflow, which:

1. lints and builds the zip (and fails if the tag doesn't match the manifest);
2. creates a GitHub Release with the zip attached;
3. uploads and publishes it to the Chrome Web Store (if the secrets below are set).

Every push to `main` and every PR runs **CI** (lint + build) and keeps the zip
as a workflow artifact.

### Chrome Web Store setup (one-time)

1. Register a developer account at the
   [CWS Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   ($5 one-time fee).
2. Create the item manually the first time: run `npm run build`, upload the
   zip, fill in the listing (description, screenshots, category, privacy
   practices — link [PRIVACY.md](PRIVACY.md) as the privacy policy) and submit.
3. Get OAuth credentials by following
   [chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys).
4. Add repository secrets (**Settings → Secrets and variables → Actions**):

   | Secret              | Where to find it                                  |
   |---------------------|---------------------------------------------------|
   | `CWS_EXTENSION_ID`  | Item ID in the Developer Dashboard / store URL    |
   | `CWS_PUBLISHER_ID`  | Developer Dashboard → Account                     |
   | `CWS_CLIENT_ID`     | Google Cloud OAuth client                         |
   | `CWS_CLIENT_SECRET` | Google Cloud OAuth client                         |
   | `CWS_REFRESH_TOKEN` | Generated in step 3                               |

Until the secrets are set, releases are still created on GitHub and the
Chrome Web Store step is skipped with a warning.

## Features

- **Multi-provider lookup.** Each click hits multiple sources in parallel:
  - **Google** — fast, broad language coverage, always on.
  - **DeepL** — better for phrases and idioms. Free tier: 500k chars/month.
    Add your key via the extension popup → "Advanced".
  - **Dictionary** — English definitions, IPA and examples from Wiktionary via
    [freedictionaryapi.com](https://freedictionaryapi.com); pronunciation via
    the browser's speech synthesis. Single words only. Always on.
  Switch between sources with the tabs in the tooltip.
- **Click or select.** Single click on a word translates that word. Drag-select
  multiple words to translate as a phrase. Shift+click also extends selection.
- **Save to vocabulary.** Tooltip → "+ Save word" / "+ Save phrase". Full
  subtitle line is saved as context. If DeepL succeeded, its translation is
  preferred when saving.
- **Spaced repetition review.** Flashcard mode with Leitner-box intervals
  (1h → 1d → 3d → 7d → 14d → 30d).
- **Subtitle appearance.** Popup → "Subtitle appearance": font, size, text
  and background colour with opacity, bold, outline — with a live preview.
- **Instant play/pause.** The player normally waits ~0.35s after a click on
  the picture (to detect a double-click); the extension toggles right away.
  Double-click still switches fullscreen. Can be turned off in the popup.
- **Works in fullscreen.** Uses the Popover API top-layer so the tooltip
  appears even when the player is fullscreen.

## Getting a DeepL key (optional)

1. Sign up at https://www.deepl.com/pro-api (DeepL API Free tier)
2. Confirm email; the key appears in your account dashboard
3. Paste it into the extension popup → "Advanced: DeepL API key"

Free keys end with `:fx` and use a different API host — the extension
detects this automatically.

## Data

Everything is local. Translations go to whichever provider you've configured;
nothing else leaves your browser. On the vocabulary page, **Backup** downloads
a JSON file with all words and review progress, and **Restore** merges one
back in (for words in both, the most recently reviewed copy wins). **Export
CSV** is for spreadsheets and Anki import.

## Limitations

- No lemmatization. `running` is looked up as-is; the dictionary entries
  usually still surface the base form.
- Dictionary lookup is English-only by design.
- DeepL's free tier has rate limits — for heavy daily use, the Pro tier or
  Microsoft Translator (2M chars/month free, no expiry) may suit better.
