"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, ShieldCheck, Smartphone, Fingerprint, AlertCircle, Check, Loader2 } from "lucide-react";
import { apiUrl, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function AccountTab(): React.JSX.Element {
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [oldPw, setOldPw] = useState<string>("");
  const [newPw, setNewPw] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [pwMsg, setPwMsg] = useState<string>("");
  const [pwErr, setPwErr] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [totpSecret, setTotpSecret] = useState<string>("");
  const [totpUri, setTotpUri] = useState<string>("");
  const [totpCode, setTotpCode] = useState<string>("");
  const [totpMsg, setTotpMsg] = useState<string>("");
  const [passkeyMsg, setPasskeyMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const token = getToken();
        const res = await fetch(apiUrl("/api/auth/me"), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { user?: { email: string; role: string } };
        if (!cancelled && data.user) setMe(data.user);
      } catch {}
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function changePassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPwErr("");
    setPwMsg("");
    if (newPw.length < 8) {
      setPwErr("New password must be 8+ characters.");
      return;
    }
    if (newPw !== confirm) {
      setPwErr("Passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      const token = getToken();
      const res = await fetch(apiUrl("/api/auth/change-password"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ current_password: oldPw, new_password: newPw }),
      });
      if (!res.ok) {
        const t = await res.text();
        setPwErr(t || `Failed (${res.status}) — endpoint may not exist yet.`);
        return;
      }
      setPwMsg("Password updated.");
      setOldPw("");
      setNewPw("");
      setConfirm("");
    } catch {
      setPwErr("Could not reach API.");
    } finally {
      setSaving(false);
    }
  }

  async function enrollTotp(): Promise<void> {
    setTotpMsg("");
    try {
      const token = getToken();
      const res = await fetch(apiUrl("/api/auth/2fa/enroll"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const t = await res.text();
        setTotpMsg(t || `Enroll failed (${res.status}) — not yet implemented.`);
        return;
      }
      const data = (await res.json()) as { secret?: string; otpauth_url?: string };
      setTotpSecret(data.secret || "");
      setTotpUri(data.otpauth_url || "");
      setTotpMsg("Scan the QR / otpauth URL in your authenticator, then verify a code.");
    } catch {
      setTotpMsg("Could not reach API.");
    }
  }

  async function verifyTotp(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setTotpMsg("");
    try {
      const token = getToken();
      const res = await fetch(apiUrl("/api/auth/2fa/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ code: totpCode }),
      });
      if (!res.ok) {
        const t = await res.text();
        setTotpMsg(t || `Verify failed (${res.status}).`);
        return;
      }
      setTotpMsg("2FA verified — TOTP enabled.");
    } catch {
      setTotpMsg("Could not reach API.");
    }
  }

  async function registerPasskey(): Promise<void> {
    setPasskeyMsg("");
    const maybeNav: unknown = navigator as unknown as Record<string, unknown>;
    const hasWebAuthn =
      typeof window !== "undefined" &&
      window.PublicKeyCredential !== undefined &&
      maybeNav !== null &&
      typeof (maybeNav as { credentials?: unknown }).credentials !== "undefined";
    if (!hasWebAuthn) {
      setPasskeyMsg("Passkeys not supported in this browser/context (need HTTPS + platform authenticator).");
      return;
    }
    try {
      const token = getToken();
      const optsRes = await fetch(apiUrl("/api/auth/passkey/register-options"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!optsRes.ok) {
        const t = await optsRes.text();
        setPasskeyMsg(t || `Passkey not yet implemented (${optsRes.status}).`);
        return;
      }
      const opts = (await optsRes.json()) as unknown;
      // Simple passthrough — server should return credentialCreationOptions
      const cred = await (navigator as unknown as { credentials: { create: (o: unknown) => Promise<unknown> } }).credentials.create(
        opts as unknown as never,
      );
      const verifyRes = await fetch(apiUrl("/api/auth/passkey/register-verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(cred),
      });
      if (!verifyRes.ok) {
        const t = await verifyRes.text();
        setPasskeyMsg(t || `Save failed (${verifyRes.status}).`);
        return;
      }
      setPasskeyMsg("Passkey registered.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPasskeyMsg(msg || "Passkey flow failed.");
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" /> Current user
          </CardTitle>
          <CardDescription>
            Signed in as <span className="font-medium text-foreground">{me?.email || "—"}</span>
            {me?.role ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px]">{me.role}</span> : null}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Change password</CardTitle>
          <CardDescription>Update your console password. No provider keys here — those live in API Keys + per-agent provider.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="max-w-[420px] space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cur">Current password</Label>
              <Input id="cur" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} required autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conf">Confirm new password</Label>
              <Input id="conf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
            </div>
            {pwErr ? (
              <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                <AlertCircle className="size-3.5" /> {pwErr}
              </p>
            ) : null}
            {pwMsg ? (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                <Check className="size-3.5" /> {pwMsg}
              </p>
            ) : null}
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null} Update password
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Endpoint <span className="font-mono">POST /api/auth/change-password</span> — if 404, backend TODO (see below).
            </p>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Smartphone className="size-4 text-primary" /> Two-factor (TOTP)
          </CardTitle>
          <CardDescription>Time-based one-time passwords — authenticator app. Secrets stay server-side.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void enrollTotp()}>
              Enroll / show QR
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/login">Test logout/login</Link>
            </Button>
          </div>
          {totpUri ? (
            <div className="rounded-md bg-muted p-3 font-mono text-xs break-all">
              <div className="text-muted-foreground">otpauth URL (render as QR in app):</div>
              <div className="mt-1">{totpUri}</div>
              {totpSecret ? <div className="mt-2 text-muted-foreground">secret: {totpSecret}</div> : null}
            </div>
          ) : null}
          <form onSubmit={verifyTotp} className="flex max-w-[320px] gap-2">
            <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="123456" inputMode="numeric" maxLength={6} className="font-mono" />
            <Button type="submit">Verify</Button>
          </form>
          {totpMsg ? <p className="text-xs text-muted-foreground">{totpMsg}</p> : null}
          <p className="text-[11px] text-muted-foreground">
            Needs <span className="font-mono">POST /api/auth/2fa/enroll</span> + <span className="font-mono">/verify</span> + <span className="font-mono">/disable</span> — pyotp server-side.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Fingerprint className="size-4 text-primary" /> Passkeys
          </CardTitle>
          <CardDescription>WebAuthn platform authenticator — no password, phishing-resistant. Stored per-user.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => void registerPasskey()}>
            Register this device
          </Button>
          {passkeyMsg ? <p className="text-xs text-muted-foreground">{passkeyMsg}</p> : null}
          <p className="text-[11px] text-muted-foreground">
            Needs <span className="font-mono">POST /api/auth/passkey/*</span> with <span className="font-mono">@simplewebauthn/server</span> — BYOK stays separate.
          </p>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />{" "}
            <span>
              Provider API keys are not here — set per-agent <span className="font-medium text-foreground">provider/model</span> in{" "}
              <span className="font-mono">Settings → API Keys</span> / <span className="font-mono">Models</span> (masked, runtime yaml).
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
