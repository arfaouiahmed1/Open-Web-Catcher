import { Suspense } from "react";

import { LivePage } from "@/components/console/live/live-page";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="min-h-[40vh]" />}>
      <LivePage />
    </Suspense>
  );
}
