# CardInject

A SillyTavern extension that uses AI to analyze your character card and automatically inject categorized content into the right places in the prompt.

---

## What it does

CardInject reads your character's card (description, personality, scenario, example messages, system prompt, post-history instructions), sends it to your currently connected AI for analysis, and breaks it down into logical categories — each injected into a different position in the prompt so the AI always has the right context at the right time.

---

## Installation

1. In SillyTavern, go to **Extensions → Install extension**
2. Paste the repository URL
3. Click Install

---

## Usage

1. Open a character chat
2. Go to **Extensions → CardInject**, or find it in the extensions wand menu
3. Click **AI로 캐시트 분석하기** (Analyze with AI)
4. Wait for analysis to complete — a list of categories will appear
5. Adjust positions or toggle categories as needed
6. Click **주입 적용** (Apply injections)

Injections are re-applied automatically on every generation. You don't need to click Apply again unless you change settings.

---

## Injection positions

| Position | Where it lands |
|---|---|
| 🔝 System top | Above everything — before the main system prompt |
| 💬 Above recent messages (depth 2) | Inside chat history, just above the last 2 messages |
| 📝 Author's Note | Merged directly into the Author's Note text |

---

## Notes

- **Character-specific**: each character has its own independent set of categories. Switching characters automatically switches the active injections.
- **Author's Note position** requires an Author's Note to be set in the chat. If none is found, it falls back to a depth-based approximation.
- During analysis, the AI briefly sends a message — this is normal and gets cleaned up automatically. Do not cancel during this step.
- Connection profiles (if available) can be switched from the extension panel.

---

## Requirements

- SillyTavern (any recent build)
- An active AI connection

---

## Author

혜담
