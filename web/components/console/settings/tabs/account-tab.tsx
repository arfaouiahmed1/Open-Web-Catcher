"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, ShieldCheck, Smartphone, Fingerprint, AlertCircle, Check, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AccountTab(): React.JSX.Element {
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [oldPw, setOldPw] = useState<string>("");
  const [newPw, setNewPw] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [pwMsg, setPwMsg] = useState<string>("");
  const [pwErr, setPwErr] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [isLoadingMe, setIsLoadingMe] = useState<boolean>(true);


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
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: oldPw, new_password: newPw }),
      });
      setPwMsg("Password updated.");
      setOldPw("");
      setNewPw("");
      setConfirm("");
    } catch (error) {
      setPwErr(error instanceof Error ? error.message : "Could not reach API.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-primary/20">
        <CardHeader className="border-b bg-muted/20 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-primary" /> Profile
              </CardTitle>
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
            {isLoadingMe ? (
              <div className="space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div>
            ) : (
              <>
                <p className="font-medium text-foreground">{me?.email || "Account unavailable"}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Operator identity</span>
                  {me?.role ? <Badge tone="muted">{me.role}</Badge> : null}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="size-4 text-primary" /> Change password</CardTitle>
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
              Backend route is available and protected by the current session.
            </p>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Smartphone className="size-4 text-primary" /> Two-factor (TOTP)
          </CardTitle>
          <CardDescription>Time-based one-time passwords for authenticator apps.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled>Coming soon</Button>
            <Badge tone="muted">Backend contract pending</Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">
            TOTP is intentionally disabled until server-side enrollment, verification, and recovery storage are implemented.
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled>Coming soon</Button>
            <Badge tone="muted">Backend contract pending</Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Passkeys are intentionally disabled until WebAuthn challenge persistence and verification are implemented server-side.
          </p>
        </CardContent>
      </Card>

      </div>
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
