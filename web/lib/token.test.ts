import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  clearToken,
  getToken,
  isTokenPayloadShaped,
  isTokenShaped,
  parseTokenPayload,
  setToken,
} from "./token";

/** Minimal Storage stand-in so lib code runs under the node environment. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function installFakeWindow(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: storage,
  };
  return storage;
}

function uninstallFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

const VALID_PAYLOAD = { sub: "operator-1", role: "admin", exp: 4102444800 };

/** [token, reason] pairs covering structural and payload-level garbage. */
const GARBAGE_TOKEN_CASES: ReadonlyArray<[string, string]> = [
  ["", "empty string"],
  ["not-a-jwt", "no dots"],
  ["a.b", "too few segments"],
  ["a.b.c.d", "too many segments"],
  [".payload.sig", "empty header"],
  ["header..sig", "empty payload"],
  ["header.payload.", "empty signature"],
  ["header.!!!!.sig", "invalid base64 characters"],
  [`header.${base64UrlEncode("not json")}.sig`, "non-JSON payload"],
  [`header.${base64UrlEncode("{broken")}.sig`, "malformed JSON payload"],
  [`header.${base64UrlEncode("null")}.sig`, "null payload"],
  [`header.${base64UrlEncode("[1,2,3]")}.sig`, "array payload"],
  [
    `header.${base64UrlEncode(JSON.stringify({ role: "admin", exp: 5 }))}.sig`,
    "missing sub",
  ],
  [
    `header.${base64UrlEncode(JSON.stringify({ sub: 7, role: "admin", exp: 5 }))}.sig`,
    "non-string sub",
  ],
  [
    `header.${base64UrlEncode(JSON.stringify({ sub: "s", exp: 5 }))}.sig`,
    "missing role",
  ],
  [
    `header.${base64UrlEncode(JSON.stringify({ sub: "s", role: true, exp: 5 }))}.sig`,
    "non-string role",
  ],
  [
    `header.${base64UrlEncode(JSON.stringify({ sub: "s", role: "r" }))}.sig`,
    "missing exp",
  ],
  [
    `header.${base64UrlEncode(JSON.stringify({ sub: "s", role: "r", exp: "soon" }))}.sig`,
    "string exp",
  ],
  [
    `header.${base64UrlEncode('{"sub":"s","role":"r","exp":1e999}')}.sig`,
    "non-finite exp (parses to Infinity)",
  ],
];

/** [payload, reason] pairs failing the narrow shape check directly. */
const BAD_PAYLOAD_CASES: ReadonlyArray<[unknown, string]> = [
  [null, "null"],
  ["string", "plain string"],
  [[], "array"],
  [{}, "empty object"],
  [{ sub: "s", role: "r", exp: Number.NaN }, "NaN exp"],
];

describe("token storage contract", () => {
  beforeEach(() => {
    installFakeWindow();
  });

  afterEach(() => {
    uninstallFakeWindow();
  });

  it("roundtrips set/get/clear through localStorage", () => {
    expect(getToken()).toBe("");

    setToken("header.payload.sig");
    expect(getToken()).toBe("header.payload.sig");

    clearToken();
    expect(getToken()).toBe("");
  });

  it("stores under the owc_token key", () => {
    setToken("abc.def.ghi");
    const window_ = globalThis as unknown as {
      window: { localStorage: Storage };
    };
    expect(window_.window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(
      "abc.def.ghi"
    );
  });

  it("overwrites a previous token", () => {
    setToken("first.token.value");
    setToken("second.token.value");
    expect(getToken()).toBe("second.token.value");
  });
});

describe("token storage without a window (SSR / node)", () => {
  afterEach(() => {
    uninstallFakeWindow();
  });

  it("getToken returns empty string when storage is unavailable", () => {
    expect(getToken()).toBe("");
  });

  it("setToken and clearToken are safe no-ops", () => {
    expect(() => setToken("x.y.z")).not.toThrow();
    expect(() => clearToken()).not.toThrow();
    expect(getToken()).toBe("");
  });
});

describe("isTokenShaped / parseTokenPayload", () => {
  it("accepts a well-formed token with the narrow payload shape", () => {
    const token = makeJwt(VALID_PAYLOAD);
    expect(isTokenShaped(token)).toBe(true);
    expect(parseTokenPayload(token)).toEqual(VALID_PAYLOAD);
  });

  it("decodes base64url padding-free segments", () => {
    // Payload containing characters that force base64 padding/url-safe chars.
    const token = makeJwt({
      sub: "operator with spaces & symbols +/",
      role: "viewer",
      exp: 123,
    });
    expect(isTokenShaped(token)).toBe(true);
    expect(parseTokenPayload(token)?.sub).toBe(
      "operator with spaces & symbols +/"
    );
  });

  for (const [token, reason] of GARBAGE_TOKEN_CASES) {
    it(`rejects ${reason}`, () => {
      expect(isTokenShaped(token)).toBe(false);
      expect(parseTokenPayload(token)).toBeNull();
    });
  }
});

describe("isTokenPayloadShaped", () => {
  it("narrows a valid payload object", () => {
    const value: unknown = VALID_PAYLOAD;
    if (isTokenPayloadShaped(value)) {
      expect(value.sub).toBe("operator-1");
    } else {
      throw new Error("expected payload to be shaped");
    }
  });

  for (const [value, reason] of BAD_PAYLOAD_CASES) {
    it(`rejects ${reason}`, () => {
      expect(isTokenPayloadShaped(value)).toBe(false);
    });
  }
});
