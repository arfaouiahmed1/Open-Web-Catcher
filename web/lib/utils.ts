import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: unknown): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number((value as number) || 0));
}

export function formatNumber(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number((value as number) || 0));
}

export function formatPercent(value: unknown): string {
  return `${(Number((value as number) || 0) * 100).toFixed(1)}%`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
