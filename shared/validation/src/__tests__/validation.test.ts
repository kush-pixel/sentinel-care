/**
 * validation.test.ts — Unit tests for validatePatientId, validateCallId,
 * generatePatientId, generateCallId, isLegacyId.
 */

import {
  validatePatientId,
  validateCallId,
  generatePatientId,
  generateCallId,
  isLegacyId,
} from "../index";

// ─── validatePatientId ────────────────────────────────────────────────────────

describe("validatePatientId", () => {
  describe("valid cases", () => {
    it("accepts legacy P-format (P001)", () => {
      expect(validatePatientId("P001")).toBe(true);
    });

    it("accepts generatePatientId() output (UUID v4)", () => {
      expect(validatePatientId(generatePatientId())).toBe(true);
    });

    it("accepts MRN-style ID", () => {
      expect(validatePatientId("MRN-123456")).toBe(true);
    });

    it("accepts PAT-style ID", () => {
      expect(validatePatientId("PAT-2026-001")).toBe(true);
    });

    it("accepts a bare UUID v4 string", () => {
      expect(validatePatientId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });
  });

  describe("invalid cases", () => {
    it("rejects too-short ID (P1)", () => {
      expect(validatePatientId("P1")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validatePatientId("")).toBe(false);
    });

    it("rejects null", () => {
      expect(validatePatientId(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(validatePatientId(undefined)).toBe(false);
    });

    it("rejects number", () => {
      expect(validatePatientId(123)).toBe(false);
    });

    it("rejects SQL injection with semicolon", () => {
      expect(validatePatientId("P001; DROP TABLE")).toBe(false);
    });

    it("rejects SQL injection with single quote", () => {
      expect(validatePatientId("P001' OR '1'='1")).toBe(false);
    });

    it("rejects double-dash SQL comment", () => {
      expect(validatePatientId("admin--")).toBe(false);
    });
  });
});

// ─── validateCallId ───────────────────────────────────────────────────────────

describe("validateCallId", () => {
  describe("valid cases", () => {
    it("accepts legacy C-format (C001)", () => {
      expect(validateCallId("C001")).toBe(true);
    });

    it("accepts generateCallId() output", () => {
      expect(validateCallId(generateCallId())).toBe(true);
    });

    it("accepts UUID v4", () => {
      expect(validateCallId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });
  });

  describe("invalid cases", () => {
    it("rejects too-short ID (C1)", () => {
      expect(validateCallId("C1")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validateCallId("")).toBe(false);
    });

    it("rejects null", () => {
      expect(validateCallId(null)).toBe(false);
    });
  });
});

// ─── generatePatientId ────────────────────────────────────────────────────────

describe("generatePatientId", () => {
  it("returns a string", () => {
    expect(typeof generatePatientId()).toBe("string");
  });

  it("returns an ID that passes validatePatientId", () => {
    expect(validatePatientId(generatePatientId())).toBe(true);
  });

  it("returns different values on successive calls", () => {
    expect(generatePatientId()).not.toBe(generatePatientId());
  });
});

// ─── generateCallId ───────────────────────────────────────────────────────────

describe("generateCallId", () => {
  it("returns a string", () => {
    expect(typeof generateCallId()).toBe("string");
  });

  it("returns an ID that passes validateCallId", () => {
    expect(validateCallId(generateCallId())).toBe(true);
  });
});

// ─── isLegacyId ───────────────────────────────────────────────────────────────

describe("isLegacyId", () => {
  it("returns true for P001 (legacy patient)", () => {
    expect(isLegacyId("P001")).toBe(true);
  });

  it("returns true for C001 (legacy call)", () => {
    expect(isLegacyId("C001")).toBe(true);
  });

  it("returns false for a UUID", () => {
    expect(isLegacyId(generatePatientId())).toBe(false);
  });

  it("returns false for generateCallId() output", () => {
    expect(isLegacyId(generateCallId())).toBe(false);
  });
});
