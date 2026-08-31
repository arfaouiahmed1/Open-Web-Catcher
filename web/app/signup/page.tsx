"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/auth-layout";

const TOKEN_KEY = "owc_token";

function SignupForm(): React.JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [show, setShow] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      // First user: bootstrap-admin is the only creation path (atomic INSERT WHERE NOT EXISTS)
      const boot = await fetch(apiUrl("/api/auth/bootstrap-admin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const bootData: { created?: boolean; email?: string } = (await boot.json().catch(() => ({}))) as {
        created?: boolean;
        email?: string;
      };
      if (!boot.ok) {
        const msg = (bootData as unknown as { detail?: string })?.detail || `Signup failed (${boot.status}).`;
        // If a user already exists, bootstrap returns {created:false} 200 — fall through to login
        if (boot.status !== 200) {
          setError(msg);
          return;
        }
      }
      if (bootData.created === false) {
        setError("An account already exists. Please log in instead.");
        return;
      }
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        setError("Account created — please log in.");
        router.push("/login");
        return;
      }
      const data: { access_token: string } = (await res.json()) as { access_token: string };
      localStorage.setItem(TOKEN_KEY, data.access_token);
      router.push("/");
    } catch {
      setError("Could not reach the API. Is the backend running on :8000?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-[460px] shadow-xl">
        <CardHeader className="space-y-2 pb-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" /> First admin — single winner
          </div>
          <CardTitle className="text-xl">Create account</CardTitle>
          <CardDescription>
            The first account becomes admin (atomic <span className="font-mono">bootstrap-admin</span>). After that, use log in. BYOK
            — provider keys are set per-agent in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password (8+ chars)</Label>
                <button type="button" onClick={() => setShow((v) => !v)} className="text-[11px] text-muted-foreground hover:text-foreground">
                  {show ? <EyeOff className="inline size-3" /> : <Eye className="inline size-3" />} {show ? "Hide" : "Show"}
                </button>
              </div>
              <Input
                id="password"
                type={show ? "text" : "password"}
                required
                autoComplete="new-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type={show ? "text" : "password"}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(ev) => setConfirm(ev.target.value)}
                placeholder="••••••••"
              />
            </div>
            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null} {submitting ? "Creating…" : "Create account"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-primary hover:underline">
                Log in
              </Link>
              {" · "}
              <Link href="/" className="hover:text-foreground">
                Back to overview
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export default function SignupPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
