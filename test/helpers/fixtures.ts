import type { Trail } from "../../src/domain/types";

export function makeTrail(overrides: Partial<Trail> = {}): Trail {
  return {
    id: "seed:test-trail",
    owner: "shared",
    name: "Test Trail",
    area: "Pasadena",
    trailhead: "Test trailhead",
    address: null,
    routeType: "loop",
    distanceMinMi: 2,
    distanceMaxMi: 2.5,
    gainMinFt: 200,
    gainMaxFt: 300,
    difficulty: "moderate",
    difficultyNote: null,
    tags: ["test"],
    description: "A trail used in tests.",
    status: "open",
    closedUntil: null,
    statusNote: null,
    statusChecked: "2026-10-01",
    sourceUrls: ["https://example.com/test-trail"],
    indexState: "pending",
    indexedAt: null,
    ...overrides,
  };
}
