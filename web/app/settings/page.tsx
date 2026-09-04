import { Suspense } from "react";

import { LoadingView } from "@/components/console/common/loading-view";
import { SettingsPage } from "@/components/console/settings/settings-page";

export default function Page(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingView variant="spinner" label="Loading..." />}>
      <SettingsPage />
    </Suspense>
  );
}
