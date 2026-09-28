# Privacy Policy — Inoriginal Subtitle Translator

_Last updated: 2026-09-28_

This extension does not collect, sell, or share personal data, and it has no
servers of its own.

## What is sent over the network

When you click a word or select a phrase in subtitles on inoriginal.cc, the
selected text (and nothing else) is sent to the translation services needed to
answer the lookup:

- **Google Translate** (`translate.googleapis.com`) — always.
- **DeepL** (`api.deepl.com` / `api-free.deepl.com`) — only if you entered your
  own DeepL API key. The key is sent to DeepL to authenticate the request.
- **Free Dictionary API** (`api.dictionaryapi.dev`) — for single English words.

These requests are subject to the respective providers' privacy policies.

## What is stored locally

- Your saved vocabulary (words, translations, subtitle context, page URL, and
  review progress) is stored in `chrome.storage.local` on your device.
- Settings (target language, pause-on-click, DeepL API key) are stored in
  `chrome.storage.sync`, which Chrome may sync between your own signed-in
  browsers.

You can delete your vocabulary from the vocabulary page at any time, and
removing the extension deletes all of its stored data.

## Contact

Questions: open an issue in this project's GitHub repository.
