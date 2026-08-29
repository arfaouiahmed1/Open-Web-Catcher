"use client";

import React from "react";
import { ScreenshotCard } from "@/components/library";

export default function ScreenshotCardStory() {
  return (
    <>
      <ScreenshotCard alt="" state="loading" loadingLabel="Loading screenshot…" />
      <ScreenshotCard alt="" state="error" errorLabel="Screenshot fetch failed." />
      <ScreenshotCard alt="missing evidence" />
      <div className="flex flex-wrap gap-4">
        {/* Plain remote URL passes through untouched. */}
        <ScreenshotCard
          src="https://picsum.photos/seed/owc-evidence/320/180"
          alt="Portal landing page"
          caption="Direct URL"
          className="w-64"
        />
        {/* DB blobref pointer resolves against the bare /blobs/{key} route. */}
        <ScreenshotCard
          src="blobref:0a1b2c3d4e5f6071"
          alt="Player frame at t=42s"
          caption="blobref → /api/blobs resolution"
          className="w-64"
        />
      </div>
    </>
  );
}
