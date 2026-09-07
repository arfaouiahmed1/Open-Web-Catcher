"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, Fingerprint, KeyRound, Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { credentialToJSON, prepareCreationOptions } from "@/lib/passkeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AccountTab(): React.JSX.Element {
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [oldPw, setOldPw] = useState<string>("");
  const [newPw, setNewPw] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [pwMsg, setPwMsg] = useState<string>("");
  const [pwErr, setPwErr] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [isLoadingMe, setIsLoadingMe] = useState<boolean>(true);
  const [verifyMsg, setVerifyMsg] = useState<string>("");
  const [verifyErr, setVerifyErr] = useState<string>("");
  const [verifySending, setVerifySending] = useState<boolean>(false);
  const [totpEnabled, setTotpEnabled] = useState<boolean>(false);
  const [totpSecret, setTotpSecret] = useState<string>("");
  const [totpUri, setTotpUri] = useState<string>("");
  const [totpCode, setTotpCode] = useState<string>("");
  const [totpBackupCodes, setTotpBackupCodes] = useState<string[]>([]);
  const [totpMsg, setTotpMsg] = useState<string>("");
  const [totpErr, setTotpErr] = useState<string>("");
  const [totpBusy, setTotpBusy] = useState<boolean>(false);
  const [passkeyRegistered, setPasskeyRegistered] = useState<boolean>(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string>("");
  const [passkeyErr, setPasskeyErr] = useState<string>("");
  const [passkeyBusy, setPasskeyBusy] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const data = await apiFetch<{ user?: { email: string; role: string } }>("/api/auth/me");
        if (!cancelled && data.user) setMe(data.user);
      } catch {
        // The parent console auth boundary handles an expired session.
      } finally {
        if (!cancelled) setIsLoadingMe(false);
      }
      try {
        const status = await apiFetch<{ email_verified?: boolean }>("/api/auth/email/status");
        if (!cancelled) setEmailVerified(Boolean(status.email_verified));
      } catch {
        if (!cancelled) setEmailVerified(null);
      }
      try {
        const status = await apiFetch<{ enabled?: boolean }>("/api/auth/2fa/status");
        if (!cancelled) setTotpEnabled(Boolean(status.enabled));
      } catch {
        if (!cancelled) setTotpEnabled(false);
      }
      try {
        const status = await apiFetch<{ count?: number }>("/api/auth/passkeys/status");
        if (!cancelled) setPasskeyRegistered(Number(status.count || 0) > 0);
      } catch {
        if (!cancelled) setPasskeyRegistered(false);
      }
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
      setPwErr("New password must be at least 8 characters.");
      return;
    }
    if (newPw !== confirm) {
      setPwErr("New passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: oldPw, new_password: newPw }),
      });
      setOldPw("");
      setNewPw("");
      setConfirm("");
      setPwMsg("Password updated.");
    } catch (error) {
      setPwErr(error instanceof Error ? error.message : "Could not update password.");
    } finally {
      setSaving(false);
    }
  }

  async function resendVerification(): Promise<void> {
    setVerifyMsg("");
    setVerifyErr("");
    setVerifySending(true);
    try {
      const result = await apiFetch<{ delivered?: boolean }>("/api/auth/email/verify-request", { method: "POST" });
      setVerifyMsg(result.delivered ? "Verification email sent." : "SMTP is not configured; retrieve the token from server logs.");
    } catch (error) {
      setVerifyErr(error instanceof Error ? error.message : "Could not request verification.");
    } finally {
      setVerifySending(false);
    }
  }

  async function enrollTotp(): Promise<void> {
    setTotpErr("");
    setTotpMsg("");
    setTotpBusy(true);
    try {
      const result = await apiFetch<{ secret: string; otpauth_url: string }>("/api/auth/2fa/enroll", { method: "POST" });
      setTotpSecret(result.secret);
      setTotpUri(result.otpauth_url);
      setTotpCode("");
      setTotpMsg("Scan or copy the URI into your authenticator app, then enter the six-digit code.");
    } catch (error) {
      setTotpErr(error instanceof Error ? error.message : "Could not start 2FA enrollment.");
    } finally {
      setTotpBusy(false);
    }
  }

  async function confirmTotp(): Promise<void> {
    setTotpErr("");
    setTotpMsg("");
    setTotpBusy(true);
    try {
      const result = await apiFetch<{ enabled: boolean; backup_codes: string[] }>("/api/auth/2fa/confirm", {
        method: "POST",
        body: JSON.stringify({ code: totpCode }),
      });
      setTotpEnabled(result.enabled);
      setTotpBackupCodes(result.backup_codes || []);
      setTotpSecret("");
      setTotpUri("");
      setTotpMsg("Two-factor authentication is enabled. Store the backup codes securely.");
    } catch (error) {
      setTotpErr(error instanceof Error ? error.message : "Could not confirm 2FA code.");
    } finally {
      setTotpBusy(false);
    }
  }

  async function disableTotp(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setTotpErr("");
    setTotpMsg("");
    setTotpBusy(true);
    try {
      await apiFetch("/api/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password: oldPw }) });
      setTotpEnabled(false);
      setTotpBackupCodes([]);
      setOldPw("");
      setTotpMsg("Two-factor authentication is disabled.");
    } catch (error) {
      setTotpErr(error instanceof Error ? error.message : "Could not disable 2FA.");
    } finally {
      setTotpBusy(false);
    }
  }

  async function registerPasskey(): Promise<void> {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      setPasskeyErr("This browser does not support passkeys.");
      return;
    }
    setPasskeyErr("");
    setPasskeyMsg("");
    setPasskeyBusy(true);
    try {
      const response = await apiFetch<{ challenge_id: string; options: Record<string, any> }>("/api/auth/passkeys/register/options", { method: "POST" });
      const credential = await navigator.credentials.create({ publicKey: prepareCreationOptions(response.options) });
      if (!credential) throw new Error("The passkey ceremony was cancelled.");
      await apiFetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        body: JSON.stringify({ challenge_id: response.challenge_id, credential: credentialToJSON(credential) }),
      });
      setPasskeyRegistered(true);
      setPasskeyMsg("Passkey registered for this account.");
    } catch (error) {
      setPasskeyErr(error instanceof Error ? error.message : "Could not register passkey.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-primary/20">
        <CardHeader className="border-b bg-muted/20 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-primary" aria-hidden="true" /> Profile</CardTitle>
              <CardDescription className="mt-1">Identity and security controls for this operator console.</CardDescription>
            </div>
            {me ? <Badge tone="success">Session active</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-xl font-semibold text-primary">
            {isLoadingMe ? <Skeleton className="size-7 rounded-full" /> : (me?.email?.slice(0, 1).toUpperCase() || "?")}
          </div>
          <div className="min-w-[220px] flex-1">
            {isLoadingMe ? <div className="space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div> : <><p className="font-medium text-foreground">{me?.email || "Account unavailable"}</p><div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Operator identity</span>{me?.role ? <Badge tone="muted">{me.role}</Badge> : null}</div></>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="size-4 text-primary" aria-hidden="true" /> Email verification</CardTitle>
          <CardDescription>Confirm ownership of your operator email address.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {emailVerified === null ? <Skeleton className="h-5 w-24" /> : emailVerified ? <Badge tone="success">Verified</Badge> : <><Badge tone="warning">Unverified</Badge><Button variant="outline" size="sm" onClick={() => void resendVerification()} disabled={verifySending}>{verifySending ? <Loader2 className="size-3.5 animate-spin" /> : null} Resend verification</Button></>}
            <Link href="/verify-email" className="text-xs font-medium text-primary hover:underline">Enter token</Link>
          </div>
          {verifyMsg ? <p className="text-xs text-emerald-600" role="status">{verifyMsg}</p> : null}
          {verifyErr ? <p className="text-xs text-destructive" role="alert">{verifyErr}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="size-4 text-primary" aria-hidden="true" /> Change password</CardTitle><CardDescription>Update your console password. Provider keys stay in Settings → API Keys.</CardDescription></CardHeader>
        <CardContent><form onSubmit={changePassword} className="max-w-[420px] space-y-3"><div className="space-y-1.5"><Label htmlFor="cur">Current password</Label><Input id="cur" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} required autoComplete="current-password" /></div><div className="space-y-1.5"><Label htmlFor="new">New password</Label><Input id="new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required autoComplete="new-password" /></div><div className="space-y-1.5"><Label htmlFor="conf">Confirm new password</Label><Input id="conf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></div>{pwErr ? <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert"><AlertCircle className="size-3.5" aria-hidden="true" /> {pwErr}</p> : null}{pwMsg ? <p className="flex items-center gap-1.5 text-xs text-emerald-600" role="status"><Check className="size-3.5" aria-hidden="true" /> {pwMsg}</p> : null}<Button type="submit" disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : null} Update password</Button></form></CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Smartphone className="size-4 text-primary" aria-hidden="true" /> Two-factor (TOTP)</CardTitle><CardDescription>Time-based one-time passwords for authenticator apps.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {totpEnabled ? <><Badge tone="success">Enabled</Badge><form onSubmit={disableTotp} className="space-y-2"><Label htmlFor="totp-disable-password">Confirm password to disable</Label><Input id="totp-disable-password" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} required autoComplete="current-password" /><Button type="submit" variant="outline" size="sm" disabled={totpBusy}>Disable 2FA</Button></form></> : <><Button variant="outline" onClick={() => void enrollTotp()} disabled={totpBusy}>{totpBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Start TOTP enrollment</Button>{totpSecret ? <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs"><p className="font-medium">Secret</p><code className="block break-all font-mono">{totpSecret}</code><p className="font-medium">otpauth URI</p><code className="block break-all font-mono">{totpUri}</code><Label htmlFor="totp-code">Authenticator code</Label><Input id="totp-code" inputMode="numeric" maxLength={6} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="123456" /><Button size="sm" onClick={() => void confirmTotp()} disabled={totpBusy || totpCode.length !== 6}>Confirm and enable</Button></div> : null}</>}
            {totpBackupCodes.length ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="alert"><p className="font-semibold">Save these backup codes now</p><code className="mt-2 grid grid-cols-2 gap-1 font-mono">{totpBackupCodes.map((code) => <span key={code}>{code}</span>)}</code></div> : null}
            {totpMsg ? <p className="text-xs text-emerald-600" role="status">{totpMsg}</p> : null}{totpErr ? <p className="text-xs text-destructive" role="alert">{totpErr}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Fingerprint className="size-4 text-primary" aria-hidden="true" /> Passkeys</CardTitle><CardDescription>WebAuthn platform authenticators provide phishing-resistant passwordless sign-in.</CardDescription></CardHeader>
          <CardContent className="space-y-3"><div className="flex flex-wrap items-center gap-2">{passkeyRegistered ? <Badge tone="success">Registered this session</Badge> : null}<Button variant="outline" onClick={() => void registerPasskey()} disabled={passkeyBusy}>{passkeyBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Register passkey</Button></div>{passkeyMsg ? <p className="text-xs text-emerald-600" role="status">{passkeyMsg}</p> : null}{passkeyErr ? <p className="text-xs text-destructive" role="alert">{passkeyErr}</p> : null}</CardContent>
        </Card>
      </div>
    </div>
  );
}
