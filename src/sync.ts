#!/usr/bin/env bun
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assignmentDates,
  changeSummary,
  embeddedFileIds,
  incompleteDocumentKinds,
  sanitizeCanvasSecrets,
} from "./archive-helpers.ts";
import { canvasDownload, canvasError, canvasJson, collectResource } from "./canvas-client.ts";
import { loadConfig, parseOptions } from "./config.ts";
import {
  atomicWrite,
  canvasAssignmentOrder,
  canvasModuleOrder,
  collisionSafeNames,
  compareStates,
  documentRecord,
  extractText,
  formatDate,
  htmlToMarkdown,
  orderPrefix,
  preserveIncompleteState,
  readJson,
  safeName,
  sha256File,
  stableJson,
  stateFromDocuments,
  writeJson,
} from "./lib.ts";
import type {
  ArchiveChange,
  ArchiveConfig,
  ArchiveDocument,
  ArchiveResult,
  ArchiveState,
  AssignmentOverride,
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasAssignmentGroup,
  CanvasCalendarEvent,
  CanvasCourse,
  CanvasFile,
  CanvasFolder,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
  CanvasQuiz,
  CanvasWarning,
  ConfiguredCourse,
  CourseData,
  FileEntry,
  FileManifest,
  KnownContent,
  RunReport,
  SyncOptions,
} from "./types.ts";

export {
  assignmentDates,
  changeSummary,
  embeddedFileIds,
  incompleteDocumentKinds,
  sanitizeCanvasSecrets,
} from "./archive-helpers.ts";
export { parseOptions } from "./config.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function moduleItems(modules: CanvasModule[]): CanvasModuleItem[] {
  return modules.flatMap((module) => module.items || []);
}

async function supplementPages(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  courseId: number,
  modules: CanvasModule[],
  listedPages: CanvasPage[],
  knownContent: KnownContent = {},
): Promise<CanvasPage[]> {
  const pagesByUrl = new Map(listedPages.map((page) => [page.url, page]));
  const pageUrls = new Set(
    moduleItems(modules)
      .map((item) => (item.type === "Page" ? item.page_url : undefined))
      .filter((pageUrl): pageUrl is string => Boolean(pageUrl)),
  );
  for (const pageUrl of knownContent.page_urls || []) pageUrls.add(pageUrl);
  for (const pageUrl of [...pageUrls].sort()) {
    if (pagesByUrl.has(pageUrl)) continue;
    const page = await collectResource<CanvasPage | null>(
      config,
      warnings,
      "page",
      ["pages", "get", pageUrl, "--course-id", String(courseId)],
      null,
    );
    if (page) pagesByUrl.set(page.url || pageUrl, page);
  }
  return [...pagesByUrl.values()].sort((left, right) => String(left.url).localeCompare(String(right.url)));
}

