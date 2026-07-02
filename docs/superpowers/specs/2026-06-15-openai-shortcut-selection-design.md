# OpenAI Shortcut Selection Design

Date: 2026-06-15

## Goal

Replace Gemini with OpenAI as the only hosted AI provider for message analysis, while keeping the current bot behavior centered on selecting an existing Pancake shortcut `/n`.

## Scope

- Keep the existing `/api/ai/analyze-message` contract.
- Keep rule-based hard stops for phone, address, and high buy intent.
- Keep local validation so the AI can only return shortcuts that already exist.
- Prioritize response speed over richer generation quality.
- Do not add free-form customer reply generation.
- Do not keep Gemini as a fallback provider.

## Recommended Approach

Use the OpenAI Responses API from the server layer and keep the current prompt-and-JSON flow. This minimizes code churn, preserves the renderer and server route contracts, and keeps the current validation path intact.

## Architecture

- `src/server/ai.js` becomes the only place that talks to OpenAI.
- `src/server/index.js` continues calling `analyzeMessageWithAI(...)` without API changes.
- Hard classification still runs first.
- If the hard classification requires escalation, return immediately without calling OpenAI.
- Otherwise call OpenAI with a compact shortcut list and a strict JSON-only prompt.
- Parse the returned JSON, validate `bestShortcut`, validate `topSuggestions`, and return the normalized result.
- If OpenAI fails or returns invalid JSON, fall back to the existing local keyword-based matcher.

## Configuration

- Add `OPENAI_API_KEY`.
- Add `OPENAI_MODEL`.
- Remove runtime dependence on `GEMINI_API_KEY` and `GEMINI_MODEL`.
- Choose a speed-oriented default model when `OPENAI_MODEL` is not set.

## Error Handling

- Missing `OPENAI_API_KEY`: use local keyword fallback.
- OpenAI request failure: use local keyword fallback and include failure detail in the reason string.
- Invalid or incomplete OpenAI JSON: use local keyword fallback.
- Invalid shortcut returned by OpenAI: discard it through existing validators.

## Testing

- Syntax-check all touched server files.
- Verify `/api/ai/analyze-message` still returns a valid object shape.
- Verify shortcut outputs are still limited to known `/n` entries.
- Verify missing-key behavior falls back safely without crashing the app.

## Constraints And Assumptions

- Speed is more important than richer reasoning.
- The current shortcut-first workflow is intentional and should not change.
- The workspace is not currently a Git repository, so this spec cannot be committed here.
