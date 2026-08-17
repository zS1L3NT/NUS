import { execFile } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ArchiveConfig, CanvasWarning } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function canvasJson<T>(config: ArchiveConfig, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(
    config.canvasBinary,
    [...args, "--instance", config.canvasInstance, "-o", "json", "--no-cache", "--quiet"],
    { maxBuffer: 250 * 1024 * 1024 },
  );
  const output = stdout.trim();
  if (/^No overrides\b/i.test(output) || /^No .+ found\.?$/i.test(output)) return [] as T;
  return JSON.parse(output) as T;
}

export async function canvasDownload(config: ArchiveConfig, fileId: number, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  await execFileAsync(
    config.canvasBinary,
    [
      "files",
      "download",
      String(fileId),
      "--destination",
      temporary,
      "--instance",
      config.canvasInstance,
      "--no-cache",
      "--quiet",
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  await rename(temporary, destination);
}

interface StructuredCanvasError {
  command?: string;
  error: unknown;
}

export interface CanvasErrorDetails {
  raw: string;
  structured?: StructuredCanvasError;
}

export function canvasError(error: unknown): CanvasErrorDetails {
  const candidate = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const raw = String(candidate.stderr || candidate.message || error).trim();
  const structured = raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((item): item is Record<string, unknown> => Boolean(item?.error));
  return { raw, structured: structured as unknown as StructuredCanvasError | undefined };
}

export async function collectResource<T>(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  kind: string,
  args: string[],
  fallback: T = [] as T,
): Promise<T> {
  try {
    return await canvasJson(config, args);
  } catch (error) {
    const { raw, structured } = canvasError(error);
    const message = structured
      ? `${structured.command || kind}: ${String(structured.error).trim()}`
      : raw.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d/g, "<timestamp>");
    warnings.push({ kind, message });
    return fallback;
  }
}
