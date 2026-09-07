"use client";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===";
  const binary = atob(padded.slice(0, padded.length - (padded.length % 4 || 4)));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function serializeCredentialValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return bytesToBase64Url(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(serializeCredentialValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serializeCredentialValue(item)]),
    );
  }
  return value;
}

export function credentialToJSON(credential: Credential | null): Record<string, unknown> {
  if (!credential) return {};
  return serializeCredentialValue(credential) as Record<string, unknown>;
}

export function prepareCreationOptions(options: Record<string, any>): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64UrlToBytes(String(options.challenge || "")),
    user: {
      ...options.user,
      id: base64UrlToBytes(String(options.user?.id || "")),
    },
    excludeCredentials: Array.isArray(options.excludeCredentials)
      ? options.excludeCredentials.map((item: Record<string, any>) => ({
          ...item,
          id: base64UrlToBytes(String(item.id || "")),
        }))
      : undefined,
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function prepareRequestOptions(options: Record<string, any>): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64UrlToBytes(String(options.challenge || "")),
    allowCredentials: Array.isArray(options.allowCredentials)
      ? options.allowCredentials.map((item: Record<string, any>) => ({
          ...item,
          id: base64UrlToBytes(String(item.id || "")),
        }))
      : undefined,
  } as PublicKeyCredentialRequestOptions;
}
