import { Suspense } from "react";
import { LandingPageClient } from "./landing-client";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="min-h-[40vh]" />}>
      <LandingPageClient />
    </Suspense>
  );
}
