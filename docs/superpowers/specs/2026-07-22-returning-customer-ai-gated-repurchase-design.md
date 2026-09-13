# AI-gated repurchase flow for returning customers

## Scope

This change applies only to customers whose active tags match the approved returning-customer tag groups: `Nhận Saruto…`, `Đã nhận TRÀ…`, or a tag name containing `Trống`. Customers without an eligible tag keep the existing behavior unchanged.

## Decision flow

1. After opening an unread conversation, the bot reads the current active tags and up to five recent messages.
2. The current customer message always has priority over older history. History is used only when the current message is empty.
3. Non-text, complaints, refusals, cancellations, and contact-only messages take the existing safe skip/review path.
4. A deterministic rule marks whether the message is a credible repurchase candidate. Candidates include explicit buying, quantity orders, sending again, delivery to the old address, and short confirmations such as `ok`, `oke`, or `oki`.
5. AI must analyze the current message and recent history before any reply or escalation decision.
6. `TAG_BUY_AND_MARK_UNREAD` is allowed only when both conditions are true:
   - the deterministic rule identifies a repurchase candidate; and
   - AI returns `REPURCHASE_INTENT` with `TAG_BUY_AND_MARK_UNREAD` at or above `settings.minConfidence`.
7. Short confirmations are not sufficient by themselves. AI must find a preceding admin offer or order-closing message in the recent history.
8. If AI confidently determines that the safe message is not a repurchase, the bot selects the configured `/32` sale shortcut.
9. If `/32` is missing, AI fails, JSON is invalid, confidence is too low, or the result is ambiguous, the conversation enters review without sending, tagging, or marking unread.

## Safety constraints

- AI cannot create a repurchase escalation when the deterministic rule did not identify a candidate.
- Deterministic rules cannot create a repurchase escalation without AI confirmation.
- Negative, complaint, and cancellation markers are evaluated before positive purchase signals.
- A current sticker or other non-text message cannot replay an older purchase message from history.
- The existing final-admin sender guard remains authoritative before sending `/32`.
- `/32` must exist in the imported shortcut list; the bot never invents replacement text.

## Responses

Confirmed repurchase:

```json
{
  "intent": "REPURCHASE_INTENT",
  "action": "TAG_BUY_AND_MARK_UNREAD",
  "bestShortcut": null,
  "confidence": 0.9,
  "repurchase": {
    "matchedTags": ["Nhận Saruto 1"],
    "evidence": "rule_and_ai"
  }
}
```

Safe non-repurchase:

```json
{
  "intent": "RETURNING_CUSTOMER_FOLLOWUP",
  "action": "SUGGEST_SHORTCUT",
  "bestShortcut": "/32",
  "confidence": 0.9
}
```

## Verification

- Explicit purchase candidate plus positive AI confirmation escalates.
- The same candidate with low-confidence, invalid, or negative AI output does not escalate.
- `ok`, `oke`, and `oki` require a preceding admin purchase offer.
- Safe non-repurchase content selects `/32` after AI analysis.
- Complaints, refusals, contact-only messages, and non-text content never use `/32` or repurchase escalation.
- Missing `/32` enters review.
- Auto-send on sends `/32`; Auto-send off only fills it.
- Customers without eligible returning tags retain their current behavior.
