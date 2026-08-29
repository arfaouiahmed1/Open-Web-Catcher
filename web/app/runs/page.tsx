// @ts-nocheck
import { Suspense } from "react";

import { RunsPage } from "@/components/console/runs/runs-page";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-[40vh]" />}>
      <RunsPage />
    </Suspense>
  );
}
