"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/api-client";
import { LandingHero } from "@/components/landing/landing-hero";
import { OverviewPage } from "@/components/console/overview/overview-page";
import { AuthLayout } from "@/components/auth/auth-layout";
export function LandingPageClient(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(Boolean(getToken()));
    function onStorage(): void {
      setAuthed(Boolean(getToken()));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (authed === null) return <div className="min-h-[40vh]" />;
  if (authed) return <OverviewPage />;
  return (
    <AuthLayout fullWidth>
      <LandingHero />
    </AuthLayout>
  );
}
