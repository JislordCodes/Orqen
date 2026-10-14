import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function slugify(name: string) {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return /^[a-z0-9]/.test(s) ? s : `p-${s}`.slice(0, 30) || "main";
}

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function languageFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
      py: "python", json: "json", md: "markdown", html: "html", css: "css", scss: "scss",
      yml: "yaml", yaml: "yaml", sql: "sql", sh: "shell", toml: "ini", env: "ini", prisma: "graphql",
      dockerfile: "dockerfile",
    } as Record<string, string>
  )[ext] ?? (path.toLowerCase().endsWith("dockerfile") ? "dockerfile" : "plaintext");
}
