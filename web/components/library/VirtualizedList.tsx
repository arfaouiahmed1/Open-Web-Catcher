"use client";

import React, { memo, useCallback } from "react";
import { FixedSizeList as List } from "react-window";

// Lightweight virtualized list wrapper for T44 perf hygiene.
// Falls back to plain rendering on server / test (no window) or small lists.
export interface VirtualizedListProps<T> {
  items: T[];
  height?: number;
  itemSize?: number;
  overscanCount?: number;
  renderItem: (item: T, index: number, style?: React.CSSProperties) => React.ReactNode;
  estimatedThreshold?: number;
}

function VirtualizedListInner<T>({
  items,
  height = 400,
  itemSize = 56,
  overscanCount = 5,
  renderItem,
}: VirtualizedListProps<T>) {
  if (!items.length) return null;
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  // Server / test fallback + small-list fast path (< threshold) — plain map is cheaper than window overhead.
  if (!isBrowser || items.length < 50) {
    return (
      <div className="divide-y divide-border/50">
        {items.map((it, idx) => (
          <div key={idx} style={{ contentVisibility: "auto" as unknown as string, containIntrinsicSize: `0 ${itemSize}px` } as React.CSSProperties}>
            {renderItem(it, idx)}
          </div>
        ))}
      </div>
    );
  }
  const Row = memo(function Row({ index, style }: { index: number; style: React.CSSProperties }) {
    const item = items[index];
    return <div style={style}>{renderItem(item, index)}</div>;
  });
  // react-window v2 API: FixedSizeList with rowComponent prop alternative — keep v1 compat by using children-as-function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AnyList = List as unknown as React.ComponentType<any>;
  return (
    <AnyList
      height={height}
      itemCount={items.length}
      itemSize={itemSize}
      width="100%"
      overscanCount={overscanCount}
      style={{ overflowX: "hidden" }}
    >
      {({ index, style }: { index: number; style: React.CSSProperties }) => <Row index={index} style={style} />}
    </AnyList>
  );
}

export const VirtualizedList = memo(VirtualizedListInner) as typeof VirtualizedListInner;
