"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { AuthLayout } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ResetPasswordForm(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string>(searchParams.get("token") || "");
  const [password, setPassword] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [show, setShow] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [done, setDone] = useState<boolean>(false);
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
      const res = await fetch(apiUrl("/api/auth/password-reset/confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), new_password: password }),
      });
      if (!res.ok) {
        setError(
          res.status === 400
            ? "Invalid or expired reset token. Request a new link."
            : `Reset failed (${res.status}).`
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
            <KeyRound className="size-3.5 text-primary" /> Account recovery
          </div>
          <CardTitle className="text-xl">Reset password</CardTitle>
          <CardDescription>Paste your reset token and choose a new password.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400" role="status">
                Password updated. You can now log in with the new password.
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
                <Label htmlFor="token">Reset token</Label>
                <Input
                  id="token"
                  required
                  autoComplete="off"
                  value={token}
                  onChange={(ev) => setToken(ev.target.value)}
                  placeholder="Paste the token from your reset link"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">New password (8+ chars)</Label>
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    aria-label={show ? "Hide password" : "Show password"}
                  >
                    {show ? <EyeOff className="inline size-3" /> : <Eye className="inline size-3" />}{" "}
                    {show ? "Hide" : "Show"}
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
                <Label htmlFor="confirm">Confirm new password</Label>
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
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}{" "}
                {submitting ? "Resetting…" : "Reset password"}
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

export default function ResetPasswordPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
