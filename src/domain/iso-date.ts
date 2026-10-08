import { z } from "zod";

/** A YYYY-MM-DD string that is also a real calendar date (rejects e.g. 2026-02-30). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const t = Date.parse(s);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "must be a real calendar date");
