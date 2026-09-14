---
date: 2026-09-14
status: accepted
---

# Translate names with gpt-6-astra and a prompt composed per script

## Context

`AiTranslatorService` transliterates and translates non-Latin city and creator names through the OpenAI Responses API, about sixty calls a month, each in a background task.
At that volume every candidate model costs well under a dollar a month, so quality decides.
The live alternatives: gpt-5.4 (the previous model), gpt-5.6-terra, or gpt-6-astra; and one prompt whose rules for every language reach every name, or rules added per script.

## Decision

The translator uses gpt-6-astra at medium reasoning effort, with shared rules plus a rule block for each script the name uses (Chinese characters, kana, hangul, Cyrillic and Greek), picked by `AiTranslatorService.selectScriptRules()`.
Given the same explicit prompt, astra followed its rules most consistently: terra dropped capitalization and returned an invalid locale, and gpt-5.4 romanized inside emoticons and flipped answers between near-identical prompts.
Per-script blocks keep one language's rules, such as Chinese digit spacing or capitalization, from bending another's.

## Consequences

- The prompts are tuned against a benchmark. A wording change is judged on a fresh random holdout of real names from the dev database, by a reviewer that never sees stored translations (earlier GPT outputs, which anchor judgment), plus a pinyin tone check with pypinyin; then `mise test:openai`.
- Prompt caching does not apply: the prompt stays under the 1,024-token minimum of GPT-5.6 and later, calls arrive hours apart while a cached prefix lives 30 minutes, and cache writes cost 1.25 times input. Flex processing (`service_tier: 'flex'`) halves the price of a bulk re-translation.
