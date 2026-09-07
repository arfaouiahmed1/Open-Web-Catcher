"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Fingerprint, Loader2, ShieldCheck } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { TOKEN_STORAGE_KEY } from "@/lib/api-client";
import { credentialToJSON, prepareRequestOptions } from "@/lib/passkeys";
import { safeReturnPath } from "@/lib/safe-route";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/auth-layout";

function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeReturnPath(searchParams.get("next"));
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [show, setShow] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [passkeyBusy, setPasskeyBusy] = useState<boolean>(false);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<string>("");
  const [twoFactorCode, setTwoFactorCode] = useState<string>("");
  const [twoFactorBusy, setTwoFactorBusy] = useState<boolean>(false);

  function completeLogin(accessToken: string): void {
    localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
    router.push(nextPath || "/");
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Invalid email or password." : `Login failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { access_token?: string; requires_2fa?: boolean; challenge?: string };
      if (data.requires_2fa && data.challenge) {
        setTwoFactorChallenge(data.challenge);
        setTwoFactorCode("");
        return;
      }
      if (!data.access_token) throw new Error("Login response did not include an access token.");
      completeLogin(data.access_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the API. Is the backend running on :8000?");
    } finally {
      setSubmitting(false);
    }
  }

  async function onTwoFactorSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError("");
    setTwoFactorBusy(true);
    try {
      const res = await fetch(apiUrl("/api/auth/2fa/challenge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: twoFactorChallenge, code: twoFactorCode.trim() }),
      });
      if (!res.ok) throw new Error(res.status === 429 ? "Too many attempts; try again later." : "Invalid authenticator or backup code.");
      const data = (await res.json()) as { access_token: string };
      completeLogin(data.access_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the authenticator code.");
    } finally {
      setTwoFactorBusy(false);
    }
  }

  async function onPasskeyLogin(): Promise<void> {
    setError("");
    if (!email.trim()) {
      setError("Enter your email before using a passkey.");
      return;
    }
    if (!window.PublicKeyCredential || !navigator.credentials) {
      setError("This browser does not support passkeys.");
      return;
    }
    setPasskeyBusy(true);
    try {
      const optionsResponse = await fetch(apiUrl("/api/auth/passkeys/login/options"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!optionsResponse.ok) throw new Error("Could not start passkey sign-in.");
      const optionsPayload = (await optionsResponse.json()) as { available?: boolean; challenge_id?: string; options?: Record<string, any> };
      if (!optionsPayload.available || !optionsPayload.challenge_id || !optionsPayload.options) throw new Error("No passkey is registered for this email.");
      const credential = await navigator.credentials.get({ publicKey: prepareRequestOptions(optionsPayload.options) });
      if (!credential) throw new Error("The passkey ceremony was cancelled.");
      const verifyResponse = await fetch(apiUrl("/api/auth/passkeys/login/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: optionsPayload.challenge_id, credential: credentialToJSON(credential) }),
      });
      if (!verifyResponse.ok) throw new Error("Passkey verification failed.");
      const result = (await verifyResponse.json()) as { access_token: string };
      completeLogin(result.access_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in with passkey.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-[420px] shadow-xl">
        <CardHeader className="space-y-2 pb-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" /> Secure operator access
          </div>
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>Sign in to the operator console. BYOK — your provider keys stay in Settings.</CardDescription>
        </CardHeader>
        <CardContent>
          {twoFactorChallenge ? (
            <form onSubmit={onTwoFactorSubmit} className="space-y-4">
              <div className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary" role="status">Two-factor authentication is enabled. Enter a current authenticator or backup code.</div>
              <div className="space-y-2"><Label htmlFor="two-factor-code">Authenticator code</Label><Input id="two-factor-code" inputMode="numeric" autoComplete="one-time-code" required value={twoFactorCode} onChange={(ev) => setTwoFactorCode(ev.target.value)} placeholder="123456 or backup-code" /></div>
              {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
              <Button type="submit" className="w-full" disabled={twoFactorBusy}>{twoFactorBusy ? <Loader2 className="size-4 animate-spin" /> : null} {twoFactorBusy ? "Verifying…" : "Verify and sign in"}</Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setTwoFactorChallenge(""); setTwoFactorCode(""); setError(""); }}>Use password again</Button>
            </form>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" required autoComplete="username" value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" /></div>
              <div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="password">Password</Label><button type="button" onClick={() => setShow((v) => !v)} className="text-[11px] text-muted-foreground hover:text-foreground" aria-label={show ? "Hide password" : "Show password"}>{show ? <EyeOff className="inline size-3" /> : <Eye className="inline size-3" />} {show ? "Hide" : "Show"}</button></div><Input id="password" type={show ? "text" : "password"} required autoComplete="current-password" value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="••••••••" /></div>
              <div className="flex justify-end"><Link href="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">Forgot password?</Link></div>
              {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
              <Button type="submit" className="w-full" disabled={submitting || passkeyBusy}>{submitting ? <Loader2 className="size-4 animate-spin" /> : null} {submitting ? "Signing in…" : "Sign in"}</Button>
              <Button type="button" variant="outline" className="w-full" onClick={() => void onPasskeyLogin()} disabled={submitting || passkeyBusy}><Fingerprint className="size-4" aria-hidden="true" /> {passkeyBusy ? "Using passkey…" : "Use passkey"}</Button>
              <p className="text-center text-xs text-muted-foreground">No account yet? <Link href={nextPath ? `/signup?next=${encodeURIComponent(nextPath)}` : "/signup"} className="font-medium text-primary hover:underline">Create account</Link> {" · "}<Link href="/" className="hover:text-foreground">Back to overview</Link></p>
            </form>
          )}
        </CardContent>
      </Card>
      <p className="mt-4 max-w-[420px] text-center text-[11px] leading-relaxed text-muted-foreground">First user? Use <span className="font-mono text-foreground">Create account</span> — it calls <span className="font-mono">POST /api/auth/bootstrap-admin</span> atomically (single winner). No default credentials.</p>
    </AuthLayout>
  );
}

export default function LoginPage(): React.JSX.Element {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
