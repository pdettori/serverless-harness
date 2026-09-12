import { describe, it, expect } from 'vitest';
import {
  DUTY_BASES,
  DEFAULT_BASIS,
  resolveBasis,
  sandboxFloor,
  assertBasisConsistent,
  describeBasis,
} from '../src/basis';
import { derivedRatio } from '../src/sharing';

describe('DUTY_BASES', () => {
  it('carries exactly the three rows of spec §2.3', () => {
    expect(DUTY_BASES.map((b) => b.name)).toEqual(['e6-ocp', 'e6-kind', 'e7']);
  });

  it("every row is internally consistent: its printed ratio is its own duty's reciprocal", () => {
    // This is the table's own invariant. If a row ever fails it, the table was mistranscribed
    // and every provisioning decision derived from it is wrong — catch it here, not on a rung.
    for (const b of DUTY_BASES) {
      expect(() => assertBasisConsistent(b.duty[0], b.ratio[1])).not.toThrow();
      expect(() => assertBasisConsistent(b.duty[1], b.ratio[0])).not.toThrow();
    }
  });

  it('agrees with derivedRatio, the function E6 already used', () => {
    // Two ways of computing the same thing must agree, or E6's records and E8's are in
    // different units.
    const ocp = resolveBasis('e6-ocp');
    expect(derivedRatio(ocp.duty[1])).toBeCloseTo(ocp.ratio[0], 0);
    expect(derivedRatio(ocp.duty[0])).toBeCloseTo(ocp.ratio[1], 0);
  });

  it('defaults to the OCP row, which is what P6 provisions from', () => {
    expect(DEFAULT_BASIS.name).toBe('e6-ocp');
    expect(DEFAULT_BASIS.duty).toEqual([0.061, 0.079]);
    expect(DEFAULT_BASIS.ratio).toEqual([12.6, 16.5]);
  });
});

describe('resolveBasis', () => {
  it('defaults on unset and blank', () => {
    expect(resolveBasis(undefined).name).toBe('e6-ocp');
    expect(resolveBasis('  ').name).toBe('e6-ocp');
  });

  it('trims and accepts each row name', () => {
    expect(resolveBasis(' e7 ').name).toBe('e7');
    expect(resolveBasis('e6-kind').name).toBe('e6-kind');
  });

  it('rejects an unknown basis by listing the valid rows', () => {
    // "e6" is the tempting typo and it is genuinely ambiguous — two rows come from E6 with
    // duty bands that differ by ~1.5x. Guessing one would silently pick a provisioning rule.
    expect(() => resolveBasis('e6')).toThrow(/is not one of e6-ocp\|e6-kind\|e7/);
  });
});

describe('assertBasisConsistent — the §5.4 blending trap', () => {
  it('accepts a duty and ratio from the same row', () => {
    expect(() => assertBasisConsistent(0.07, 14.3)).not.toThrow();
  });

  it('rejects OCP duty paired with Kind ratio', () => {
    // The exact error the spec warns about: 1/0.06 = 16.7, not 24. A pool provisioned from
    // the blend is ~40% short, and the shortfall shows up as lease waits that read like the
    // worker tier saturating — the wrong bound gets attributed and the knee lands early.
    expect(() => assertBasisConsistent(0.06, 24)).toThrow(/blend/i);
  });

  it('names both numbers and the reciprocal in the message', () => {
    expect(() => assertBasisConsistent(0.06, 24)).toThrow(/0\.06/);
    expect(() => assertBasisConsistent(0.06, 24)).toThrow(/24/);
    expect(() => assertBasisConsistent(0.06, 24)).toThrow(/16\.7/);
  });

  it('rejects E7 duty paired with an E6 ratio', () => {
    expect(() => assertBasisConsistent(0.021, 14.3)).toThrow(/blend/i);
  });

  it('rejects a non-positive duty rather than dividing by zero', () => {
    expect(() => assertBasisConsistent(0, 14)).toThrow(/duty/);
    expect(() => assertBasisConsistent(-0.1, 14)).toThrow(/duty/);
  });
});

describe('sandboxFloor', () => {
  it('is ceil(W * S * duty)', () => {
    // 4 workers x 8 turns x 0.079 = 2.53 -> 3 sandboxes.
    expect(sandboxFloor(4, 8, 0.079)).toBe(3);
    expect(sandboxFloor(4, 8, 0.061)).toBe(2);
  });

  it('never returns 0, because a turn that calls a tool needs somewhere to call it', () => {
    // W*S*duty rounds to 0.08 for a single low-duty session; a floor of 0 would make the
    // driver "provision" an empty pool and every tool call would fail on lease acquisition.
    expect(sandboxFloor(1, 1, 0.021)).toBe(1);
  });

  it('rejects nonsense inputs loudly', () => {
    expect(() => sandboxFloor(0, 8, 0.07)).toThrow(/workers/);
    expect(() => sandboxFloor(4, 0, 0.07)).toThrow(/turnsPerWorker/);
    expect(() => sandboxFloor(4, 8, 0)).toThrow(/duty/);
    expect(() => sandboxFloor(4, 8, 1.5)).toThrow(/duty/);
  });
});

describe('describeBasis', () => {
  it('names the row, the band, the implied ratio, and the citation', () => {
    // A run record that says only "duty 0.07" is unauditable six weeks later: the reader
    // cannot tell which of three rows it came from, and therefore cannot tell whether the
    // sandbox count was right.
    const s = describeBasis(DEFAULT_BASIS);
    expect(s).toContain('e6-ocp');
    expect(s).toContain('0.061');
    expect(s).toContain('0.079');
    expect(s).toContain('12.6');
    expect(s).toContain('16.5');
    expect(s).toMatch(/EXPERIMENTS\.md|§2\.3|:88/);
  });
});
