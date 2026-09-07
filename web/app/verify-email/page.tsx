"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, MailCheck } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { AuthLayout } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function VerifyEmailForm(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string>(searchParams.get("token") || "");
  const [error, setError] = useState<string>("");
  const [done, setDone] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/auth/email/verify-confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        setError(
          res.status === 400
            ? "Invalid or expired verification token. Request a new one from Settings → Account."
            : `Verification failed (${res.status}).`
        );
        return;
      }
      setDone(true);
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
            <MailCheck className="size-3.5 text-primary" /> Email verification
          </div>
          <CardTitle className="text-xl">Verify your email</CardTitle>
          <CardDescription>Paste the token from your verification email.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400" role="status">
                Email verified. Your operator account is fully activated.
              </p>
              <p className="text-center text-xs text-muted-foreground">
                <Link href="/login" className="font-medium text-primary hover:underline">
                  Log in
                </Link>
                {" · "}
                <Link href="/" className="hover:text-foreground">
                  Back to overview
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="token">Verification token</Label>
                <Input
                  id="token"
                  required
                  autoComplete="off"
                  value={token}
                  onChange={(ev) => setToken(ev.target.value)}
                  placeholder="Paste the token from your email"
                />
              </div>
              {error ? (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}{" "}
                {submitting ? "Verifying…" : "Verify email"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
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

export default function VerifyEmailPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <VerifyEmailForm />
    </Suspense>
  );
}
