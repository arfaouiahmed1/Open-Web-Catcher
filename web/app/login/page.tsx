"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl } from "@/lib/api";

const TOKEN_KEY = "owc_token";

function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Invalid email or password."
            : `Login failed (${response.status}).`
        );
        return;
      }
      const data: { access_token: string } = await response.json() as { access_token: string };
      localStorage.setItem(TOKEN_KEY, data.access_token);
      const next = searchParams.get("next");
      router.push(next && next.startsWith("/") ? next : "/");
    } catch {
      setError("Could not reach the API.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4"
      style={{ background: "var(--bg, #0b0e14)" }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border p-8 shadow-xl"
        style={{
          background: "var(--panel, #12161f)",
          borderColor: "var(--line, #232a38)",
          color: "var(--ink, #e6e9f0)"
        }}
      >
        <h1 className="text-lg font-semibold">Open Web Catcher</h1>
        <p className="mt-1 text-xs" style={{ color: "var(--mute, #7a8399)" }}>
          Sign in to the operator console.
        </p>

        <label className="mt-6 block text-xs font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/40"
          style={{
            background: "var(--card, #0f131c)",
            borderColor: "var(--line, #232a38)"
          }}
        />

        <label className="mt-4 block text-xs font-medium" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/40"
          style={{
            background: "var(--card, #0f131c)",
            borderColor: "var(--line, #232a38)"
          }}
        />

        {error && (
          <p className="mt-3 text-xs" style={{ color: "var(--rose, #f87171)" }} role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
