import { Suspense } from "react";

import { RunDetailPage } from "@/components/console/run-detail/run-detail-page";
import { LoadingView } from "@/components/console/common/loading-view";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingView variant="spinner" label="Loading..." />}>
      <RunDetailPage />
    </Suspense>
  );
}
