import { describe, expect, it } from "vitest";

import { credentialToJSON, prepareCreationOptions, prepareRequestOptions } from "./passkeys";

describe("passkey browser helpers", () => {
  it("decodes WebAuthn base64url challenge and credential ids", () => {
    const request = prepareRequestOptions({
      challenge: "AQIDBA",
      allowCredentials: [{ id: "BQYH", type: "public-key" }],
    });

    expect(Array.from(new Uint8Array(request.challenge as ArrayBuffer))).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(request.allowCredentials?.[0].id as ArrayBuffer))).toEqual([5, 6, 7]);
  });

  it("decodes creation user id and serializes binary credential fields", () => {
    const creation = prepareCreationOptions({
      challenge: "AQID",
      rp: { name: "OWC", id: "localhost" },
      user: { id: "BAUG", name: "user@example.test", displayName: "User" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
    expect(Array.from(new Uint8Array(creation.user.id as ArrayBuffer))).toEqual([4, 5, 6]);

    const serialized = credentialToJSON({
      id: "credential-id",
      rawId: new Uint8Array([7, 8, 9]).buffer,
      response: { clientDataJSON: new Uint8Array([10, 11]).buffer },
    } as unknown as Credential);
    expect(serialized.rawId).toBe("BwgJ");
    expect((serialized.response as Record<string, unknown>).clientDataJSON).toBe("Cgs");
  });
});
