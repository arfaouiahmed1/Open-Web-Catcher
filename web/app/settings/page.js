import { Suspense } from "react";

import { SettingsPage } from "@/components/console/settings/settings-page";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-[40vh]" />}>
      <SettingsPage />
    </Suspense>
  );
}
