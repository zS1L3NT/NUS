import type {
  ArchiveChange,
  AssignmentDate,
  AssignmentOverride,
  CanvasAssignment,
  CanvasWarning,
  ChangeTotals,
} from "./types.ts";

export function sanitizeCanvasSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitizeCanvasSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeCanvasSecrets(item)])) as T;
  }
  if (typeof value !== "string") return value;
  return value.replace(/([?&](?:verifier|access_token)=)[^&"'\s<>]+/gi, "$1<redacted>") as T;
}

export function embeddedFileIds(value: unknown): Set<number> {
  const ids = new Set<number>();
  const serialized = JSON.stringify(value) ?? "";
  for (const match of serialized.matchAll(/\/files\/(\d+)/g)) ids.add(Number(match[1]));
  return ids;
}

export function assignmentDates(
  assignment: Pick<CanvasAssignment, "due_at" | "unlock_at" | "lock_at">,
  overrides?: AssignmentOverride[],
): AssignmentDate[] {
  const dates: AssignmentDate[] = [];
  if (assignment.due_at)
    dates.push({
      audience: "Course",
      due_at: assignment.due_at,
      unlock_at: assignment.unlock_at,
      lock_at: assignment.lock_at,
    });
  for (const override of overrides ?? []) {
    dates.push({
      audience: override.title || `Override ${override.id}`,
      due_at: override.due_at,
      unlock_at: override.unlock_at,
      lock_at: override.lock_at,
      override_id: override.id,
      course_section_id: override.course_section_id || null,
      group_id: override.group_id || null,
      student_ids: override.student_ids || [],
    });
  }
  return dates;
}

export function incompleteDocumentKinds(warnings: Array<Pick<CanvasWarning, "kind">> = []): string[] {
  const warningKinds = new Set(warnings.map((warning) => warning.kind));
  const mappings: Array<[string, string[]]> = [
    ["module", ["module"]],
    ["page", ["page-list", "page"]],
    ["assignment", ["assignment-list"]],
    ["announcement", ["announcement"]],
    ["quiz", ["quiz-list"]],
    ["calendar", ["calendar"]],
    ["file", ["file-list"]],
  ];
  return mappings.filter(([, kinds]) => kinds.some((kind) => warningKinds.has(kind))).map(([kind]) => kind);
}

export function changeSummary(changes: Array<Pick<ArchiveChange, "action">>): ChangeTotals {
  return changes.reduce(
    (totals, change) => {
      totals[change.action] += 1;
      return totals;
    },
    { added: 0, modified: 0, removed: 0 },
  );
}
