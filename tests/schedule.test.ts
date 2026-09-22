import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { frequencyLabel, MIN_INTERVAL_MINUTES } from "@/lib/constants";
import {
  clampInterval,
  computeNextRun,
  hourInTimezone,
  isDue,
  isWithinActiveHours,
  nextActiveTime,
  retryDelayMs,
  scheduleDedupeKey,
} from "@/lib/jobs/schedule";
import { isRetryableFailure } from "@/lib/jobs/worker";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const base = {
  enabled: true,
  intervalMinutes: 60,
  timezone: "UTC",
  activeFromHour: null,
  activeToHour: null,
  lastSuccessAt: null,
  lastRunAt: null,
};

describe("clampInterval", () => {
  it("keeps sensible values", () => {
    assert.equal(clampInterval(15), 15);
    assert.equal(clampInterval(1440), 1440);
  });

  it("clamps out-of-range and nonsense values", () => {
    assert.equal(clampInterval(1), MIN_INTERVAL_MINUTES);
    assert.equal(clampInterval(-10), MIN_INTERVAL_MINUTES);
    assert.equal(clampInterval(999_999), 10080);
    assert.equal(clampInterval(Number.NaN), 60);
    assert.equal(clampInterval(30.7), 30);
  });
});

describe("frequencyLabel", () => {
  it("names the presets", () => {
    assert.equal(frequencyLabel(15), "Every 15 minutes");
    assert.equal(frequencyLabel(60), "Every hour");
    assert.equal(frequencyLabel(1440), "Daily");
  });

  it("describes custom intervals readably", () => {
    assert.equal(frequencyLabel(120), "Every 2 hours");
    assert.equal(frequencyLabel(2880), "Every 2 days");
    assert.equal(frequencyLabel(45), "Every 45 minutes");
  });
});

describe("hourInTimezone", () => {
  const noonUtc = new Date("2026-09-22T12:00:00.000Z");

  it("reads the hour in a named zone", () => {
    assert.equal(hourInTimezone(noonUtc, "UTC"), 12);
    assert.equal(hourInTimezone(noonUtc, "America/New_York"), 8); // EDT
  });

  it("falls back to UTC for an unknown zone rather than throwing", () => {
    assert.equal(hourInTimezone(noonUtc, "Mars/Olympus"), 12);
  });

  it("handles midnight without returning 24", () => {
    const midnight = new Date("2026-09-22T00:00:00.000Z");
    assert.equal(hourInTimezone(midnight, "UTC"), 0);
  });
});

describe("isWithinActiveHours", () => {
  const at = (hour: number) =>
    new Date(`2026-09-22T${String(hour).padStart(2, "0")}:30:00.000Z`);

  it("allows everything when no window is set", () => {
    assert.equal(isWithinActiveHours(at(3), base), true);
  });

  it("handles a normal daytime window", () => {
    const settings = { ...base, activeFromHour: 9, activeToHour: 17 };
    assert.equal(isWithinActiveHours(at(12), settings), true);
    assert.equal(isWithinActiveHours(at(9), settings), true);
    assert.equal(isWithinActiveHours(at(17), settings), true);
    assert.equal(isWithinActiveHours(at(8), settings), false);
    assert.equal(isWithinActiveHours(at(18), settings), false);
  });

  it("handles a window that wraps midnight", () => {
    const overnight = { ...base, activeFromHour: 22, activeToHour: 6 };
    assert.equal(isWithinActiveHours(at(23), overnight), true);
    assert.equal(isWithinActiveHours(at(2), overnight), true);
    assert.equal(isWithinActiveHours(at(12), overnight), false);
  });

  it("treats a zero-width window as no restriction", () => {
    const settings = { ...base, activeFromHour: 9, activeToHour: 9 };
    assert.equal(isWithinActiveHours(at(3), settings), true);
  });
});

describe("nextActiveTime", () => {
  it("returns the input when already inside the window", () => {
    const when = new Date("2026-09-22T12:00:00.000Z");
    assert.equal(
      nextActiveTime(when, { ...base, activeFromHour: 9, activeToHour: 17 })
        .getTime(),
      when.getTime(),
    );
  });

  it("advances into the next window", () => {
    const when = new Date("2026-09-22T03:00:00.000Z");
    const result = nextActiveTime(when, {
      ...base,
      activeFromHour: 9,
      activeToHour: 17,
    });
    assert.ok(result.getTime() > when.getTime());
    assert.ok(isWithinActiveHours(result, { ...base, activeFromHour: 9, activeToHour: 17 }));
  });
});

