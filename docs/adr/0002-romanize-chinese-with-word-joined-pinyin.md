---
date: 2026-09-14
status: accepted
---

# Romanize Chinese names with word-joined pinyin, per GB/T 16159-2012

## Context

The translator stores a transliteration for every non-Latin city and creator name, so players who cannot read the script know how it sounds.
For Chinese, a prompt asking for "tone marks, spaces and proper capitalization" gets either one word per syllable (`Guǎng Zhōu`) or pinyin words (`Guǎngzhōu`), and names stored before this decision mix both.
The live alternatives: one capitalized word per syllable, which maps one-to-one onto the characters and checks mechanically, or the official orthography.

## Decision

Chinese transliterations follow GB/T 16159-2012, the official pinyin orthography: the syllables of a word join, a place name's generic term stands apart (`Chángshā Shì`), a surname stands apart from the given name (`Dāo Guānzhì`), and an apostrophe precedes an a, o, or e syllable (`Xī'ān`).
Maps, signs, and passports write Chinese this way, and models produce it unprompted; the standard reserves syllable-by-syllable writing for literacy materials.

## Consequences

- Where words end in an invented name is the model's judgment, so segmentation can vary where per-syllable writing could not.
- Names translated earlier keep their mixed forms until re-translated.
- The live tests pin the form: `广州` becomes `Guǎngzhōu`.
