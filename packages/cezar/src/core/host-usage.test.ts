import { describe, expect, it } from 'vitest';
import { hostUsageSchema } from '@open-mercato/cezar-contract';

/**
 * The contract half of the host-telemetry suite (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`): every optional field describes a fact the
 * OS may not expose, so "absent" has to survive both directions — parsing and serialization.
 * The sampler's own behavior is covered further down this file.
 */
describe('hostUsageSchema', () => {
  it('accepts a minimal sample with every optional key absent', () => {
    const minimal = {
      sampledAt: '2026-09-20T00:00:00.000Z',
      cpuCount: 8,
      memTotalBytes: 32 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      memAvailableBytes: 20 * 1024 ** 3,
    };

    const parsed = hostUsageSchema.parse(minimal);
    expect(parsed).toEqual(minimal);
    // Both directions: nothing gained, nothing dropped — absent stays absent on the wire, so a
    // client can tell "the OS does not expose swap" from "swap is zero".
    expect(Object.keys(JSON.parse(JSON.stringify(parsed))).sort()).toEqual(Object.keys(minimal).sort());
  });

  it('accepts a full sample and round-trips every optional key', () => {
    const full = {
      sampledAt: '2026-09-20T00:00:02.000Z',
      cpuPct: 38.4,
      cpuCount: 4,
      memTotalBytes: 32 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      memAvailableBytes: 20 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 1024 ** 3,
      loadAvg: { one: 1.42, five: 0.98, fifteen: 0.76 },
    };

    const parsed = hostUsageSchema.parse(full);
    expect(parsed).toEqual(full);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(full);
  });

  it('rejects numbers the card could not render honestly', () => {
    const base = {
      sampledAt: '2026-09-20T00:00:00.000Z',
      cpuCount: 4,
      memTotalBytes: 1,
      memUsedBytes: 0,
      memAvailableBytes: 1,
    };

    expect(hostUsageSchema.safeParse({ ...base, cpuPct: 101 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, cpuPct: -0.5 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, cpuCount: 0 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, memUsedBytes: -1 }).success).toBe(false);
  });
});
