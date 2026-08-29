"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

const THEMES = { light: "", dark: ".dark" } as const;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType<unknown>;
    color?: string;
    theme?: Record<string, string>;
  }
>;

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

export function useChart(): ChartContextValue {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used within ChartContainer");
  return ctx;
}

export type ChartContainerProps = React.ComponentPropsWithoutRef<"div"> & {
  config: ChartConfig;
  id?: string;
};

export function ChartContainer({ id, className, children, config, ...props }: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${(id || uniqueId).replace(/:/g, "")}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/30 [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config || {}).filter(
    ([, c]) => c.theme || c.color,
  );
  if (!colorConfig.length) return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      (itemConfig.theme as Record<string, string> | undefined)?.[theme] || itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .filter(Boolean)
  .join("\n")}
}
`,
          )
          .join("\n"),
      }}
    />
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export type ChartTooltipContentProps = React.ComponentPropsWithoutRef<"div"> & {
  active?: boolean;
  payload?: Array<Record<string, unknown> & { dataKey?: string; name?: string; value?: unknown; color?: string; payload?: Record<string, unknown>; hideIndicator?: boolean }>;
  indicator?: "dot" | "line" | "dashed";
  hideLabel?: boolean;
  hideIndicator?: boolean;
  label?: unknown;
  labelFormatter?: (value: unknown, payload: unknown[]) => React.ReactNode;
  labelClassName?: string;
  formatter?: (value: unknown, name: unknown, item: unknown, index: number, payload: unknown) => React.ReactNode;
  color?: string;
  nameKey?: string;
  labelKey?: string;
};

export const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  function ChartTooltipContent(
    {
      active,
      payload,
      className,
      indicator = "dot",
      hideLabel = false,
      hideIndicator = false,
      label,
      labelFormatter,
      labelClassName,
      formatter,
      color,
      nameKey,
      labelKey,
    },
    ref,
  ) {
    const { config } = useChart();

    const tooltipLabel = React.useMemo(() => {
      if (hideLabel || !payload?.length) return null;
      const [item] = payload as Array<Record<string, unknown>>;
      const key = `${(labelKey as string) || (item.dataKey as string) || (item.name as string) || "value"}`;
      const itemConfig = getPayloadConfigFromPayload(config, item as unknown, key);
      const value =
        !labelKey && typeof label === "string"
          ? (config[label]?.label as string) || (label as string)
          : itemConfig?.label;
      if (labelFormatter) {
        return (
          <div className={cn("font-medium", labelClassName)}>
            {labelFormatter(value, payload as unknown[])}
          </div>
        );
      }
      if (!value) return null;
      return <div className={cn("font-medium", labelClassName)}>{value as React.ReactNode}</div>;
    }, [hideLabel, payload, label, labelKey, labelClassName, labelFormatter, config]);

    if (!active || !payload?.length) return null;
    const nestLabel = payload.length === 1 && indicator !== "dot";

    return (
      <div
        ref={ref}
        className={cn(
          "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
          className,
        )}
      >
        {!nestLabel ? tooltipLabel : null}
        <div className="grid gap-1.5">
          {(payload as Array<Record<string, unknown>>).map((item, idx) => {
            const raw = item as Record<string, unknown> & { dataKey?: unknown; name?: unknown; value?: unknown; color?: string; payload?: Record<string, unknown> };
            const key = `${(nameKey as string) || (raw.name as string) || (raw.dataKey as string) || "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, raw as unknown, key);
            const indicatorColor = (color as string) || (raw.payload?.fill as string) || (raw.color as string);
            return (
              <div
                key={(raw.dataKey as string) || String(idx)}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && raw?.value !== undefined && raw.name ? (
                  formatter(raw.value as unknown, raw.name as unknown, raw, idx, raw.payload as unknown)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn(
                            "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                            {
                              "h-2.5 w-2.5": indicator === "dot",
                              "w-1": indicator === "line",
                              "w-0 border-[1.5px] border-dashed bg-transparent":
                                indicator === "dashed",
                              "my-0.5": nestLabel && indicator === "dashed",
                            },
                          )}
                          style={
                            {
                              "--color-bg": indicatorColor,
                              "--color-border": indicatorColor,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">
                          {(itemConfig?.label as React.ReactNode) || (raw.name as React.ReactNode)}
                        </span>
                      </div>
                      {raw.value !== undefined && (
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {(raw.value as number | string).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);
ChartTooltipContent.displayName = "ChartTooltipContent";

export const ChartLegend = RechartsPrimitive.Legend;

export type ChartLegendContentProps = React.ComponentPropsWithoutRef<"div"> & {
  hideIcon?: boolean;
  payload?: Array<Record<string, unknown> & { value?: string; color?: string; dataKey?: string }>;
  verticalAlign?: "top" | "bottom" | "middle";
  nameKey?: string;
};

export function ChartLegendContent({ className, hideIcon = false, payload, verticalAlign = "bottom", nameKey }: ChartLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload.map((item) => {
        const raw = item as Record<string, unknown> & { value?: unknown; dataKey?: unknown; color?: string };
        const key = `${(nameKey as string) || (raw.dataKey as string) || "value"}`;
        const itemConfig = getPayloadConfigFromPayload(config, raw as unknown, key);
        return (
          <div
            key={String(raw.value)}
            className={cn(
              "flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
            )}
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: raw.color }}
              />
            )}
            {itemConfig?.label as React.ReactNode}
          </div>
        );
      })}
    </div>
  );
}

function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string
): ChartConfig[string] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const payloadPayload =
    "payload" in payload && typeof (payload as Record<string, unknown>).payload === "object" && (payload as Record<string, unknown>).payload !== null
      ? (payload as Record<string, unknown>).payload as Record<string, unknown>
      : undefined;
  let configLabelKey: string = key;
  const rec = payload as Record<string, unknown>;
  if (key in rec && typeof rec[key] === "string") {
    configLabelKey = rec[key] as string;
  } else if (payloadPayload && key in payloadPayload && typeof payloadPayload[key] === "string") {
    configLabelKey = payloadPayload[key] as string;
  }
  return configLabelKey in (config || {}) ? config[configLabelKey] : config[key];
}
