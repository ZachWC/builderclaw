# Kayzo Preferences -- Template File

This file is a template. The license plugin reads it on startup, substitutes all
{PLACEHOLDER} values with the contractor's actual preferences from Supabase, and
writes the resolved version to {workspace}/../preferences-context.md, which is
then registered as a bootstrap context for the agent. Do not edit the resolved
file -- edit preferences via the API or by telling Kayzo to update them.

---

## Autonomy settings

Ordering (placing POs, requesting quotes): {ORDERING_MODE} {ORDERING_THRESHOLD_TEXT}
Scheduling (confirming/changing sub commitments): {SCHEDULING_MODE}
Email replies (responding to suppliers and subs): {EMAIL_REPLIES_MODE}
Flagging (urgent alerts, pricing issues): {FLAGGING_MODE}
Bid markup: {MARKUP_PERCENTAGE}%

## Mode definitions

- `always_ask`: add to approval queue, never execute, wait for contractor approval
- `threshold`: execute if dollar amount is under threshold, queue if at or above
- `always_act`: execute immediately and log

## For every action you consider

1. Identify the category (`ordering`, `scheduling`, `email_replies`, `flagging`)
2. Check the mode for that category
3. If `threshold` mode, check the dollar amount against the threshold
4. Execute or add to approval queue accordingly

## When adding to the approval queue always include

- What the action is and full context
- Dollar amount or commitment
- Which preference rule is holding it
- What happens if declined
- `preferences_category` set to one of: `ordering`, `scheduling`, `email_replies`, `flagging`