async function supplementFiles(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  resources: { modules: CanvasModule[] } & Record<string, unknown>,
  listedFiles: CanvasFile[],
  knownContent: KnownContent = {},
): Promise<CanvasFile[]> {
  const filesById = new Map(listedFiles.map((file) => [Number(file.id), file]));
  const fileIds = embeddedFileIds(resources);
  const knownFiles = new Map((knownContent.files || []).map((file) => [Number(file.id), file]));
  for (const fileId of knownFiles.keys()) fileIds.add(fileId);
  for (const item of moduleItems(resources.modules)) {
    if (item.type === "File" && item.content_id) fileIds.add(Number(item.content_id));
  }
  for (const fileId of [...fileIds].sort((left, right) => left - right)) {
    if (filesById.has(fileId)) continue;
    const file = await collectResource<CanvasFile | null>(
      config,
      warnings,
      "file",
      ["files", "get", String(fileId)],
      null,
    );
    if (file) filesById.set(Number(file.id || fileId), file);
    else {
      const knownFile = knownFiles.get(fileId);
      if (knownFile) filesById.set(fileId, { ...knownFile, _legacy_seed: true });
    }
  }
  return [...filesById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function supplementFolders(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  listedFolders: CanvasFolder[],
  files: CanvasFile[],
): Promise<CanvasFolder[]> {
  const foldersById = new Map(
    (listedFolders || []).filter((folder) => folder?.id != null).map((folder) => [Number(folder.id), folder]),
  );
  const pending = [
    ...new Set(
      [
        ...(files || []).map((file) => Number(file.folder_id)),
        ...(listedFolders || []).map((folder) => Number(folder.parent_folder_id)),
      ].filter((folderId) => Number.isFinite(folderId) && folderId > 0 && !foldersById.has(folderId)),
    ),
  ].sort((left, right) => left - right);

  for (let index = 0; index < pending.length; index += 1) {
    const folderId = pending[index];
    if (folderId === undefined) continue;
    if (foldersById.has(folderId)) continue;
    const result = await collectResource<CanvasFolder | CanvasFolder[] | null>(
      config,
      warnings,
      "folder",
      ["folders", "get", "--folder-id", String(folderId)],
      null,
    );
    const folder = Array.isArray(result) ? result[0] : result;
    if (!folder?.id) continue;
    foldersById.set(Number(folder.id), folder);
    const parentId = Number(folder.parent_folder_id);
    if (Number.isFinite(parentId) && parentId > 0 && !foldersById.has(parentId) && !pending.includes(parentId))
      pending.push(parentId);
  }
  return [...foldersById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function collectCourse(config: ArchiveConfig, configuredCourse: ConfiguredCourse): Promise<CourseData> {
  const warnings: CanvasWarning[] = [];
  const courseId = configuredCourse.id;
  const course = await canvasJson<CanvasCourse>(config, ["courses", "get", String(courseId)]);
  const modules = await collectResource<CanvasModule[]>(config, warnings, "module", [
    "modules",
    "list",
    "--course-id",
    String(courseId),
    "--include",
    "items,content_details",
  ]);
  const listedPages = await collectResource<CanvasPage[]>(config, warnings, "page-list", [
    "pages",
    "list",
    "--course-id",
    String(courseId),
    "--include",
    "body",
  ]);
  const pages = await supplementPages(config, warnings, courseId, modules, listedPages, configuredCourse.knownContent);
  const assignmentGroups = await collectResource<CanvasAssignmentGroup[]>(config, warnings, "assignment-group-list", [
    "assignment-groups",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const assignments = await collectResource<CanvasAssignment[]>(config, warnings, "assignment-list", [
    "assignments",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const assignmentOverrides: Record<string, AssignmentOverride[]> = {};
  for (const assignment of assignments) {
    assignmentOverrides[assignment.id] = await collectResource<AssignmentOverride[]>(
      config,
      warnings,
      "assignment-override",
      ["overrides", "list", "--course-id", String(courseId), "--assignment-id", String(assignment.id)],
    );
  }
  const announcements = await collectResource<CanvasAnnouncement[]>(config, warnings, "announcement", [
    "announcements",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const quizzes = await collectResource<CanvasQuiz[]>(config, warnings, "quiz-list", [
    "quizzes",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const calendarEvents = await collectResource<CanvasCalendarEvent[]>(config, warnings, "calendar", [
    "calendar",
    "list",
    "--course-id",
    String(courseId),
    "--all-events",
  ]);
  const listedFolders = await collectResource<CanvasFolder[]>(config, warnings, "file-list", [
    "folders",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const listedFiles = await collectResource<CanvasFile[]>(config, warnings, "file-list", [
    "files",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const files = await supplementFiles(
    config,
    warnings,
    { course, modules, pages, assignments, announcements, quizzes, calendarEvents },
    listedFiles,
    configuredCourse.knownContent,
  );
  const folders = await supplementFolders(config, warnings, listedFolders, files);
  return sanitizeCanvasSecrets({
    configuredCourse,
    course,
    modules,
    pages,
    assignments,
    assignmentGroups,
    assignmentOverrides,
    announcements,
    files,
    folders,
    quizzes,
    calendarEvents,
    warnings,
  });
}

async function existingFileMatches(filePath: string, size?: number): Promise<boolean> {
  try {
    return (await stat(filePath)).size === size;
  } catch {
    return false;
  }
}

async function unlinkArchivedPath(courseDirectory: string, relativePath?: string): Promise<boolean> {
  if (!relativePath) return false;
  try {
    await unlink(path.join(courseDirectory, relativePath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function cleanupGeneratedDocuments(
  courseDirectory: string,
  documents: ArchiveDocument[],
  incompleteKinds: string[],
): Promise<void> {
  const incomplete = new Set(incompleteKinds);
  for (const kind of ["page", "assignment", "announcement", "module", "quiz"]) {
    if (incomplete.has(kind)) continue;
    const directory = path.join(courseDirectory, "content", `${kind}s`);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    const expected = new Set(
      documents
        .filter((document) => document.kind === kind && document.local_path)
        .map((document) => path.basename(document.local_path)),
    );
    for (const name of names) {
      if (path.extname(name).toLocaleLowerCase("en") !== ".md" || expected.has(name)) continue;
      await unlink(path.join(directory, name));
    }
  }
}

type ViewSource = ArchiveDocument | FileEntry;

function moduleViewItem(
  item: CanvasModuleItem,
  documents: ArchiveDocument[],
  fileEntries: FileEntry[],
): ViewSource | null {
  const byKindAndId = (kind: string, id?: number) =>
    documents.find((document) => document.kind === kind && document.document_id.endsWith(`:${kind}:${id}`));
  if (item.type === "Page")
    return (
      documents.find((document) => document.kind === "page" && document.metadata?.page_url === item.page_url) ?? null
    );
  if (item.type === "Assignment") return byKindAndId("assignment", item.content_id) ?? null;
  if (item.type === "Quiz") return byKindAndId("quiz", item.content_id) ?? null;
  if (item.type === "File")
    return fileEntries.find((file) => String(file.canvas_id) === String(item.content_id)) ?? null;
  return null;
}

function moduleViewStub(item: CanvasModuleItem, courseId: number): string {
  const url =
    item.html_url ||
    item.external_url ||
    item.url ||
    `https://canvas.nus.edu.sg/courses/${courseId}/modules/items/${item.id}`;
  return `# ${item.title}\n\nCanvas item type: ${item.type}\n\n[Open this item in Canvas](${url})\n`;
}

function moduleViewFilename(name: string, source: ViewSource | null): string {
  const markdown = !source?.local_path || /\.md$/i.test(source.local_path);
  return `${name}${markdown ? ".md" : ""}`;
}

async function copyViewFile(destination: string, source: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

async function buildModuleView(
  viewCourseDirectory: string,
  rawCourseDirectory: string,
  data: CourseData,
  documents: ArchiveDocument[],
  fileEntries: FileEntry[],
): Promise<void> {
  const viewDirectory = path.join(viewCourseDirectory, "Modules");
  const manifestPath = path.join(rawCourseDirectory, ".module-view.json");
  const previous = await readJson<{ paths: string[] }>(manifestPath, { paths: [] });
  for (const relativePath of [...(previous.paths || [])].sort((left, right) => right.length - left.length)) {
    await rm(path.join(viewDirectory, relativePath), { recursive: true, force: true });
  }
  await mkdir(viewDirectory, { recursive: true });

  const generatedPaths: string[] = [];
  const moduleOrder = canvasModuleOrder(data.modules);
  const moduleNames = collisionSafeNames(
    data.modules,
    (module) => safeName(module.name),
    (module) => module.id,
  );
  const addPath = (relativePath: string): string => {
    generatedPaths.push(relativePath.split(path.sep).join("/"));
    return path.join(viewDirectory, relativePath);
  };

  for (const module of data.modules) {
    const moduleDirectoryName = `${orderPrefix(moduleOrder.moduleRanks.get(Number(module.id)))}${moduleNames.get(module) ?? safeName(module.name)}`;
    const moduleDirectory = addPath(moduleDirectoryName);
    await mkdir(moduleDirectory, { recursive: true });
    const items = module.items || [];
    const stack: Array<{ indent: number; directory: string }> = [];
    const levelCounters = new Map<number, number>();
    for (const [index, item] of items.entries()) {
      const indent = Number(item.indent || 0);
      while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
      const itemNumber = (levelCounters.get(indent) || 0) + 1;
      levelCounters.set(indent, itemNumber);
      for (const level of levelCounters.keys()) if (level > indent) levelCounters.delete(level);
      const parent = stack.at(-1)?.directory || moduleDirectory;
      const hasChildren = Number(items[index + 1]?.indent || 0) > indent;
      const name = `${orderPrefix(itemNumber)}${safeName(item.title || `${item.type} ${item.id}`)}`;
      const source = moduleViewItem(item, documents, fileEntries);
      let itemPath: string;
      if (hasChildren) {
        const itemDirectory = addPath(path.relative(viewDirectory, path.join(parent, name)));
        await mkdir(itemDirectory, { recursive: true });
        itemPath = addPath(path.relative(viewDirectory, path.join(itemDirectory, moduleViewFilename(name, source))));
        if (source?.local_path) {
          await copyViewFile(itemPath, path.join(rawCourseDirectory, source.local_path));
        } else {
          await atomicWrite(itemPath, moduleViewStub(item, data.course.id));
        }
        stack.push({ indent, directory: itemDirectory });
      } else {
        itemPath = addPath(path.relative(viewDirectory, path.join(parent, moduleViewFilename(name, source))));
        if (source?.local_path) {
          await copyViewFile(itemPath, path.join(rawCourseDirectory, source.local_path));
        } else {
          await atomicWrite(itemPath, moduleViewStub(item, data.course.id));
        }
      }
    }
  }
  await writeJson(manifestPath, { paths: generatedPaths });
}

function canvasFolderViewPath(file: Pick<CanvasFile, "folder_id">, folders: CanvasFolder[]): string[] {
  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  const parts: CanvasFolder[] = [];
  let current = byId.get(Number(file.folder_id));
  while (current && !/^course files$/i.test(String(current.name || current.full_name || ""))) {
    parts.unshift(current);
    current = byId.get(Number(current.parent_folder_id));
  }
  const pathParts: string[] = [];
  for (const folder of parts) {
    const siblings = folders
      .filter((candidate) => Number(candidate.parent_folder_id) === Number(folder.parent_folder_id))
      .sort(
        (left, right) =>
          safeName(left.name).localeCompare(safeName(right.name), "en") || Number(left.id) - Number(right.id),
      );
    const folderIndex = siblings.findIndex((sibling) => Number(sibling.id) === Number(folder.id));
    pathParts.push(`${orderPrefix(folderIndex + 1)}${safeName(folder.name)}`);
  }
  return pathParts;
}

function hasCompleteCanvasFolderPath(file: Pick<CanvasFile, "folder_id">, folders: CanvasFolder[]): boolean {
  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  let current = byId.get(Number(file.folder_id));
  while (current && !/^course files$/i.test(String(current.name || current.full_name || ""))) {
    current = byId.get(Number(current.parent_folder_id));
  }
  return Boolean(current);
}

async function pruneEmptyGeneratedDirectories(
  directory: string,
  rootDirectory: string,
  preservedDirectories: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    await pruneEmptyGeneratedDirectories(path.join(directory, entry.name), rootDirectory, preservedDirectories);
  }
  entries = await readdir(directory, { withFileTypes: true });
  const meaningfulEntries = entries.filter((entry) => entry.name !== ".DS_Store");
  const relativeDirectory = path.relative(rootDirectory, directory).split(path.sep).join("/");
  if (
    !meaningfulEntries.length &&
    path.basename(directory).startsWith("(") &&
    !preservedDirectories.has(relativeDirectory)
  ) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildCollectionViews(
  viewCourseDirectory: string,
  rawCourseDirectory: string,
  data: CourseData,
  documents: ArchiveDocument[],
  fileEntries: FileEntry[],
): Promise<ArchiveDocument[]> {
  const viewDirectory = viewCourseDirectory;
  const manifestPath = path.join(rawCourseDirectory, ".collection-view.json");
  const previous = await readJson<{ paths: string[] }>(manifestPath, { paths: [] });
  for (const relativePath of [...(previous.paths || [])].sort((left, right) => right.length - left.length)) {
    await rm(path.join(viewDirectory, relativePath), { recursive: true, force: true });
  }
  await mkdir(viewDirectory, { recursive: true });
  const generatedPaths: string[] = [];
  const addPath = (absolutePath: string): string => {
    generatedPaths.push(path.relative(viewDirectory, absolutePath).split(path.sep).join("/"));
    return absolutePath;
  };
  const link = copyViewFile;
  const identityForItem = (item: unknown): unknown => {
    if (typeof item !== "object" || item === null) return item;
    const record = item as Record<string, unknown>;
    return record.id ?? record.canvas_id ?? record.document_id;
  };
  const collection = async <T>(
    directoryName: string,
    items: T[],
    nameForItem: (item: T) => unknown,
    sourceForItem: (item: T) => string | undefined,
    sortItems: T[] = items,
  ): Promise<void> => {
    const directory = path.join(viewDirectory, directoryName);
    await mkdir(directory, { recursive: true });
    const names = collisionSafeNames(items, nameForItem, identityForItem);
    for (const item of sortItems) {
      const source = sourceForItem(item);
      if (!source) continue;
      const target = addPath(path.join(directory, names.get(item) ?? safeName(nameForItem(item))));
      await link(target, path.join(rawCourseDirectory, source));
    }
  };

  const assignments = data.assignments || [];
  const assignmentOrder = (data.warnings || []).some((warning) =>
    ["assignment-list", "assignment-group-list"].includes(warning.kind),
  )
    ? new Map()
    : canvasAssignmentOrder(assignments, data.assignmentGroups || []);
  const assignmentDocuments = documents.filter((document) => document.kind === "assignment");
  await collection(
    "Assignments",
    assignments,
    (assignment) => `${orderPrefix(assignmentOrder.get(Number(assignment.id)))}${safeName(assignment.name)}.md`,
    (assignment) =>
      assignmentDocuments.find((document) => document.document_id.endsWith(`:assignment:${assignment.id}`))?.local_path,
    [...assignments].sort(
      (left, right) =>
        (assignmentOrder.get(Number(left.id)) || 999999) - (assignmentOrder.get(Number(right.id)) || 999999),
    ),
  );

  const announcements = [...(data.announcements || [])].sort(
    (left, right) =>
      new Date(left.posted_at || 0).getTime() - new Date(right.posted_at || 0).getTime() ||
      Number(left.id) - Number(right.id),
  );
  const announcementDocuments = documents.filter((document) => document.kind === "announcement");
  await collection(
    "Announcements",
    announcements,
    (announcement) => `${orderPrefix(announcements.indexOf(announcement) + 1)}${safeName(announcement.title)}.md`,
    (announcement) =>
      announcementDocuments.find((document) => document.document_id.endsWith(`:announcement:${announcement.id}`))
        ?.local_path,
    announcements,
  );

  const quizzes = [...(data.quizzes || [])].sort(
    (left, right) =>
      Number(left.position ?? 999999) - Number(right.position ?? 999999) || Number(left.id) - Number(right.id),
  );
  const quizDocuments = documents.filter((document) => document.kind === "quiz");
  await collection(
    "Quizzes",
    quizzes,
    (quiz) => `${orderPrefix(quizzes.indexOf(quiz) + 1)}${safeName(quiz.title)}.md`,
    (quiz) => quizDocuments.find((document) => document.document_id.endsWith(`:quiz:${quiz.id}`))?.local_path,
    quizzes,
  );

  const fileDirectory = path.join(viewDirectory, "Files");
  await mkdir(fileDirectory, { recursive: true });
  const fileRecords = new Map((data.files || []).map((file) => [String(file.id), file]));
  const preservedDirectories = new Set<string>();
  for (const folder of data.folders || []) {
    if (/^course files$/i.test(String(folder.name || folder.full_name || ""))) continue;
    if (!hasCompleteCanvasFolderPath({ folder_id: folder.id }, data.folders || [])) continue;
    const folderParts = canvasFolderViewPath({ folder_id: folder.id }, data.folders || []);
    if (!folderParts.length) continue;
    const relativeDirectory = path
      .join(...folderParts)
      .split(path.sep)
      .join("/");
    preservedDirectories.add(relativeDirectory);
    await mkdir(path.join(fileDirectory, ...folderParts), { recursive: true });
  }
  const filesByFolder = new Map<string, FileEntry[]>();
  for (const file of fileEntries) {
    const fileRecord = fileRecords.get(String(file.canvas_id));
    if (fileRecord?.hidden || fileRecord?.hidden_for_user) continue;
    if (fileRecord?.folder_id && !hasCompleteCanvasFolderPath(fileRecord, data.folders || [])) continue;
    const folderId = String(fileRecord?.folder_id || "root");
    if (!filesByFolder.has(folderId)) filesByFolder.set(folderId, []);
    filesByFolder.get(folderId)?.push(file);
  }
  for (const [folderId, folderFiles] of filesByFolder) {
    const folderRecord = fileRecords.get(String(folderFiles[0]?.canvas_id));
    const folderParts = canvasFolderViewPath(folderRecord || {}, data.folders || []);
    const directory = folderId === "root" ? fileDirectory : path.join(fileDirectory, ...folderParts);
    const fileNames = collisionSafeNames(
      folderFiles,
      (file) => `${safeName(file.name)}`,
      (file) => file.canvas_id,
    );
    const orderedFiles = [...folderFiles].sort(
      (left, right) =>
        safeName(left.name).localeCompare(safeName(right.name), "en") ||
        Number(left.canvas_id) - Number(right.canvas_id),
    );
    const rootFolderId = (data.folders || []).find((folder) =>
      /^course files$/i.test(String(folder.name || folder.full_name || "")),
    )?.id;
    const childFolderCount = (data.folders || []).filter(
      (folder) => Number(folder.parent_folder_id) === Number(folderId === "root" ? rootFolderId : folderId),
    ).length;
    for (const [fileIndex, file] of orderedFiles.entries()) {
      const target = addPath(
        path.join(directory, `${orderPrefix(childFolderCount + fileIndex + 1)}${fileNames.get(file)}`),
      );
      await link(target, path.join(rawCourseDirectory, file.local_path));
    }
  }
  await pruneEmptyGeneratedDirectories(fileDirectory, fileDirectory, preservedDirectories);

  const modulePageUrls = new Set(
    (data.modules || []).flatMap((module) =>
      (module.items || [])
        .map((item) => (item.type === "Page" ? item.page_url : undefined))
        .filter((pageUrl): pageUrl is string => Boolean(pageUrl)),
    ),
  );
  const pages = [...(data.pages || [])];
  const pageDocuments = documents.filter((document) => document.kind === "page");
  await collection(
    "Pages",
    pages,
    (page) => `${orderPrefix(pages.indexOf(page) + 1)}${safeName(page.title)}.md`,
    (page) => pageDocuments.find((document) => document.metadata?.page_url === page.url)?.local_path,
    pages,
  );
  const extraPages = documents.filter((document) => {
    const pageUrl = document.metadata.page_url;
    return (
      document.kind === "page" && typeof pageUrl === "string" && !modulePageUrls.has(pageUrl) && document.content.trim()
    );
  });
  const pageDirectory = viewDirectory;
  await mkdir(pageDirectory, { recursive: true });
  const pageNames = collisionSafeNames(
    extraPages,
    (page) => `${page.title}.md`,
    (page) => page.document_id,
  );
  for (const page of extraPages) {
    const target = addPath(path.join(pageDirectory, pageNames.get(page) ?? `${safeName(page.title)}.md`));
    await link(target, path.join(rawCourseDirectory, page.local_path));
  }
  await writeJson(manifestPath, {
    paths: generatedPaths,
    pages_not_in_modules: extraPages.map((page) => ({
      title: page.title,
      document_id: page.document_id,
      source_url: page.source_url,
    })),
  });
  return extraPages;
}

async function archiveFiles(
  config: ArchiveConfig,
  data: CourseData,
  courseDirectory: string,
  options: SyncOptions,
): Promise<FileEntry[]> {
  const manifestPath = path.join(courseDirectory, "file-manifest.json");
  const previous = await readJson<FileManifest>(manifestPath, { files: {} });
  const fileListIncomplete = data.warnings.some((warning) => warning.kind === "file-list");
  const manifest: FileManifest = {
    course: data.configuredCourse.code,
    files: fileListIncomplete ? { ...(previous.files || {}) } : {},
  };
  const entries: FileEntry[] = [];
  for (const file of [...data.files].sort((left, right) => left.id - right.id)) {
    const displayName = file.display_name || file.filename || `file-${file.id}`;
    const relativePath = path.join("content", "files", String(file.id), safeName(displayName));
    const destination = path.join(courseDirectory, relativePath);
    const old = previous.files?.[file.id];
    const matches = await existingFileMatches(destination, file.size);
    let status = "metadata-only";
    let contentSha256 = old?.content_sha256 ?? "";
    let origin = old?.origin ?? "";
    let legacyPreserved = old?.legacy_preserved ?? null;
    const unchanged = matches && old?.updated_at === file.updated_at && old?.size === file.size;
    if (options.downloadFiles && file.size > config.maxFileBytes) status = "skipped-too-large";
    else if (options.downloadFiles && unchanged) status = origin ? "legacy-preserved" : "unchanged";
    else if (options.downloadFiles) {
      try {
        await canvasDownload(config, file.id, destination);
        status = "downloaded";
        contentSha256 = await sha256File(destination);
        origin = "";
      } catch (error) {
        status = "download-failed";
        const { raw, structured } = canvasError(error);
        const reason = structured ? `files.download: ${structured.error}` : (raw.split("\n")[0] ?? "Download failed");
        data.warnings.push({ kind: "file", message: sanitizeCanvasSecrets(`${file.id} — ${displayName}: ${reason}`) });
      }
    }
    if (options.downloadFiles && matches && !contentSha256) contentSha256 = await sha256File(destination);

    let text = old?.text ?? { status: "not-requested", bytes: 0 };
    const textRelativePath = path.join("content", "text", "files", String(file.id), `${safeName(displayName)}.txt`);
    if (options.extractText && (status === "downloaded" || status === "unchanged" || status === "legacy-preserved")) {
      const textDestination = path.join(courseDirectory, textRelativePath);
      if (status === "downloaded" || !(await existingFileMatches(textDestination, old?.text?.file_bytes))) {
        text = await extractText(destination, textDestination, {
          contentType: file["content-type"] || "",
          maxSourceBytes: config.maxTextSourceBytes,
        });
        if (text.status === "extracted") text.file_bytes = (await stat(textDestination)).size;
      }
    }
    if (options.extractText && legacyPreserved?.local_path) {
      const preservedSource = path.join(courseDirectory, legacyPreserved.local_path);
      const preservedTextRelative = path.join(
        "content",
        "text",
        "legacy-preserved",
        `${file.id}-${safeName(displayName)}.txt`,
      );
      const preservedTextDestination = path.join(courseDirectory, preservedTextRelative);
      const previousText = legacyPreserved.text ?? { status: "not-requested", bytes: 0 };
      if (!(await existingFileMatches(preservedTextDestination, previousText.file_bytes))) {
        const extracted = await extractText(preservedSource, preservedTextDestination, {
          contentType: file["content-type"] || "",
          maxSourceBytes: config.maxTextSourceBytes,
        });
        if (extracted.status === "extracted") extracted.file_bytes = (await stat(preservedTextDestination)).size;
        legacyPreserved = {
          ...legacyPreserved,
          text_path: extracted.status === "extracted" ? preservedTextRelative.split(path.sep).join("/") : "",
          text: extracted,
        };
      }
    }
    const entry: FileEntry = {
      canvas_id: file.id,
      name: displayName,
      size: file.size,
      updated_at: file.updated_at,
      content_type: file["content-type"] || "",
      source_url: file.url,
      local_path: relativePath.split(path.sep).join("/"),
      status,
      content_sha256: contentSha256,
      origin,
      legacy_preserved: legacyPreserved,
      text_path: text.status === "extracted" ? textRelativePath.split(path.sep).join("/") : "",
      text,
    };
    manifest.files[file.id] = entry;
    entries.push(entry);
    await writeJson(manifestPath, manifest);
  }
  if (!fileListIncomplete) {
    const currentIds = new Set(data.files.map((file) => String(file.id)));
    for (const [fileId, old] of Object.entries(previous.files || {})) {
      if (currentIds.has(String(fileId))) continue;
      for (const oldPath of [
        old.local_path,
        old.text_path,
        old.legacy_preserved?.local_path,
        old.legacy_preserved?.text_path,
      ])
        await unlinkArchivedPath(courseDirectory, oldPath);
    }
  }
  await writeJson(manifestPath, manifest);
  return entries;
}

async function buildDocuments(
  data: CourseData,
  courseDirectory: string,
  fileEntries: FileEntry[],
): Promise<ArchiveDocument[]> {
  const code = data.configuredCourse.code;
  const documents: ArchiveDocument[] = [];
  documents.push(
    documentRecord({
      id: data.course.id,
      kind: "course",
      course: code,
      title: data.course.name,
      sourceUrl: `https://canvas.nus.edu.sg/courses/${data.course.id}`,
      metadata: {
        course_id: data.course.id,
        course_code: data.course.course_code,
        default_view: data.course.default_view,
      },
      content: htmlToMarkdown(data.course.syllabus_body || ""),
    }),
  );
  for (const page of data.pages) {
    const content = htmlToMarkdown(page.body || "");
    const localPath = path.posix.join("content/pages", `${page.page_id || safeName(page.url)}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${page.title}\n\n${content}`);
    documents.push(
      documentRecord({
        id: page.page_id || page.url,
        kind: "page",
        course: code,
        title: page.title,
        sourceUrl: page.html_url || `https://canvas.nus.edu.sg/courses/${data.course.id}/pages/${page.url}`,
        updatedAt: page.updated_at,
        localPath,
        metadata: { page_url: page.url, published: page.published, front_page: page.front_page },
        content,
      }),
    );
  }
  for (const assignment of data.assignments) {
    const content = htmlToMarkdown(assignment.description || "");
    const dates = assignmentDates(assignment, data.assignmentOverrides[assignment.id]);
    const localPath = path.posix.join("content/assignments", `${assignment.id}.md`);
    const dateLines = dates.map((date) => `- ${date.audience}: ${date.due_at || "no due date"}`).join("\n");
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${assignment.name}\n\n## Dates\n\n${dateLines || "- No dated variants"}\n\n${content}`,
    );
    documents.push(
      documentRecord({
        id: assignment.id,
        kind: "assignment",
        course: code,
        title: assignment.name,
        sourceUrl: assignment.html_url,
        updatedAt: assignment.updated_at,
        localPath,
        metadata: {
          dates,
          points_possible: assignment.points_possible,
          published: assignment.published,
          submission_types: assignment.submission_types || [],
          assignment_group_id: assignment.assignment_group_id,
        },
        content,
      }),
    );
  }
  const sortedAnnouncements = [...data.announcements].sort(
    (left, right) => new Date(left.posted_at || 0).getTime() - new Date(right.posted_at || 0).getTime(),
  );
  for (const announcement of sortedAnnouncements) {
    const content = htmlToMarkdown(announcement.message || "");
    const localPath = path.posix.join("content/announcements", `${announcement.id}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${announcement.title}\n\n${content}`);
    documents.push(
      documentRecord({
        id: announcement.id,
        kind: "announcement",
        course: code,
        title: announcement.title,
        sourceUrl: announcement.html_url,
        updatedAt: announcement.posted_at,
        localPath,
        metadata: { posted_at: announcement.posted_at, published: announcement.published },
        content,
      }),
    );
  }
  for (const module of data.modules) {
    const lines = (module.items || []).map(
      (item) =>
        `${"  ".repeat(item.indent || 0)}- ${item.type}: ${item.title} ${item.html_url || item.external_url || ""}`,
    );
    const localPath = path.posix.join("content/modules", `${module.id}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${module.name}\n\n${lines.join("\n")}\n`);
    documents.push(
      documentRecord({
        id: module.id,
        kind: "module",
        course: code,
        title: module.name,
        localPath,
        metadata: { position: module.position, published: module.published, unlock_at: module.unlock_at },
        content: lines.join("\n"),
      }),
    );
  }
  for (const quiz of data.quizzes) {
    const localPath = path.posix.join("content/quizzes", `${quiz.id}.md`);
    const content = htmlToMarkdown(quiz.description || "");
    const dateLines = [
      quiz.due_at ? `- Due: ${quiz.due_at}` : "",
      quiz.unlock_at ? `- Opens: ${quiz.unlock_at}` : "",
      quiz.lock_at ? `- Closes: ${quiz.lock_at}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${quiz.title}\n\n## Details\n\n${dateLines || "- No dated variants"}\n\n${content}`,
    );
    documents.push(
      documentRecord({
        id: quiz.id,
        kind: "quiz",
        course: code,
        title: quiz.title,
        sourceUrl: quiz.html_url,
        updatedAt: quiz.updated_at,
        localPath,
        metadata: {
          due_at: quiz.due_at,
          unlock_at: quiz.unlock_at,
          lock_at: quiz.lock_at,
          points_possible: quiz.points_possible,
          published: quiz.published,
        },
        content,
      }),
    );
  }
  for (const event of data.calendarEvents) {
    documents.push(
      documentRecord({
        id: event.id,
        kind: "calendar",
        course: code,
        title: event.title,
        sourceUrl: event.html_url,
        updatedAt: event.updated_at,
        metadata: {
          start_at: event.start_at,
          end_at: event.end_at,
          location_name: event.location_name,
          context_code: event.context_code,
        },
        content: htmlToMarkdown(event.description || ""),
      }),
    );
  }
  for (const file of fileEntries) {
    let searchableContent = "";
    for (const textPath of [file.text_path, file.legacy_preserved?.text_path].filter((value): value is string =>
      Boolean(value),
    )) {
      try {
        searchableContent += `${await readFile(path.join(courseDirectory, textPath), "utf8")}\n`;
      } catch {
        /* sidecar is optional */
      }
    }
    documents.push(
      documentRecord({
        id: file.canvas_id,
        kind: "file",
        course: code,
        title: file.name,
        sourceUrl: file.source_url,
        updatedAt: file.updated_at,
        localPath: file.local_path,
        metadata: {
          size: file.size,
          content_type: file.content_type,
          content_sha256: file.content_sha256,
          origin: file.origin,
          text_path: file.text_path,
          text_status: file.text.status,
          legacy_preserved: file.legacy_preserved,
        },
        content: searchableContent,
      }),
    );
  }
  return documents.sort((left, right) => left.document_id.localeCompare(right.document_id));
}

function courseIndex(
  config: ArchiveConfig,
  data: CourseData,
  documents: ArchiveDocument[],
  files: FileEntry[],
  collectedAt: string,
): string {
  const code = data.configuredCourse.code;
  const lines = [
    `# ${code} — ${data.course.name}`,
    "",
    `Collected: ${formatDate(collectedAt, config.timezone)}`,
    "",
    `- [Canvas-shaped viewing tree](${path.relative(path.join(config.rawDirectory, code), path.join(config.viewDirectory, code)).split(path.sep).join("/") || "."}/)`,
    "- Machine-oriented content: `content/`",
    "## Corpus",
    "",
    `- ${documents.length} normalized documents in [documents.jsonl](documents.jsonl)`,
    `- ${files.length} Canvas file records in [file-manifest.json](file-manifest.json)`,
    "- Lossless API responses in this course directory",
    "",
    "## Assignment dates",
    "",
    "| Due | Assignment | Audience |",
    "|---:|---|---|",
  ];
  const dated = data.assignments
    .flatMap((assignment) =>
      assignmentDates(assignment, data.assignmentOverrides[assignment.id])
        .filter((date) => date.due_at)
        .map((date) => ({ assignment, ...date })),
    )
    .sort((left, right) => new Date(left.due_at ?? 0).getTime() - new Date(right.due_at ?? 0).getTime());
  for (const item of dated)
    lines.push(
      `| ${formatDate(item.due_at, config.timezone)} | [${item.assignment.name}](${item.assignment.html_url}) | ${item.audience} |`,
    );
  if (!dated.length) lines.push("| No dated assignments found | | |");
  lines.push("", "## Searchable content", "");
  for (const kind of ["page", "assignment", "announcement", "module", "quiz", "calendar", "file"]) {
    const count = documents.filter((document) => document.kind === kind).length;
    lines.push(`- ${kind}: ${count}`);
  }
  if (data.warnings.length) {
    lines.push("", "## Collection warnings", "");
    for (const warning of data.warnings) appendWarning(lines, warning);
  }
  return `${lines.join("\n")}\n`;
}

async function archiveCourse(
  config: ArchiveConfig,
  data: CourseData,
  options: SyncOptions,
  collectedAt: string,
): Promise<ArchiveResult> {
  const code = data.configuredCourse.code;
  const courseDirectory = path.join(config.rawDirectory, code);
  const viewCourseDirectory = path.join(config.viewDirectory, code);
  const rawDirectory = courseDirectory;
  await mkdir(rawDirectory, { recursive: true });
  const rawKeys: Array<keyof CourseData> = [
    "course",
    "modules",
    "pages",
    "assignments",
    "assignmentGroups",
    "assignmentOverrides",
    "announcements",
    "files",
    "folders",
    "quizzes",
    "calendarEvents",
    "warnings",
  ];
  for (const key of rawKeys) {
    await writeJson(path.join(rawDirectory, `${key}.json`), data[key]);
  }
  const fileEntries = await archiveFiles(config, data, courseDirectory, options);
  await writeJson(path.join(rawDirectory, "warnings.json"), data.warnings);
  const statePath = path.join(courseDirectory, "state.json");
  const previousState = await readJson<ArchiveState>(statePath, {});
  const documents = await buildDocuments(data, courseDirectory, fileEntries);
  await buildModuleView(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
  await buildCollectionViews(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
  const jsonl = documents.map((document) => stableJson(document, 0)).join("\n");
  await atomicWrite(path.join(courseDirectory, "documents.jsonl"), `${jsonl}${jsonl ? "\n" : ""}`);

  const currentState = stateFromDocuments(documents);
  const incompleteKinds = incompleteDocumentKinds(data.warnings);
  const state = preserveIncompleteState(previousState, currentState, incompleteKinds);
  const changes = compareStates(previousState, state, incompleteKinds);
  for (const change of changes.filter((change) => change.action === "removed")) {
    await unlinkArchivedPath(courseDirectory, previousState[change.document_id]?.local_path);
  }
  await cleanupGeneratedDocuments(courseDirectory, documents, incompleteKinds);
  await writeJson(statePath, state);
  await atomicWrite(
    path.join(courseDirectory, "INDEX.md"),
    courseIndex(config, data, documents, fileEntries, collectedAt),
  );
  return { code, data, documents, fileEntries, changes, baseline: Object.keys(previousState).length === 0 };
}

function appendWarning(lines: string[], warning: CanvasWarning): void {
  const messageLines = String(warning.message || "No details provided.")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  lines.push(`- **${warning.kind}**: ${messageLines.shift() || "No details provided."}`);
  for (const line of messageLines) lines.push(`  ${line}`);
}

function appendViewChanges(lines: string[], changes: ArchiveChange[], headingLevel: number): void {
  const heading = "#".repeat(headingLevel);
  for (const action of ["added", "modified", "removed"] as const) {
    const matching = changes.filter((change) => change.action === action);
    const title = action.charAt(0).toUpperCase() + action.slice(1);
    lines.push(`${heading} ${title} (${matching.length})`, "");
    if (!matching.length) lines.push("None.", "");
    else for (const change of matching) lines.push(`- ${change.kind}: ${change.title}`);
    lines.push("");
  }
}

function viewRunName(startedAt: string): string {
  return startedAt.slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

async function writeViewLogs(config: ArchiveConfig, run: RunReport): Promise<void> {
  const logsDirectory = path.join(config.viewDirectory, "logs");
  const olderDirectory = path.join(logsDirectory, "older");
  await mkdir(olderDirectory, { recursive: true });
  const lines = [
    "# Canvas sync changes",
    "",
    `Run started: ${formatDate(run.started_at, config.timezone)}`,
    "",
    `Run completed: ${formatDate(run.completed_at, config.timezone)}`,
    "",
    "| Course | Added | Modified | Removed | Warnings |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const course of run.courses)
    lines.push(
      `| ${course.code} | ${course.summary.added} | ${course.summary.modified} | ${course.summary.removed} | ${course.warnings?.length || 0} |`,
    );
  for (const course of run.courses) {
    lines.push("", `## ${course.code}`, "");
    appendViewChanges(lines, course.changes, 3);
    if (course.warnings?.length) {
      lines.push("", `### Warnings (${course.warnings.length})`, "");
      for (const warning of course.warnings) appendWarning(lines, warning);
    }
  }
  const report = `${lines.join("\n")}\n`;
  await atomicWrite(path.join(olderDirectory, `${viewRunName(run.started_at)}.md`), report);
  await atomicWrite(path.join(logsDirectory, "latest.md"), report);
}

async function moveOlderLogs(logsDirectory: string, olderDirectory: string): Promise<void> {
  await mkdir(olderDirectory, { recursive: true });
  const historicalLogPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d+)?Z\.(?:json|md)$/;
  const entries = await readdir(logsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !historicalLogPattern.test(entry.name)) continue;
    await rename(path.join(logsDirectory, entry.name), path.join(olderDirectory, entry.name));
  }
}

async function writeRunOutputs(config: ArchiveConfig, results: ArchiveResult[], startedAt: string): Promise<RunReport> {
  const runId = startedAt.replace(/[:.]/g, "-");
  const completedAt = new Date().toISOString();
  const run: RunReport = {
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    courses: results.map((result) => ({
      code: result.code,
      baseline: result.baseline,
      summary: changeSummary(result.changes),
      changes: result.changes,
      warnings: result.data.warnings,
    })),
  };
  const lines = [
    "# Canvas CLI sync changes",
    "",
    `Run: ${formatDate(startedAt, config.timezone)}`,
    "",
    "| Course | Added | Modified | Removed |",
    "|---|---:|---:|---:|",
  ];
  for (const course of run.courses)
    lines.push(`| ${course.code} | ${course.summary.added} | ${course.summary.modified} | ${course.summary.removed} |`);
  for (const course of run.courses) {
    lines.push("", `## ${course.code}`, "");
    if (course.baseline) lines.push("_Initial baseline: every discovered document is reported as added._", "");
    if (!course.changes.length) lines.push("No content changes detected.", "");
    for (const change of course.changes) {
      lines.push(`- **${change.action.toUpperCase()}** ${change.kind}: ${change.title}`);
      for (const field of change.fields)
        lines.push(`  - ${field.field}: \`${stableJson(field.before, 0)}\` → \`${stableJson(field.after, 0)}\``);
    }
    if (course.warnings.length) {
      lines.push("### Warnings", "");
      for (const warning of course.warnings) appendWarning(lines, warning);
      lines.push("");
    }
  }
  const logsDirectory = path.join(config.rawDirectory, "logs");
  const olderDirectory = path.join(logsDirectory, "older");
  await moveOlderLogs(logsDirectory, olderDirectory);
  await writeJson(path.join(olderDirectory, `${runId}.json`), run);
  await writeJson(path.join(logsDirectory, "latest.json"), run);
  await atomicWrite(path.join(olderDirectory, `${runId}.md`), `${lines.join("\n")}\n`);
  await atomicWrite(path.join(logsDirectory, "latest.md"), `${lines.join("\n")}\n`);
  await writeViewLogs(config, run);

  const rootLines = [
    "# NUS Canvas corpus (canvas-cli)",
    "",
    `Last updated: ${formatDate(completedAt, config.timezone)}`,
    "",
    "## Courses",
    "",
  ];
  for (const result of results)
    rootLines.push(
      `- [${result.code} — ${result.data.course.name}](${result.code}/INDEX.md) — ${result.documents.length} documents, ${result.fileEntries.length} files`,
    );
  const deadlines = results
    .flatMap((result) =>
      result.data.assignments.flatMap((assignment) =>
        assignmentDates(assignment, result.data.assignmentOverrides[assignment.id])
          .filter((date) => date.due_at)
          .map((date) => ({ code: result.code, assignment, ...date })),
      ),
    )
    .sort((left, right) => new Date(left.due_at ?? 0).getTime() - new Date(right.due_at ?? 0).getTime());
  rootLines.push("", "## Assignment dates", "", "| Due | Course | Assignment | Audience |", "|---:|---|---|---|");
  for (const item of deadlines)
    rootLines.push(
      `| ${formatDate(item.due_at, config.timezone)} | ${item.code} | [${item.assignment.name}](${item.assignment.html_url}) | ${item.audience} |`,
    );
  rootLines.push(
    "",
    "## Latest changes",
    "",
    "- [Human-readable report](logs/latest.md)",
    "- [Machine-readable report](logs/latest.json)",
  );
  const coursesWithWarnings = run.courses.filter((course) => course.warnings.length);
  if (coursesWithWarnings.length) {
    rootLines.push("", "## Warnings", "");
    for (const course of coursesWithWarnings) {
      rootLines.push(`### ${course.code}`, "");
      for (const warning of course.warnings) appendWarning(rootLines, warning);
      rootLines.push("");
    }
  }
  await atomicWrite(path.join(config.rawDirectory, "INDEX.md"), `${rootLines.join("\n")}\n`);
  return run;
}

async function doctor(config: ArchiveConfig): Promise<void> {
  const { stdout: version } = await execFileAsync(config.canvasBinary, ["version"]);
  const { stdout: auth } = await execFileAsync(config.canvasBinary, ["auth", "status"]);
  console.log(version.trim());
  console.log(auth.trim());
  console.log(`Raw directory: ${config.rawDirectory}`);
  console.log(`View directory: ${config.viewDirectory}`);
}

async function sync(config: ArchiveConfig, argv: string[]): Promise<void> {
  const options = parseOptions(config, argv);
  const startedAt = new Date().toISOString();
  const results: ArchiveResult[] = [];
  await mkdir(config.rawDirectory, { recursive: true });
  for (const course of options.courses) {
    console.log(`[${course.code}] collecting Canvas metadata`);
    const data = await collectCourse(config, course);
    console.log(`[${course.code}] downloading/indexing ${data.files.length} files`);
    results.push(await archiveCourse(config, data, options, startedAt));
  }
  const run = await writeRunOutputs(config, results, startedAt);
  const selectedCourse = options.courses[0];
  await rebuildViewsFromArchive(
    config,
    options.courses.length === config.courses.length || !selectedCourse ? [] : ["--course", selectedCourse.code],
  );
  const total = run.courses.reduce(
    (summary, course) => ({
      added: summary.added + course.summary.added,
      modified: summary.modified + course.summary.modified,
      removed: summary.removed + course.summary.removed,
    }),
    { added: 0, modified: 0, removed: 0 },
  );
  console.log(`Completed: ${total.added} added, ${total.modified} modified, ${total.removed} removed.`);
  for (const course of run.courses) {
    for (const warning of course.warnings) {
      const message = String(warning.message || "No details provided.")
        .split("\n")
        .filter(Boolean)
        .join("\n  ");
      console.warn(`[${course.code}] ${warning.kind}: ${message}`);
    }
  }
  console.log(`Index: ${path.join(config.rawDirectory, "INDEX.md")}`);
}

async function rebuildViewsFromArchive(config: ArchiveConfig, argv: string[]): Promise<void> {
  const courseFlag = argv.indexOf("--course");
  const requestedCourse = courseFlag >= 0 ? argv[courseFlag + 1]?.toUpperCase() : null;
  const courses = requestedCourse ? config.courses.filter((course) => course.code === requestedCourse) : config.courses;
  if (!courses.length) throw new Error(`Unknown course: ${requestedCourse}`);
  for (const configuredCourse of courses) {
    const courseDirectory = path.join(config.rawDirectory, configuredCourse.code);
    const viewCourseDirectory = path.join(config.viewDirectory, configuredCourse.code);
    const rawDirectory = courseDirectory;
    const readRaw = <T>(name: string, fallback: T): Promise<T> =>
      readJson(path.join(rawDirectory, `${name}.json`), fallback);
    const data: CourseData = {
      configuredCourse,
      course: await readRaw<CanvasCourse>("course", { id: configuredCourse.id, name: configuredCourse.name }),
      modules: await readRaw<CanvasModule[]>("modules", []),
      pages: await readRaw<CanvasPage[]>("pages", []),
      assignments: await readRaw<CanvasAssignment[]>("assignments", []),
      assignmentGroups: await readRaw<CanvasAssignmentGroup[]>("assignmentGroups", []),
      assignmentOverrides: await readRaw<Record<string, AssignmentOverride[]>>("assignmentOverrides", {}),
      announcements: await readRaw<CanvasAnnouncement[]>("announcements", []),
      files: await readRaw<CanvasFile[]>("files", []),
      folders: await readRaw<CanvasFolder[]>("folders", []),
      quizzes: await readRaw<CanvasQuiz[]>("quizzes", []),
      calendarEvents: await readRaw<CanvasCalendarEvent[]>("calendarEvents", []),
      warnings: await readRaw<CanvasWarning[]>("warnings", []),
    };
    const documentsPath = path.join(courseDirectory, "documents.jsonl");
    const existingDocuments = (await readFile(documentsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArchiveDocument);
    const documents = [...existingDocuments];
    for (const quiz of data.quizzes) {
      const index = documents.findIndex(
        (document) => document.document_id === `${configuredCourse.code}:quiz:${quiz.id}`,
      );
      if (index < 0) continue;
      const document = documents[index];
      if (!document) continue;
      const localPath = path.posix.join("content/quizzes", `${quiz.id}.md`);
      const content = htmlToMarkdown(quiz.description || "");
      const dateLines = [
        quiz.due_at ? `- Due: ${quiz.due_at}` : "",
        quiz.unlock_at ? `- Opens: ${quiz.unlock_at}` : "",
        quiz.lock_at ? `- Closes: ${quiz.lock_at}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await atomicWrite(
        path.join(courseDirectory, localPath),
        `# ${quiz.title}\n\n## Details\n\n${dateLines || "- No dated variants"}\n\n${content}`,
      );
      documents[index] = {
        ...document,
        local_path: localPath,
        content_sha256: documentRecord({
          id: quiz.id,
          kind: "quiz",
          course: configuredCourse.code,
          title: quiz.title,
          content,
        }).content_sha256,
        content,
      };
    }
    const fileManifest = await readJson<FileManifest>(path.join(courseDirectory, "file-manifest.json"), { files: {} });
    const fileEntries = Object.values(fileManifest.files || {});
    await rm(viewCourseDirectory, { recursive: true, force: true });
    await buildModuleView(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
    const extraPages = await buildCollectionViews(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
    await atomicWrite(documentsPath, `${documents.map((document) => stableJson(document, 0)).join("\n")}\n`);
    console.log(
      `[${configuredCourse.code}] rebuilt views; ${extraPages.length} content-bearing pages are not in modules`,
    );
  }
  const latestRun = await readJson<RunReport | null>(path.join(config.rawDirectory, "logs", "latest.json"), null);
  if (latestRun) await writeViewLogs(config, latestRun);
  else await mkdir(path.join(config.viewDirectory, "logs"), { recursive: true });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig(projectDirectory);
  const [command = "sync", ...options] = argv;
  if (command === "doctor") await doctor(config);
  else if (command === "sync") await sync(config, options);
  else if (command === "rebuild-views") await rebuildViewsFromArchive(config, options);
  else throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
