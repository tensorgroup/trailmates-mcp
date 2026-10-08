# Retrieval eval results

Re-run against the deployed Worker at https://trailmates.tensor.group with `POST /admin/eval`, after the seed descriptions were shortened (first recorded on 2026-10-07 on the workers.dev URL). Cases are in `src/eval/fixtures.ts` and are frozen: change a case and the published numbers change, so add cases instead of editing them.

- Embedding model: `@cf/baai/bge-base-en-v1.5` (768 dimensions, cosine)
- Cases: 11 (10 scored, plus 1 closure-only negative)
- Evaluated as of: 2026-10-07 (so the Eaton closure through 2027-12-31 is in effect for every case)
- Index ready: true

| Metric | Result |
|---|---|
| top-1 | 1.0 |
| hit@3 | 1.0 |
| MRR | 1.0 |
| Closure violations | none |

## Per case

Rank is the position of the first relevant trail; `-` marks the negative case, which is checked only for closure violations.

| Query | Rank | Top 3 |
|---|---|---|
| shaded creek walk with a waterfall | 1 | solstice-canyon-malibu, escondido-falls-malibu, gabrielino-jpl-brown-mountain-dam |
| stair workout with city views | 1 | culver-city-stairs, runyon-canyon-loop, eagle-rock-canyon-trail |
| easy flat walk near JPL with birdwatching | 1 | hahamongna-watershed-loop, eagle-rock-canyon-trail, deukmejian-dunsmore-le-mesnager-loop |
| long shaded flat hike along the arroyo to a dam | 1 | gabrielino-jpl-brown-mountain-dam, solstice-canyon-malibu, la-tuna-canyon-trail |
| classic Griffith Park summit with Hollywood sign views | 1 | griffith-fern-dell-mount-hollywood, griffith-fern-dell-observatory, griffith-helipad-cedar-grove-loop |
| quick after-work neighborhood hike in Eagle Rock | 1 | eagle-rock-canyon-trail, hahamongna-watershed-loop, deukmejian-dunsmore-le-mesnager-loop |
| exposed fire road to a peak with radio towers | 1 | verdugo-peak-from-la-tuna, la-tuna-canyon-trail, mount-lukens-via-deukmejian |
| helipad panoramic views Griffith back side | 1 | griffith-helipad-cedar-grove-loop, griffith-fern-dell-observatory, deukmejian-dunsmore-le-mesnager-loop |
| steep coastal peak with ocean views in Malibu | 1 | mugu-peak-point-mugu, solstice-canyon-malibu, escondido-falls-malibu |
| short foothill loop with creek and lookouts | 1 | deukmejian-dunsmore-le-mesnager-loop, hahamongna-watershed-loop, gabrielino-jpl-brown-mountain-dam |
| Eaton Canyon waterfall hike (negative) | - | gabrielino-jpl-brown-mountain-dam, deukmejian-dunsmore-le-mesnager-loop, solstice-canyon-malibu |

The negative case is the point of the closure handling: Eaton Canyon is the obvious answer to that query and is closed, so neither Eaton entrance may appear, and neither does. (Millard Falls, also closed, is listed as relevant for the first query, but it is hidden while closed, so that case is satisfied by the Malibu trails.)

## What this does and does not show

The seed descriptions were shortened between runs and the metrics did not change. This is a regression check and a demonstration of closure-aware negatives. It is not a benchmark. The seed has only 18 trails, so hit@3 covers one sixth of the corpus. The fixtures were written by the same author as the trail descriptions, so queries tend to echo the wording of the answers. Perfect scores on a set this size say the pipeline (embedding, Vectorize filtering, D1 hydration, closure rules) works end to end; they do not say retrieval would hold up on a large or adversarial corpus.
