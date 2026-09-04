import { Suspense } from "react";

import { LoadingView } from "@/components/console/common/loading-view";
import { RunsPage } from "@/components/console/runs/runs-page";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingView variant="spinner" label="Loading..." />}>
      <RunsPage />
    </Suspense>
  );
}
