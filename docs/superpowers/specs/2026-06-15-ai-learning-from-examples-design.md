# AI Learning From Examples (Few-Shot) — Design

Date: 2026-06-15

## Goal

Make shortcut suggestions improve over time by letting the system accumulate
real `(customer message → chosen shortcut)` examples from the shop's own usage,
and feeding the most similar past examples into the AI prompt as few-shot
guidance. The OpenAI model itself is not retrained — the "learning" is the
system accumulating and reusing examples.

## Decisions (from user)

- **When to record:** Automatically when a shortcut is sent/filled, PLUS a 👎
  button to delete a wrong example.
- **How to pick examples for the prompt:** Keyword similarity (free, no extra
  API call), top-N most similar.

## Components

### 1. Storage (`store.js`)
- New file `examples.json` holding `{ items: [...] }`.
- Each example: `{ id, message, shortcut, intent, createdAt }`.
- Functions: `getExamples()`, `appendExample(entry)`, `deleteExample(id)`,
  `clearExamples()`.
- Cap at 500 newest items to bound file size; dedupe identical
  `(message, shortcut)` pairs (refresh timestamp instead of duplicating).

### 2. Similarity selection (`shortcutMatcher.js`)
- New `findSimilarExamples(message, examples, limit = 6)`:
  reuse `normalizeText` + word-overlap scoring (same idea as `scoreShortcut`),
  return the top-N examples most similar to the current message.

### 3. Prompt (`ai.js`)
- `buildPrompt` gains an optional `examples` arg. When present, render a
  "VÍ DỤ ĐÃ HỌC" block listing past `message → shortcut` pairs so the model
  mimics the shop's real choices.
- `analyzeMessageWithAI` accepts `examples` and forwards similar ones.

### 4. API (`index.js`)
- `POST /api/examples` — record `{ message, shortcut, intent }`.
- `GET /api/examples` — list (for UI + management).
- `DELETE /api/examples/:id` — remove a wrong example (👎).
- `POST /api/examples/clear` — wipe all.
- `analyze-message` route loads examples and passes them to the analyzer.

### 5. Frontend (`app.js` + `index.html`)
- After a shortcut is sent (bot auto-send) or filled (manual), POST to
  `/api/examples` recording the pair.
- Add a 👎 button on each AI suggestion result so the user can mark the last
  recorded example as wrong → DELETE it.
- A small "Đã học N ví dụ" counter in the AI tab.

## Error handling
- All example operations are best-effort: a failure to record/learn must never
  break the bot loop or the analyze flow (wrap in try/catch, log only).

## Testing
- Unit-check `findSimilarExamples` ranking with a few crafted messages.
- Verify `analyze-message` still works when `examples.json` is empty.
