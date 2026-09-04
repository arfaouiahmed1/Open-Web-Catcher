import { Suspense } from "react";

import { LoadingView } from "@/components/console/common/loading-view";
import { ProvidersPage } from "@/components/console/providers/providers-page";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingView variant="spinner" label="Loading..." />}>
      <ProvidersPage />
    </Suspense>
  );
}
