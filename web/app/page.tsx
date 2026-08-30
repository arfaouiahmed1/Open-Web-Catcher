import { Suspense } from "react";

import { OverviewPage } from "@/components/console/overview/overview-page";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="min-h-[40vh]" />}>
      <OverviewPage />
    </Suspense>
  );
}