describe("computeNextRun", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("returns null when automation is off", () => {
    assert.equal(computeNextRun({ ...base, enabled: false }, now), null);
  });

  it("runs promptly the first time", () => {
    const next = computeNextRun(base, now);
    assert.equal(next?.getTime(), now.getTime());
  });

  it("spaces runs by the interval from the last attempt", () => {
    const next = computeNextRun(
      { ...base, intervalMinutes: 180, lastRunAt: now },
      now,
    );
    assert.equal(next?.getTime(), now.getTime() + 3 * HOUR);
  });

  it("anchors on the last attempt, not the last success", () => {
    // A failing integration must not retry instantly forever.
    const next = computeNextRun(
      {
        ...base,
        intervalMinutes: 60,
        lastSuccessAt: new Date(now.getTime() - 10 * HOUR),
        lastRunAt: now,
      },
      now,
    );
    assert.equal(next?.getTime(), now.getTime() + HOUR);
  });

  it("catches up once rather than queuing a backlog", () => {
    const longAgo = new Date(now.getTime() - 5 * 24 * HOUR);
    const next = computeNextRun({ ...base, lastRunAt: longAgo }, now);
    assert.equal(
      next?.getTime(),
      now.getTime(),
      "one run now, not one per missed slot",
    );
  });

  it("respects quiet hours", () => {
    const next = computeNextRun(
      {
        ...base,
        intervalMinutes: 15,
        activeFromHour: 9,
        activeToHour: 17,
        lastRunAt: new Date("2026-09-22T20:00:00.000Z"),
      },
      new Date("2026-09-22T20:00:00.000Z"),
    );
    assert.ok(next);
    assert.equal(
      isWithinActiveHours(next!, {
        ...base,
        activeFromHour: 9,
        activeToHour: 17,
      }),
      true,
    );
  });
});

describe("isDue", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("is not due when disabled", () => {
    assert.equal(
      isDue({ ...base, enabled: false, nextRunAt: new Date(0) }, now),
      false,
    );
  });

  it("is due when nextRunAt has passed", () => {
    assert.equal(
      isDue({ ...base, nextRunAt: new Date(now.getTime() - MINUTE) }, now),
      true,
    );
  });

  it("is not due before nextRunAt", () => {
    assert.equal(
      isDue({ ...base, nextRunAt: new Date(now.getTime() + MINUTE) }, now),
      false,
    );
  });

  it("is due when no next run has been computed yet", () => {
    assert.equal(isDue({ ...base, nextRunAt: null }, now), true);
  });

  it("is not due outside the active window", () => {
    assert.equal(
      isDue(
        {
          ...base,
          activeFromHour: 9,
          activeToHour: 17,
          nextRunAt: new Date(now.getTime() - MINUTE),
        },
        new Date("2026-09-22T03:00:00.000Z"),
      ),
      false,
    );
  });
});

describe("scheduleDedupeKey", () => {
  it("is stable within the same minute", () => {
    const a = scheduleDedupeKey("u1", new Date("2026-09-22T12:00:10.000Z"));
    const b = scheduleDedupeKey("u1", new Date("2026-09-22T12:00:50.000Z"));
    assert.equal(a, b, "two ticks seconds apart are the same slot");
  });

  it("differs across minutes and users", () => {
    const slot = new Date("2026-09-22T12:00:00.000Z");
    assert.notEqual(
      scheduleDedupeKey("u1", slot),
      scheduleDedupeKey("u1", new Date(slot.getTime() + MINUTE)),
    );
    assert.notEqual(
      scheduleDedupeKey("u1", slot),
      scheduleDedupeKey("u2", slot),
    );
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially from the configured base", () => {
    assert.equal(retryDelayMs(1, 60), 60_000);
    assert.equal(retryDelayMs(2, 60), 120_000);
    assert.equal(retryDelayMs(3, 60), 240_000);
  });

  it("caps so an outage cannot push a retry days away", () => {
    assert.equal(retryDelayMs(20, 60), 60 * MINUTE);
  });

  it("honours an explicit retry-after", () => {
    assert.equal(retryDelayMs(1, 60, 5), 5_000);
  });

  it("enforces a floor on the base", () => {
    assert.equal(retryDelayMs(1, 0), 5_000);
  });
});

describe("isRetryableFailure", () => {
  it("retries transient categories", () => {
    for (const code of [
      "RATE_LIMITED",
      "SERVER_ERROR",
      "NETWORK_ERROR",
      "WORKER_LOST",
    ]) {
      assert.equal(isRetryableFailure(code), true, code);
    }
  });

  it("does not retry problems a retry cannot fix", () => {
    for (const code of [
      "AUTH_EXPIRED",
      "INSUFFICIENT_SCOPE",
      "NOT_FOUND",
      "NOT_CONFIGURED",
      "NOT_CONNECTED",
      "BAD_REQUEST",
      "PERMISSION_DENIED",
      "BLOCKED",
    ]) {
      assert.equal(isRetryableFailure(code), false, code);
    }
  });

  it("does not treat an unclassified result as transient", () => {
    // Retrying an unknown *result* turns a broken setup into a hot loop;
    // an unexpected exception is retried separately, by the runner.
    assert.equal(isRetryableFailure("UNKNOWN"), false);
  });

  it("treats a missing code as non-retryable", () => {
    assert.equal(isRetryableFailure(null), false);
    assert.equal(isRetryableFailure(undefined), false);
  });
});
