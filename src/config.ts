import { homedir } from "node:os";
import path from "node:path";
import { readJson } from "./lib.ts";
import type { ArchiveConfig, ConfiguredCourse, KnownContent, SyncOptions } from "./types.ts";

type RawArchiveConfig = Omit<ArchiveConfig, "courses"> & {
  courses: Array<Omit<ConfiguredCourse, "knownContent">>;
};

export function resolvePath(value: unknown, baseDirectory: string): string {
  const text = String(value ?? "");
  const expanded = text === "~" ? homedir() : text.startsWith("~/") ? path.join(homedir(), text.slice(2)) : text;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDirectory, expanded);
}

export async function loadConfig(projectDirectory: string): Promise<ArchiveConfig> {
  const config = await readJson<RawArchiveConfig | null>(path.join(projectDirectory, "config.json"), null);
  if (!config) throw new Error("Unable to read config.json");
  const knownContent = await readJson<Record<string, KnownContent>>(
    resolvePath(config.knownContent || "known-content.json", projectDirectory),
    {},
  );
  return {
    ...config,
    canvasBinary: resolvePath(config.canvasBinary, projectDirectory),
    rawDirectory: resolvePath(config.rawDirectory || "./raw", projectDirectory),
    viewDirectory: resolvePath(config.viewDirectory || "~/NUS Canvas", projectDirectory),
    courses: config.courses.map((course) => ({ ...course, knownContent: knownContent[course.code] || {} })),
  };
}

export function parseOptions<C extends { code: string }>(
  config: Pick<ArchiveConfig, "downloadFiles" | "extractText"> & { courses: C[] },
  argv: string[],
): Omit<SyncOptions, "courses"> & { courses: C[] } {
  const courseFlag = argv.indexOf("--course");
  const requestedCourse = courseFlag >= 0 ? argv[courseFlag + 1]?.toUpperCase() : null;
  const courses = requestedCourse ? config.courses.filter((course) => course.code === requestedCourse) : config.courses;
  if (!courses.length) throw new Error(`Unknown course: ${requestedCourse}`);
  return {
    courses,
    downloadFiles: config.downloadFiles && !argv.includes("--metadata-only"),
    extractText: config.extractText && !argv.includes("--no-extract") && !argv.includes("--metadata-only"),
  };
}
