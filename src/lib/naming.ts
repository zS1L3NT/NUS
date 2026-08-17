import path from "node:path";
import type { Positioned } from "../types.ts";
import { decodeHtml } from "./text.ts";

interface OrderedModule extends Positioned {
  items?: Array<{ position?: number | string | null; type: string; page_url?: string; content_id?: number }>;
}

interface OrderedAssignment extends Positioned {
  assignment_group_id: number;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

export function safeName(value: unknown, fallback = "untitled"): string {
  const normalized = stripControlCharacters(decodeHtml(String(value ?? "")).normalize("NFKC"))
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return (normalized || fallback).slice(0, 180);
}

export function slug(value: unknown, fallback = "untitled"): string {
  return (
    safeName(value, fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

export function orderPrefix(position: unknown, width = 3): string {
  const numericPosition = Number(position);
  if (!Number.isFinite(numericPosition) || numericPosition < 1) return "";
  return `(${String(Math.trunc(numericPosition)).padStart(width, "0")}) `;
}

export function appendFilenameSuffix(filename: string, suffix: string): string {
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} ${suffix}${extension}`;
}

export function collisionSafeNames<T>(
  items: T[],
  nameForItem: (item: T) => unknown,
  idForItem: (item: T) => unknown,
): Map<T, string> {
  const baseNames = items.map((item) => safeName(nameForItem(item)));
  const counts = new Map();
  for (const baseName of baseNames) {
    const key = baseName.normalize("NFKC").toLocaleLowerCase("en");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Map(
    items.map((item, index) => {
      const baseName = baseNames[index] ?? safeName(nameForItem(item));
      const key = baseName.normalize("NFKC").toLocaleLowerCase("en");
      const name = counts.get(key) > 1 ? appendFilenameSuffix(baseName, `[Canvas ${idForItem(item)}]`) : baseName;
      return [item, name];
    }),
  );
}

function positioned<T extends { position?: number | string | null }>(items: T[] = []): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPosition = Number(left.item.position);
      const rightPosition = Number(right.item.position);
      const positionDifference =
        (Number.isFinite(leftPosition) ? leftPosition : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(rightPosition) ? rightPosition : Number.MAX_SAFE_INTEGER);
      return positionDifference || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function canvasModuleOrder(modules: OrderedModule[] = []): {
  moduleRanks: Map<number, number>;
  pageRanks: Map<string, number>;
  assignmentRanks: Map<number, number>;
  fileRanks: Map<number, number>;
} {
  const moduleRanks = new Map();
  const pageRanks = new Map();
  const assignmentRanks = new Map();
  const fileRanks = new Map();
  let itemRank = 0;
  positioned(modules).forEach((module, moduleIndex) => {
    moduleRanks.set(Number(module.id), moduleIndex + 1);
    for (const item of positioned(module.items || [])) {
      itemRank += 1;
      if (item.type === "Page" && item.page_url && !pageRanks.has(String(item.page_url)))
        pageRanks.set(String(item.page_url), itemRank);
      if (item.type === "Assignment" && item.content_id && !assignmentRanks.has(Number(item.content_id)))
        assignmentRanks.set(Number(item.content_id), itemRank);
      if (item.type === "File" && item.content_id && !fileRanks.has(Number(item.content_id)))
        fileRanks.set(Number(item.content_id), itemRank);
    }
  });
  return { moduleRanks, pageRanks, assignmentRanks, fileRanks };
}

export function canvasAssignmentOrder(
  assignments: OrderedAssignment[] = [],
  assignmentGroups: Positioned[] = [],
): Map<number, number> {
  const groupPositions = new Map(positioned(assignmentGroups).map((group, index) => [Number(group.id), index + 1]));
  const ordered = assignments
    .map((assignment, index) => ({ assignment, index }))
    .filter(
      ({ assignment }) =>
        groupPositions.has(Number(assignment.assignment_group_id)) && Number.isFinite(Number(assignment.position)),
    )
    .sort(
      (left, right) =>
        (groupPositions.get(Number(left.assignment.assignment_group_id)) ?? Number.MAX_SAFE_INTEGER) -
          (groupPositions.get(Number(right.assignment.assignment_group_id)) ?? Number.MAX_SAFE_INTEGER) ||
        Number(left.assignment.position) - Number(right.assignment.position) ||
        left.index - right.index,
    );
  return new Map(ordered.map(({ assignment }, index) => [Number(assignment.id), index + 1]));
}
