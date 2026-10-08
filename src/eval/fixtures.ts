export interface EvalCase {
  query: string;
  relevant: string[];
  mustNotInclude?: string[];
  date: string; // frozen: results must not drift with today's date
}

// Workers Free allows 50 subrequests per invocation. runEval spends 1 batched embed call plus 3 per case
// (Vectorize query, D1 getVisibleByIds, D1 findVisibleByName): 1 + 3 * 15 = 46, leaving a little headroom.
// Raise this only together with that arithmetic.
export const MAX_EVAL_CASES = 15;

const EATON = ["seed:eaton-canyon-nature-center", "seed:eaton-canyon-pinecrest"];

// Frozen: changing a case changes the published results. Add cases, do not edit them.
// All cases are evaluated as of 2026-10-07 so the Eaton closure (through 2027-12-31) is stable.
export const EVAL_CASES: EvalCase[] = [
  { date: "2026-10-07", query: "shaded creek walk with a waterfall", relevant: ["seed:solstice-canyon-malibu", "seed:escondido-falls-malibu", "seed:millard-falls"], mustNotInclude: EATON },
  { date: "2026-10-07", query: "stair workout with city views", relevant: ["seed:culver-city-stairs"] },
  { date: "2026-10-07", query: "easy flat walk near JPL with birdwatching", relevant: ["seed:hahamongna-watershed-loop"] },
  { date: "2026-10-07", query: "long shaded flat hike along the arroyo to a dam", relevant: ["seed:gabrielino-jpl-brown-mountain-dam"] },
  { date: "2026-10-07", query: "classic Griffith Park summit with Hollywood sign views", relevant: ["seed:griffith-fern-dell-mount-hollywood"] },
  { date: "2026-10-07", query: "quick after-work neighborhood hike in Eagle Rock", relevant: ["seed:eagle-rock-canyon-trail"] },
  { date: "2026-10-07", query: "exposed fire road to a peak with radio towers", relevant: ["seed:verdugo-peak-from-la-tuna"] },
  { date: "2026-10-07", query: "helipad panoramic views Griffith back side", relevant: ["seed:griffith-helipad-cedar-grove-loop"] },
  { date: "2026-10-07", query: "steep coastal peak with ocean views in Malibu", relevant: ["seed:mugu-peak-point-mugu", "seed:solstice-canyon-malibu"] },
  { date: "2026-10-07", query: "short foothill loop with creek and lookouts", relevant: ["seed:deukmejian-dunsmore-le-mesnager-loop"] },
  { date: "2026-10-07", query: "Eaton Canyon waterfall hike", relevant: [], mustNotInclude: EATON },
];
