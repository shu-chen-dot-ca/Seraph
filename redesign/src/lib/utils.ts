import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "<1m ago", "5m ago", "3h ago", "2d ago", "4mo ago", "2y ago". Used wherever a list shows how old something is.
export function timeAgo(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) {
    return "<1m ago";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  if (seconds < 86400 * 30) {
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  if (seconds < 86400 * 365) {
    return `${Math.floor(seconds / (86400 * 30))}mo ago`;
  }
  return `${Math.floor(seconds / (86400 * 365))}y ago`;
}
