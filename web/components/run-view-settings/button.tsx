"use client";

import { Settings2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunViewSettingsPanel } from "@/components/run-view-settings/panel";
import type { RunViewSettings } from "@/components/run-view-settings";

export interface RunViewSettingsButtonProps {
  settings: RunViewSettings;
  update: (key: keyof RunViewSettings, value: unknown) => void;
  reset: () => void;
}

export const RunViewSettingsButton = React.memo(function RunViewSettingsButton({
  settings,
  update,
  reset,
}: RunViewSettingsButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" title="View settings" variant={open ? "secondary" : "outline"} size="sm">
          <Settings2 data-icon="inline-start" />
          <span>View</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="end" sideOffset={10}>
        <RunViewSettingsPanel settings={settings} update={update} reset={reset} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
});
