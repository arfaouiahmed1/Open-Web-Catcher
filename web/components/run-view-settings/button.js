"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunViewSettingsPanel } from "@/components/run-view-settings/panel";

export function RunViewSettingsButton({ settings, update, reset }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" title="View settings" variant={open ? "secondary" : "outline"} size="sm">
          <Settings2 data-icon="inline-start" />
          <span>View</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="end" sideOffset={10}>
        <RunViewSettingsPanel
          settings={settings}
          update={update}
          reset={reset}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
