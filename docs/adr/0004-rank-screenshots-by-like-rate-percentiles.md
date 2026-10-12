---
date: 2026-10-13
status: accepted
---

# Rank screenshots by percentiles of their exact like rate, above a views and a likes floor

## Context

Each serialized screenshot carries a medal (Bronze, Silver, Gold, Platinum, Diamond) so the mod's Creator Dashboard, and a later viewer update, can show how it performs without a raw like rate, which reads worse than it is.
The live alternatives, measured on a production copy:

- A floor of 5 likes, below which a screenshot is Unranked: it left 57% of screenshots Unranked, mostly old ones with normal exposure that would never reach 5 likes.
- No likes floor: a Bronze with no likes reads as a participation trophy.
- Diamond from the 90th percentile of the stored, rounded `favoritingPercentage`: ties on the rounded value made it 13% of ranked screenshots, too common for a medal that reads as exceptional.
- Gold equal to the Popular algorithm's bar, so the medal could promise slideshow exposure.

## Decision

A screenshot earns a medal with at least 30 unique views and at least 3 likes (`HOF_SCREENSHOTS_RANK_MIN_UNIQUE_VIEWS`, `HOF_SCREENSHOTS_RANK_MIN_FAVORITES`).
Below either floor it is sent as `rank: null`, which the mod shows as Settling (under the views floor) or No medal (under the likes floor), reading both floors from the creator stats.
The cut points are the 25th, 50th, 75th and 97th percentiles of the exact like rate (likes times 100 over unique views, unrounded) among the screenshots above both floors: Silver from the 25th, Gold from the 50th, Platinum from the 75th, Diamond from the 97th, Bronze below.
The rank is computed at serialization from the same exact rate, so ties on a rounded value never merge tiers; the production copy splits 25/25/25/22/3%.
Popular keeps its own bar, the median stored like rate over screenshots with its minimum likes, computed in the same aggregation as the cut points, at boot and after the daily stats resync.

## Consequences

- A live like moves a rank at once, while unique views catch up at the five-minute stats sync, so a rank can briefly run high.
- About two thirds of medals would change with one like more or less, but likes arrive slowly: replayed over the production copy's like and view history, 2.4% of ranked screenshots change tier in a week and 8.7% in four weeks, almost never by two tiers, so the bands need neither widening nor hysteresis.
- A medal no longer maps to Popular eligibility: the mod's tooltip says higher medals are more likely to appear in the Popular slideshow.
- `ScreenshotStatsService.getRank` and the cut-point aggregation compute the rate with the same operations in the same order, so a rate sitting on a cut point compares equal.
- On a database with no screenshot above both floors, every cut point is 0, so the first screenshots to clear them rank Diamond until the next daily refresh.
