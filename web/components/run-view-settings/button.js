"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RunViewSettingsPanel } from "@/components/run-view-settings/panel";

export function RunViewSettingsButton({ settings, update, reset }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="View settings"
        variant={open ? "secondary" : "outline"}
        size="sm"
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span>View</span>
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-80">
            <RunViewSettingsPanel
              settings={settings}
              update={update}
              reset={reset}
              onClose={() => setOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
}
