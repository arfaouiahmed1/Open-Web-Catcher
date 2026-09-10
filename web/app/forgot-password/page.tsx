"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { AuthLayout } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ForgotPasswordForm(): React.JSX.Element {
  const [email, setEmail] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [sent, setSent] = useState<boolean>(false);
  const [resetLink, setResetLink] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/auth/password-reset/request"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        setError(`Request failed (${res.status}).`);
        return;
      }
      const payload = (await res.json()) as { reset_token?: string };
      setResetLink(payload.reset_token ? `/reset-password?token=${encodeURIComponent(payload.reset_token)}` : "");
      setSent(true);
    } catch {
      setError("Could not reach the API. Is the backend running on :8000?");
    } finally {
      setSubmitting(false);
    }

  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-[420px] shadow-xl">
        <CardHeader className="space-y-2 pb-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            <KeyRound className="size-3.5 text-primary" /> Account recovery
          </div>
          <CardTitle className="text-xl">Forgot password</CardTitle>
          <CardDescription>
            Enter your operator email. If an account exists, a reset link will be sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4">
              <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400" role="status">
                {resetLink ? "Local recovery mode is active. Continue with the one-time reset link below." : "If an account exists for that email, a reset link is on its way. It expires in 30 minutes and can only be used once."}
              </p>
              {resetLink ? (
                <Link href={resetLink} className="block rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-center text-xs font-medium text-primary hover:bg-primary/15">
                  Continue to reset password
                </Link>
              ) : null}
              <p className="text-center text-xs text-muted-foreground">
                Have a token?{" "}
                <Link href="/reset-password" className="font-medium text-primary hover:underline">
                  Reset password
                </Link>
                {" · "}
                <Link href="/login" className="hover:text-foreground">
                  Back to log in
                </Link>
              </p>
            </div>
          ) : (
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
              {error ? (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}{" "}
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Remember it?{" "}
                <Link href="/login" className="font-medium text-primary hover:underline">
                  Log in
                </Link>
                {" · "}
                <Link href="/" className="hover:text-foreground">
                  Back to overview
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export default function ForgotPasswordPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
