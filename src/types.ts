export interface CanvasWarning {
  kind: string;
  message: string;
}

export interface KnownContent {
  page_urls?: string[];
  files?: CanvasFile[];
}

export interface ConfiguredCourse {
  code: string;
  id: number;
  name: string;
  knownContent: KnownContent;
}

export interface ArchiveConfig {
  canvasBinary: string;
  canvasInstance: string;
  rawDirectory: string;
  viewDirectory: string;
  knownContent: string;
  timezone: string;
  downloadFiles: boolean;
  extractText: boolean;
  maxFileBytes: number;
  maxTextSourceBytes: number;
  courses: ConfiguredCourse[];
}

export interface SyncOptions {
  courses: ConfiguredCourse[];
  downloadFiles: boolean;
  extractText: boolean;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  default_view?: string;
  syllabus_body?: string;
}

export interface Positioned {
  id: number;
  position?: number | string | null;
}

export interface CanvasModuleItem {
  id: number;
  type: string;
  title?: string;
  position?: number | string | null;
  indent?: number;
  content_id?: number;
  page_url?: string;
  html_url?: string;
  external_url?: string;
  url?: string;
}

export interface CanvasModule extends Positioned {
  name: string;
  items?: CanvasModuleItem[];
  published?: boolean;
  unlock_at?: string | null;
}

export interface CanvasPage {
  page_id?: number;
  url: string;
  title: string;
  body?: string;
  html_url?: string;
  updated_at?: string;
  published?: boolean;
  front_page?: boolean;
}

export interface AssignmentOverride {
  id: number;
  title?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  course_section_id?: number | null;
  group_id?: number | null;
  student_ids?: number[];
}

export interface AssignmentDate {
  audience: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  override_id?: number;
  course_section_id?: number | null;
  group_id?: number | null;
  student_ids?: number[];
}

export interface CanvasAssignment extends Positioned {
  name: string;
  assignment_group_id: number;
  description?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  html_url?: string;
  updated_at?: string;
  points_possible?: number | null;
  published?: boolean;
  submission_types?: string[];
}

export interface CanvasAssignmentGroup extends Positioned {}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message?: string;
  html_url?: string;
  posted_at?: string;
  published?: boolean;
}

export interface CanvasFile {
  id: number;
  folder_id?: number | null;
  display_name?: string;
  filename?: string;
  size: number;
  updated_at?: string;
  "content-type"?: string;
  url?: string;
  hidden?: boolean;
  hidden_for_user?: boolean;
  _legacy_seed?: boolean;
}

export interface CanvasFolder {
  id: number;
  parent_folder_id?: number | null;
  name?: string;
  full_name?: string;
}

export interface CanvasQuiz extends Positioned {
  title: string;
  description?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  html_url?: string;
  updated_at?: string;
  points_possible?: number | null;
  published?: boolean;
}

export interface CanvasCalendarEvent {
  id: number;
  title: string;
  description?: string;
  html_url?: string;
  updated_at?: string;
  start_at?: string;
  end_at?: string;
  location_name?: string;
  context_code?: string;
}

export interface CourseData {
  configuredCourse: ConfiguredCourse;
  course: CanvasCourse;
  modules: CanvasModule[];
  pages: CanvasPage[];
  assignments: CanvasAssignment[];
  assignmentGroups: CanvasAssignmentGroup[];
  assignmentOverrides: Record<string, AssignmentOverride[]>;
  announcements: CanvasAnnouncement[];
  files: CanvasFile[];
  folders: CanvasFolder[];
  quizzes: CanvasQuiz[];
  calendarEvents: CanvasCalendarEvent[];
  warnings: CanvasWarning[];
}

export interface TextExtraction {
  status: string;
  bytes: number;
  sha256?: string;
  error?: string;
  file_bytes?: number;
}

export interface PreservedFile {
  local_path?: string;
  text_path?: string;
  text?: TextExtraction;
}

export interface FileEntry {
  canvas_id: number;
  name: string;
  size: number;
  updated_at?: string;
  content_type: string;
  source_url?: string;
  local_path: string;
  status: string;
  content_sha256: string;
  origin: string;
  legacy_preserved: PreservedFile | null;
  text_path: string;
  text: TextExtraction;
}

export interface FileManifest {
  course?: string;
  files: Record<string, FileEntry>;
}

export interface DocumentInput {
  id: string | number;
  kind: string;
  course: string;
  title: unknown;
  sourceUrl?: unknown;
  updatedAt?: unknown;
  metadata?: Record<string, unknown>;
  content?: unknown;
  localPath?: unknown;
}

export interface ArchiveDocument {
  document_id: string;
  course: string;
  kind: string;
  title: string;
  source_url: string;
  local_path: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  content_sha256: string;
  content: string;
}

export type DocumentState = Omit<ArchiveDocument, "course" | "document_id" | "content">;
export type ArchiveState = Record<string, DocumentState>;

export interface ChangeField {
  field: string;
  before: unknown;
  after: unknown;
}

export type ChangeAction = "added" | "modified" | "removed";

export interface ArchiveChange {
  action: ChangeAction;
  document_id: string;
  kind: string;
  title: string;
  fields: ChangeField[];
}

export interface ChangeTotals {
  added: number;
  modified: number;
  removed: number;
}

export interface ArchiveResult {
  code: string;
  data: CourseData;
  documents: ArchiveDocument[];
  fileEntries: FileEntry[];
  changes: ArchiveChange[];
  baseline: boolean;
}

export interface RunCourse {
  code: string;
  baseline: boolean;
  summary: ChangeTotals;
  changes: ArchiveChange[];
  warnings: CanvasWarning[];
}

export interface RunReport {
  run_id: string;
  started_at: string;
  completed_at: string;
  courses: RunCourse[];
}
