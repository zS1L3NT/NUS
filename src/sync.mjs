#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  atomicWrite, canvasAssignmentOrder, canvasModuleOrder, collisionSafeNames, compareStates,
  documentRecord, extractText, formatDate, htmlToMarkdown, orderPrefix,
  preserveIncompleteState, readJson, safeName, sha256File, stableJson, stateFromDocuments, writeJson,
} from './lib.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');

function resolvePath(value, baseDirectory) {
  const text = String(value ?? '');
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? path.join(homedir(), text.slice(2)) : text;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDirectory, expanded);
}

function resolveFromProject(value) {
  return resolvePath(value, projectDirectory);
}

async function loadConfig() {
  const config = await readJson(path.join(projectDirectory, 'config.json'));
  if (!config) throw new Error('Unable to read config.json');
  const knownContent = await readJson(resolveFromProject(config.knownContent || 'known-content.json'), {});
  return {
    ...config,
    canvasBinary: resolvePath(config.canvasBinary, projectDirectory),
    rawDirectory: resolvePath(config.rawDirectory || './raw', projectDirectory),
    viewDirectory: resolvePath(config.viewDirectory || '~/NUS', projectDirectory),
    courses: config.courses.map((course) => ({ ...course, knownContent: knownContent[course.code] || {} })),
  };
}

async function canvasJson(config, args) {
  const { stdout } = await execFileAsync(config.canvasBinary, [
    ...args, '--instance', config.canvasInstance, '-o', 'json', '--no-cache', '--quiet',
  ], { maxBuffer: 250 * 1024 * 1024 });
  const output = stdout.trim();
  if (/^No overrides\b/i.test(output) || /^No .+ found\.?$/i.test(output)) return [];
  return JSON.parse(output);
}

async function canvasDownload(config, fileId, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  await execFileAsync(config.canvasBinary, [
    'files', 'download', String(fileId), '--destination', temporary,
    '--instance', config.canvasInstance, '--no-cache', '--quiet',
  ], { maxBuffer: 10 * 1024 * 1024 });
  await rename(temporary, destination);
}

function sanitizeCanvasSecrets(value) {
  if (Array.isArray(value)) return value.map(sanitizeCanvasSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeCanvasSecrets(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/([?&](?:verifier|access_token)=)[^&"'\s<>\\]+/gi, '$1<redacted>')
    .replace(/([?&](?:verifier|access_token)=)[^&"'\s<>]+/gi, '$1<redacted>');
}

async function collectResource(config, warnings, kind, args, fallback = []) {
  try {
    return await canvasJson(config, args);
  } catch (error) {
    const rawMessage = String(error.stderr || error.message || error).trim();
    const structured = rawMessage.split('\n').map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((item) => item?.error);
    const message = structured
      ? `${structured.command || kind}: ${String(structured.error).trim()}`
      : rawMessage.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d/g, '<timestamp>');
    warnings.push({ kind, message });
    return fallback;
  }
}

function moduleItems(modules) {
  return modules.flatMap((module) => module.items || []);
}

function embeddedFileIds(value) {
  const ids = new Set();
  const serialized = JSON.stringify(value);
  for (const match of serialized.matchAll(/\/files\/(\d+)/g)) ids.add(Number(match[1]));
  return ids;
}

async function supplementPages(config, warnings, courseId, modules, listedPages, knownContent = {}) {
  const pagesByUrl = new Map(listedPages.map((page) => [page.url, page]));
  const pageUrls = new Set(moduleItems(modules)
    .filter((item) => item.type === 'Page' && item.page_url)
    .map((item) => item.page_url));
  for (const pageUrl of knownContent.page_urls || []) pageUrls.add(pageUrl);
  for (const pageUrl of [...pageUrls].sort()) {
    if (pagesByUrl.has(pageUrl)) continue;
    const page = await collectResource(config, warnings, 'page', ['pages', 'get', pageUrl, '--course-id', String(courseId)], null);
    if (page) pagesByUrl.set(page.url || pageUrl, page);
  }
  return [...pagesByUrl.values()].sort((left, right) => String(left.url).localeCompare(String(right.url)));
}

async function supplementFiles(config, warnings, resources, listedFiles, knownContent = {}) {
  const filesById = new Map(listedFiles.map((file) => [Number(file.id), file]));
  const fileIds = embeddedFileIds(resources);
  const knownFiles = new Map((knownContent.files || []).map((file) => [Number(file.id), file]));
  for (const fileId of knownFiles.keys()) fileIds.add(fileId);
  for (const item of moduleItems(resources.modules)) {
    if (item.type === 'File' && item.content_id) fileIds.add(Number(item.content_id));
  }
  for (const fileId of [...fileIds].sort((left, right) => left - right)) {
    if (filesById.has(fileId)) continue;
    const file = await collectResource(config, warnings, 'file', ['files', 'get', String(fileId)], null);
    if (file) filesById.set(Number(file.id || fileId), file);
    else if (knownFiles.has(fileId)) filesById.set(fileId, { ...knownFiles.get(fileId), _legacy_seed: true });
  }
  return [...filesById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function supplementFolders(config, warnings, listedFolders, files) {
  const foldersById = new Map((listedFolders || [])
    .filter((folder) => folder?.id != null)
    .map((folder) => [Number(folder.id), folder]));
  const pending = [...new Set([
    ...(files || []).map((file) => Number(file.folder_id)),
    ...(listedFolders || []).map((folder) => Number(folder.parent_folder_id)),
  ]
    .filter((folderId) => Number.isFinite(folderId) && folderId > 0 && !foldersById.has(folderId)))].sort((left, right) => left - right);

  for (let index = 0; index < pending.length; index += 1) {
    const folderId = pending[index];
    if (foldersById.has(folderId)) continue;
    const result = await collectResource(config, warnings, 'folder', ['folders', 'get', '--folder-id', String(folderId)], null);
    const folder = Array.isArray(result) ? result[0] : result;
    if (!folder?.id) continue;
    foldersById.set(Number(folder.id), folder);
    const parentId = Number(folder.parent_folder_id);
    if (Number.isFinite(parentId) && parentId > 0 && !foldersById.has(parentId) && !pending.includes(parentId)) pending.push(parentId);
  }
  return [...foldersById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function collectCourse(config, configuredCourse) {
  const warnings = [];
  const courseId = configuredCourse.id;
  const course = await canvasJson(config, ['courses', 'get', String(courseId)]);
  const modules = await collectResource(config, warnings, 'module', ['modules', 'list', '--course-id', String(courseId), '--include', 'items,content_details']);
  const listedPages = await collectResource(config, warnings, 'page-list', ['pages', 'list', '--course-id', String(courseId), '--include', 'body']);
  const pages = await supplementPages(config, warnings, courseId, modules, listedPages, configuredCourse.knownContent);
  const assignmentGroups = await collectResource(config, warnings, 'assignment-group-list', ['assignment-groups', 'list', '--course-id', String(courseId)]);
  const assignments = await collectResource(config, warnings, 'assignment-list', ['assignments', 'list', '--course-id', String(courseId)]);
  const assignmentOverrides = {};
  for (const assignment of assignments) {
    assignmentOverrides[assignment.id] = await collectResource(
      config, warnings, 'assignment-override',
      ['overrides', 'list', '--course-id', String(courseId), '--assignment-id', String(assignment.id)],
    );
  }
  const announcements = await collectResource(config, warnings, 'announcement', ['announcements', 'list', '--course-id', String(courseId)]);
  const quizzes = await collectResource(config, warnings, 'quiz-list', ['quizzes', 'list', '--course-id', String(courseId)]);
  const calendarEvents = await collectResource(config, warnings, 'calendar', ['calendar', 'list', '--course-id', String(courseId), '--all-events']);
  const listedFolders = await collectResource(config, warnings, 'file-list', ['folders', 'list', '--course-id', String(courseId)]);
  const listedFiles = await collectResource(config, warnings, 'file-list', ['files', 'list', '--course-id', String(courseId)]);
  const files = await supplementFiles(config, warnings, { course, modules, pages, assignments, announcements, quizzes, calendarEvents }, listedFiles, configuredCourse.knownContent);
  const folders = await supplementFolders(config, warnings, listedFolders, files);
  return sanitizeCanvasSecrets({ configuredCourse, course, modules, pages, assignments, assignmentGroups, assignmentOverrides, announcements, files, folders, quizzes, calendarEvents, warnings });
}

async function existingFileMatches(filePath, size) {
  try {
    return (await stat(filePath)).size === size;
  } catch {
    return false;
  }
}

async function unlinkArchivedPath(courseDirectory, relativePath) {
  if (!relativePath) return false;
  try {
    await unlink(path.join(courseDirectory, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupGeneratedDocuments(courseDirectory, documents, incompleteKinds) {
  const incomplete = new Set(incompleteKinds);
  for (const kind of ['page', 'assignment', 'announcement', 'module', 'quiz']) {
    if (incomplete.has(kind)) continue;
    const directory = path.join(courseDirectory, 'content', `${kind}s`);
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const expected = new Set(documents
      .filter((document) => document.kind === kind && document.local_path)
      .map((document) => path.basename(document.local_path)));
    for (const name of names) {
      if (path.extname(name).toLocaleLowerCase('en') !== '.md' || expected.has(name)) continue;
      await unlink(path.join(directory, name));
    }
  }
}

function moduleViewItem(item, documents, fileEntries) {
  const byKindAndId = (kind, id) => documents.find((document) => document.kind === kind && document.document_id.endsWith(`:${kind}:${id}`));
  if (item.type === 'Page') return documents.find((document) => document.kind === 'page' && document.metadata?.page_url === item.page_url);
  if (item.type === 'Assignment') return byKindAndId('assignment', item.content_id);
  if (item.type === 'Quiz') return byKindAndId('quiz', item.content_id);
  if (item.type === 'File') return fileEntries.find((file) => String(file.canvas_id) === String(item.content_id));
  return null;
}

function moduleViewStub(item, courseId) {
  const url = item.html_url || item.external_url || item.url || `https://canvas.nus.edu.sg/courses/${courseId}/modules/items/${item.id}`;
  return `# ${item.title}\n\nCanvas item type: ${item.type}\n\n[Open this item in Canvas](${url})\n`;
}

async function buildModuleView(viewCourseDirectory, rawCourseDirectory, data, documents, fileEntries) {
  const viewDirectory = path.join(viewCourseDirectory, 'Modules');
  const manifestPath = path.join(rawCourseDirectory, '.module-view.json');
  const previous = await readJson(manifestPath, { paths: [] });
  for (const relativePath of [...(previous.paths || [])].sort((left, right) => right.length - left.length)) {
    await rm(path.join(viewDirectory, relativePath), { recursive: true, force: true });
  }
  await mkdir(viewDirectory, { recursive: true });

  const generatedPaths = [];
  const moduleOrder = canvasModuleOrder(data.modules);
  const moduleNames = collisionSafeNames(data.modules, (module) => safeName(module.name), (module) => module.id);
  const addPath = (relativePath) => { generatedPaths.push(relativePath.split(path.sep).join('/')); return path.join(viewDirectory, relativePath); };

  for (const module of data.modules) {
    const moduleDirectoryName = `${orderPrefix(moduleOrder.moduleRanks.get(Number(module.id)))}${moduleNames.get(module)}`;
    const moduleDirectory = addPath(moduleDirectoryName);
    await mkdir(moduleDirectory, { recursive: true });
    const items = module.items || [];
    const stack = [];
    const levelCounters = new Map();
    for (const [index, item] of items.entries()) {
      const indent = Number(item.indent || 0);
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const itemNumber = (levelCounters.get(indent) || 0) + 1;
      levelCounters.set(indent, itemNumber);
      for (const level of levelCounters.keys()) if (level > indent) levelCounters.delete(level);
      const parent = stack.at(-1)?.directory || moduleDirectory;
      const hasChildren = Number(items[index + 1]?.indent || 0) > indent;
      const name = `${orderPrefix(itemNumber)}${safeName(item.title || `${item.type} ${item.id}`)}`;
      const source = moduleViewItem(item, documents, fileEntries);
      let itemPath;
      if (hasChildren) {
        const itemDirectory = addPath(path.relative(viewDirectory, path.join(parent, name)));
        await mkdir(itemDirectory, { recursive: true });
        itemPath = addPath(path.relative(viewDirectory, path.join(itemDirectory, name)) + (source?.local_path ? '' : '.md'));
        if (source?.local_path) {
          await symlink(path.relative(path.dirname(itemPath), path.join(rawCourseDirectory, source.local_path)), itemPath);
        } else {
          await atomicWrite(itemPath, moduleViewStub(item, data.course.id));
        }
        stack.push({ indent, directory: itemDirectory });
      } else {
        itemPath = addPath(path.relative(viewDirectory, path.join(parent, `${name}${source?.local_path ? '' : '.md'}`)));
        if (source?.local_path) {
          await symlink(path.relative(path.dirname(itemPath), path.join(rawCourseDirectory, source.local_path)), itemPath);
        } else {
          await atomicWrite(itemPath, moduleViewStub(item, data.course.id));
        }
      }
    }
  }
  await writeJson(manifestPath, { paths: generatedPaths });
}

function canvasFolderViewPath(file, folders) {
  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  const parts = [];
  let current = byId.get(Number(file.folder_id));
  while (current && !/^course files$/i.test(String(current.name || current.full_name || ''))) {
    parts.unshift(current);
    current = byId.get(Number(current.parent_folder_id));
  }
  const pathParts = [];
  for (const folder of parts) {
    const siblings = folders.filter((candidate) => Number(candidate.parent_folder_id) === Number(folder.parent_folder_id))
      .sort((left, right) => safeName(left.name).localeCompare(safeName(right.name), 'en') || Number(left.id) - Number(right.id));
    const folderIndex = siblings.findIndex((sibling) => Number(sibling.id) === Number(folder.id));
    pathParts.push(`${orderPrefix(folderIndex + 1)}${safeName(folder.name)}`);
  }
  return pathParts;
}

function hasCompleteCanvasFolderPath(file, folders) {
  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  let current = byId.get(Number(file.folder_id));
  while (current && !/^course files$/i.test(String(current.name || current.full_name || ''))) {
    current = byId.get(Number(current.parent_folder_id));
  }
  return Boolean(current);
}

async function pruneEmptyGeneratedDirectories(directory, rootDirectory, preservedDirectories) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    await pruneEmptyGeneratedDirectories(path.join(directory, entry.name), rootDirectory, preservedDirectories);
  }
  entries = await readdir(directory, { withFileTypes: true });
  const meaningfulEntries = entries.filter((entry) => entry.name !== '.DS_Store');
  const relativeDirectory = path.relative(rootDirectory, directory).split(path.sep).join('/');
  if (!meaningfulEntries.length && path.basename(directory).startsWith('(') && !preservedDirectories.has(relativeDirectory)) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildCollectionViews(viewCourseDirectory, rawCourseDirectory, data, documents, fileEntries) {
  const viewDirectory = viewCourseDirectory;
  const manifestPath = path.join(rawCourseDirectory, '.collection-view.json');
  const previous = await readJson(manifestPath, { paths: [] });
  for (const relativePath of [...(previous.paths || [])].sort((left, right) => right.length - left.length)) {
    await rm(path.join(viewDirectory, relativePath), { recursive: true, force: true });
  }
  await mkdir(viewDirectory, { recursive: true });
  const generatedPaths = [];
  const addPath = (absolutePath) => {
    generatedPaths.push(path.relative(viewDirectory, absolutePath).split(path.sep).join('/'));
    return absolutePath;
  };
  const link = async (absolutePath, sourcePath) => {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await symlink(path.relative(path.dirname(absolutePath), sourcePath), absolutePath);
  };
  const collection = async (directoryName, items, nameForItem, sourceForItem, sortItems = items) => {
    const directory = path.join(viewDirectory, directoryName);
    await mkdir(directory, { recursive: true });
    const names = collisionSafeNames(items, nameForItem, (item) => item.id ?? item.canvas_id ?? item.document_id);
    for (const item of sortItems) {
      const source = sourceForItem(item);
      if (!source) continue;
      const target = addPath(path.join(directory, names.get(item)));
      await link(target, path.join(rawCourseDirectory, source));
    }
  };

  const assignments = data.assignments || [];
  const assignmentOrder = (data.warnings || []).some((warning) => ['assignment-list', 'assignment-group-list'].includes(warning.kind))
    ? new Map()
    : canvasAssignmentOrder(assignments, data.assignmentGroups || []);
  const assignmentDocuments = documents.filter((document) => document.kind === 'assignment');
  await collection('Assignments', assignments,
    (assignment) => `${orderPrefix(assignmentOrder.get(Number(assignment.id)))}${safeName(assignment.name)}.md`,
    (assignment) => assignmentDocuments.find((document) => document.document_id.endsWith(`:assignment:${assignment.id}`))?.local_path,
    [...assignments].sort((left, right) => (assignmentOrder.get(Number(left.id)) || 999999) - (assignmentOrder.get(Number(right.id)) || 999999)));

  const announcements = [...(data.announcements || [])].sort((left, right) => new Date(left.posted_at || 0) - new Date(right.posted_at || 0));
  const announcementDocuments = documents.filter((document) => document.kind === 'announcement');
  await collection('Announcements', announcements,
    (announcement) => `${orderPrefix(announcements.indexOf(announcement) + 1)}${safeName(announcement.title)}.md`,
    (announcement) => announcementDocuments.find((document) => document.document_id.endsWith(`:announcement:${announcement.id}`))?.local_path,
    announcements);

  const quizzes = data.quizzes || [];
  const quizDocuments = documents.filter((document) => document.kind === 'quiz');
  await collection('Quizzes', quizzes,
    (quiz) => `${orderPrefix(quizzes.indexOf(quiz) + 1)}${safeName(quiz.title)}.md`,
    (quiz) => quizDocuments.find((document) => document.document_id.endsWith(`:quiz:${quiz.id}`))?.local_path,
    [...quizzes].sort((left, right) => (left.position ?? 999999) - (right.position ?? 999999) || Number(left.id) - Number(right.id)));

  const fileDirectory = path.join(viewDirectory, 'Files');
  await mkdir(fileDirectory, { recursive: true });
  const fileRecords = new Map((data.files || []).map((file) => [String(file.id), file]));
  const preservedDirectories = new Set();
  for (const folder of data.folders || []) {
    if (/^course files$/i.test(String(folder.name || folder.full_name || ''))) continue;
    if (!hasCompleteCanvasFolderPath({ folder_id: folder.id }, data.folders || [])) continue;
    const folderParts = canvasFolderViewPath({ folder_id: folder.id }, data.folders || []);
    if (!folderParts.length) continue;
    const relativeDirectory = path.join(...folderParts).split(path.sep).join('/');
    preservedDirectories.add(relativeDirectory);
    await mkdir(path.join(fileDirectory, ...folderParts), { recursive: true });
  }
  const filesByFolder = new Map();
  for (const file of fileEntries) {
    const fileRecord = fileRecords.get(String(file.canvas_id));
    if (fileRecord?.hidden || fileRecord?.hidden_for_user) continue;
    if (fileRecord?.folder_id && !hasCompleteCanvasFolderPath(fileRecord, data.folders || [])) continue;
    const folderId = String(fileRecord?.folder_id || 'root');
    if (!filesByFolder.has(folderId)) filesByFolder.set(folderId, []);
    filesByFolder.get(folderId).push(file);
  }
  for (const [folderId, folderFiles] of filesByFolder) {
    const folderRecord = fileRecords.get(String(folderFiles[0].canvas_id));
    const folderParts = canvasFolderViewPath(folderRecord || {}, data.folders || []);
    const directory = folderId === 'root' ? fileDirectory : path.join(fileDirectory, ...folderParts);
    const fileNames = collisionSafeNames(folderFiles, (file) => `${safeName(file.name)}`, (file) => file.canvas_id);
    const orderedFiles = [...folderFiles].sort((left, right) => safeName(left.name).localeCompare(safeName(right.name), 'en') || Number(left.canvas_id) - Number(right.canvas_id));
    const rootFolderId = (data.folders || []).find((folder) => /^course files$/i.test(String(folder.name || folder.full_name || '')))?.id;
    const childFolderCount = (data.folders || [])
      .filter((folder) => Number(folder.parent_folder_id) === Number(folderId === 'root' ? rootFolderId : folderId)).length;
    for (const [fileIndex, file] of orderedFiles.entries()) {
      const target = addPath(path.join(directory, `${orderPrefix(childFolderCount + fileIndex + 1)}${fileNames.get(file)}`));
      await link(target, path.join(rawCourseDirectory, file.local_path));
    }
  }
  await pruneEmptyGeneratedDirectories(fileDirectory, fileDirectory, preservedDirectories);

  const modulePageUrls = new Set((data.modules || []).flatMap((module) => (module.items || [])
    .filter((item) => item.type === 'Page' && item.page_url)
    .map((item) => item.page_url)));
  const extraPages = documents.filter((document) => document.kind === 'page'
    && !modulePageUrls.has(document.metadata?.page_url) && document.content.trim());
  const pageDirectory = viewDirectory;
  await mkdir(pageDirectory, { recursive: true });
  const pageNames = collisionSafeNames(extraPages, (page) => `${page.title}.md`, (page) => page.document_id);
  for (const page of extraPages) {
    const target = addPath(path.join(pageDirectory, pageNames.get(page)));
    await link(target, path.join(rawCourseDirectory, page.local_path));
  }
  await writeJson(manifestPath, { paths: generatedPaths, pages_not_in_modules: extraPages.map((page) => ({ title: page.title, document_id: page.document_id, source_url: page.source_url })) });
  return extraPages;
}

async function archiveFiles(config, data, courseDirectory, options) {
  const manifestPath = path.join(courseDirectory, 'file-manifest.json');
  const previous = await readJson(manifestPath, { files: {} });
  const fileListIncomplete = data.warnings.some((warning) => warning.kind === 'file-list');
  const manifest = {
    course: data.configuredCourse.code,
    files: fileListIncomplete ? { ...(previous.files || {}) } : {},
  };
  const entries = [];
  for (const file of [...data.files].sort((left, right) => left.id - right.id)) {
    const displayName = file.display_name || file.filename || `file-${file.id}`;
    const relativePath = path.join('content', 'files', String(file.id), safeName(displayName));
    const destination = path.join(courseDirectory, relativePath);
    const old = previous.files?.[file.id];
    const matches = await existingFileMatches(destination, file.size);
    let status = 'metadata-only';
    let contentSha256 = old?.content_sha256 ?? '';
    let origin = old?.origin ?? '';
    let legacyPreserved = old?.legacy_preserved ?? null;
    const unchanged = matches && old?.updated_at === file.updated_at && old?.size === file.size;
    if (options.downloadFiles && file.size > config.maxFileBytes) status = 'skipped-too-large';
    else if (options.downloadFiles && unchanged) status = origin ? 'legacy-preserved' : 'unchanged';
    else if (options.downloadFiles) {
      try {
        await canvasDownload(config, file.id, destination);
        status = 'downloaded';
        contentSha256 = await sha256File(destination);
        origin = '';
      } catch (error) {
        status = 'download-failed';
        const rawMessage = String(error.stderr || error.message || error).trim();
        const structured = rawMessage.split('\n').map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).find((item) => item?.error);
        const reason = structured ? `files.download: ${structured.error}` : rawMessage.split('\n')[0];
        data.warnings.push({ kind: 'file', message: `${file.id} — ${displayName}: ${reason}` });
      }
    }
    if (options.downloadFiles && matches && !contentSha256) contentSha256 = await sha256File(destination);

    let text = old?.text ?? { status: 'not-requested', bytes: 0 };
    const textRelativePath = path.join('content', 'text', 'files', String(file.id), `${safeName(displayName)}.txt`);
    if (options.extractText && (status === 'downloaded' || status === 'unchanged' || status === 'legacy-preserved')) {
      const textDestination = path.join(courseDirectory, textRelativePath);
      if (status === 'downloaded' || !(await existingFileMatches(textDestination, old?.text?.file_bytes))) {
        text = await extractText(destination, textDestination, {
          contentType: file['content-type'] || '',
          maxSourceBytes: config.maxTextSourceBytes,
        });
        if (text.status === 'extracted') text.file_bytes = (await stat(textDestination)).size;
      }
    }
    if (options.extractText && legacyPreserved?.local_path) {
      const preservedSource = path.join(courseDirectory, legacyPreserved.local_path);
      const preservedTextRelative = path.join('content', 'text', 'legacy-preserved', `${file.id}-${safeName(displayName)}.txt`);
      const preservedTextDestination = path.join(courseDirectory, preservedTextRelative);
      const previousText = legacyPreserved.text ?? { status: 'not-requested', bytes: 0 };
      if (!(await existingFileMatches(preservedTextDestination, previousText.file_bytes))) {
        const extracted = await extractText(preservedSource, preservedTextDestination, {
          contentType: file['content-type'] || '',
          maxSourceBytes: config.maxTextSourceBytes,
        });
        if (extracted.status === 'extracted') extracted.file_bytes = (await stat(preservedTextDestination)).size;
        legacyPreserved = {
          ...legacyPreserved,
          text_path: extracted.status === 'extracted' ? preservedTextRelative.split(path.sep).join('/') : '',
          text: extracted,
        };
      }
    }
    const entry = {
      canvas_id: file.id,
      name: displayName,
      size: file.size,
      updated_at: file.updated_at,
      content_type: file['content-type'] || '',
      source_url: file.url,
      local_path: relativePath.split(path.sep).join('/'),
      status,
      content_sha256: contentSha256,
      origin,
      legacy_preserved: legacyPreserved,
      text_path: text.status === 'extracted' ? textRelativePath.split(path.sep).join('/') : '',
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
        old.local_path, old.text_path,
        old.legacy_preserved?.local_path, old.legacy_preserved?.text_path,
      ]) await unlinkArchivedPath(courseDirectory, oldPath);
    }
  }
  await writeJson(manifestPath, manifest);
  return entries;
}

function assignmentDates(assignment, overrides) {
  const dates = [];
  if (assignment.due_at) dates.push({ audience: 'Course', due_at: assignment.due_at, unlock_at: assignment.unlock_at, lock_at: assignment.lock_at });
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

async function buildDocuments(config, data, courseDirectory, fileEntries) {
  const code = data.configuredCourse.code;
  const documents = [];
  documents.push(documentRecord({
    id: data.course.id, kind: 'course', course: code, title: data.course.name,
    sourceUrl: `https://canvas.nus.edu.sg/courses/${data.course.id}`,
    metadata: { course_id: data.course.id, course_code: data.course.course_code, default_view: data.course.default_view },
    content: htmlToMarkdown(data.course.syllabus_body || ''),
  }));
  for (const page of data.pages) {
    const content = htmlToMarkdown(page.body || '');
    const localPath = path.posix.join('content/pages', `${page.page_id || safeName(page.url)}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${page.title}\n\n${content}`);
    documents.push(documentRecord({
      id: page.page_id || page.url, kind: 'page', course: code, title: page.title,
      sourceUrl: page.html_url || `https://canvas.nus.edu.sg/courses/${data.course.id}/pages/${page.url}`,
      updatedAt: page.updated_at, localPath,
      metadata: { page_url: page.url, published: page.published, front_page: page.front_page }, content,
    }));
  }
  for (const assignment of data.assignments) {
    const content = htmlToMarkdown(assignment.description || '');
    const dates = assignmentDates(assignment, data.assignmentOverrides[assignment.id]);
    const localPath = path.posix.join('content/assignments', `${assignment.id}.md`);
    const dateLines = dates.map((date) => `- ${date.audience}: ${date.due_at || 'no due date'}`).join('\n');
    await atomicWrite(path.join(courseDirectory, localPath), `# ${assignment.name}\n\n## Dates\n\n${dateLines || '- No dated variants'}\n\n${content}`);
    documents.push(documentRecord({
      id: assignment.id, kind: 'assignment', course: code, title: assignment.name,
      sourceUrl: assignment.html_url, updatedAt: assignment.updated_at, localPath,
      metadata: {
        dates, points_possible: assignment.points_possible, published: assignment.published,
        submission_types: assignment.submission_types || [], assignment_group_id: assignment.assignment_group_id,
      }, content,
    }));
  }
  const sortedAnnouncements = [...data.announcements].sort((left, right) => new Date(left.posted_at || 0) - new Date(right.posted_at || 0));
  for (const announcement of sortedAnnouncements) {
    const content = htmlToMarkdown(announcement.message || '');
    const localPath = path.posix.join('content/announcements', `${announcement.id}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${announcement.title}\n\n${content}`);
    documents.push(documentRecord({
      id: announcement.id, kind: 'announcement', course: code, title: announcement.title,
      sourceUrl: announcement.html_url, updatedAt: announcement.posted_at, localPath,
      metadata: { posted_at: announcement.posted_at, published: announcement.published }, content,
    }));
  }
  for (const module of data.modules) {
    const lines = (module.items || []).map((item) => `${'  '.repeat(item.indent || 0)}- ${item.type}: ${item.title} ${item.html_url || item.external_url || ''}`);
    const localPath = path.posix.join('content/modules', `${module.id}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${module.name}\n\n${lines.join('\n')}\n`);
    documents.push(documentRecord({
      id: module.id, kind: 'module', course: code, title: module.name,
      localPath,
      metadata: { position: module.position, published: module.published, unlock_at: module.unlock_at },
      content: lines.join('\n'),
    }));
  }
  for (const quiz of data.quizzes) {
    const localPath = path.posix.join('content/quizzes', `${quiz.id}.md`);
    const content = htmlToMarkdown(quiz.description || '');
    const dateLines = [
      quiz.due_at ? `- Due: ${quiz.due_at}` : '',
      quiz.unlock_at ? `- Opens: ${quiz.unlock_at}` : '',
      quiz.lock_at ? `- Closes: ${quiz.lock_at}` : '',
    ].filter(Boolean).join('\n');
    await atomicWrite(path.join(courseDirectory, localPath), `# ${quiz.title}\n\n## Details\n\n${dateLines || '- No dated variants'}\n\n${content}`);
    documents.push(documentRecord({
      id: quiz.id, kind: 'quiz', course: code, title: quiz.title,
      sourceUrl: quiz.html_url, updatedAt: quiz.updated_at, localPath,
      metadata: { due_at: quiz.due_at, unlock_at: quiz.unlock_at, lock_at: quiz.lock_at, points_possible: quiz.points_possible, published: quiz.published },
      content,
    }));
  }
  for (const event of data.calendarEvents) {
    documents.push(documentRecord({
      id: event.id, kind: 'calendar', course: code, title: event.title,
      sourceUrl: event.html_url, updatedAt: event.updated_at,
      metadata: { start_at: event.start_at, end_at: event.end_at, location_name: event.location_name, context_code: event.context_code },
      content: htmlToMarkdown(event.description || ''),
    }));
  }
  for (const file of fileEntries) {
    let searchableContent = '';
    for (const textPath of [file.text_path, file.legacy_preserved?.text_path].filter(Boolean)) {
      try { searchableContent += `${await readFile(path.join(courseDirectory, textPath), 'utf8')}\n`; } catch { /* sidecar is optional */ }
    }
    documents.push(documentRecord({
      id: file.canvas_id, kind: 'file', course: code, title: file.name,
      sourceUrl: file.source_url, updatedAt: file.updated_at, localPath: file.local_path,
      metadata: {
        size: file.size, content_type: file.content_type, content_sha256: file.content_sha256,
        origin: file.origin, text_path: file.text_path, text_status: file.text.status,
        legacy_preserved: file.legacy_preserved,
      }, content: searchableContent,
    }));
  }
  return documents.sort((left, right) => left.document_id.localeCompare(right.document_id));
}

function courseIndex(config, data, documents, files, collectedAt) {
  const code = data.configuredCourse.code;
  const lines = [
    `# ${code} — ${data.course.name}`, '',
    `Collected: ${formatDate(collectedAt, config.timezone)}`, '',
    `- [Canvas-shaped viewing tree](${path.relative(path.join(config.rawDirectory, code), path.join(config.viewDirectory, code)).split(path.sep).join('/') || '.'}/)`,
    '- Machine-oriented content: `content/`',
    '## Corpus', '',
    `- ${documents.length} normalized documents in [documents.jsonl](documents.jsonl)`,
    `- ${files.length} Canvas file records in [file-manifest.json](file-manifest.json)`,
    '- Lossless API responses in this course directory', '',
    '## Assignment dates', '',
    '| Due | Assignment | Audience |', '|---:|---|---|',
  ];
  const dated = data.assignments.flatMap((assignment) => assignmentDates(assignment, data.assignmentOverrides[assignment.id])
    .filter((date) => date.due_at)
    .map((date) => ({ assignment, ...date })))
    .sort((left, right) => new Date(left.due_at) - new Date(right.due_at));
  for (const item of dated) lines.push(`| ${formatDate(item.due_at, config.timezone)} | [${item.assignment.name}](${item.assignment.html_url}) | ${item.audience} |`);
  if (!dated.length) lines.push('| No dated assignments found | | |');
  lines.push('', '## Searchable content', '');
  for (const kind of ['page', 'assignment', 'announcement', 'module', 'quiz', 'calendar', 'file']) {
    const count = documents.filter((document) => document.kind === kind).length;
    lines.push(`- ${kind}: ${count}`);
  }
  if (data.warnings.length) {
    lines.push('', '## Collection warnings', '');
    for (const warning of data.warnings) appendWarning(lines, warning);
  }
  return `${lines.join('\n')}\n`;
}

async function archiveCourse(config, data, options, collectedAt) {
  const code = data.configuredCourse.code;
  const courseDirectory = path.join(config.rawDirectory, code);
  const viewCourseDirectory = path.join(config.viewDirectory, code);
  const rawDirectory = courseDirectory;
  await mkdir(rawDirectory, { recursive: true });
  for (const key of ['course', 'modules', 'pages', 'assignments', 'assignmentGroups', 'assignmentOverrides', 'announcements', 'files', 'folders', 'quizzes', 'calendarEvents', 'warnings']) {
    await writeJson(path.join(rawDirectory, `${key}.json`), data[key]);
  }
  const fileEntries = await archiveFiles(config, data, courseDirectory, options);
  await writeJson(path.join(rawDirectory, 'warnings.json'), data.warnings);
  const statePath = path.join(courseDirectory, 'state.json');
  const previousState = await readJson(statePath, {});
  const documents = await buildDocuments(config, data, courseDirectory, fileEntries);
  await buildModuleView(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
  await buildCollectionViews(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
  const jsonl = documents.map((document) => stableJson(document, 0)).join('\n');
  await atomicWrite(path.join(courseDirectory, 'documents.jsonl'), `${jsonl}${jsonl ? '\n' : ''}`);

  const currentState = stateFromDocuments(documents);
  const warningKinds = new Set(data.warnings.map((warning) => warning.kind));
  const incompleteKinds = [
    ['module', ['module']],
    ['page', ['page-list', 'page']],
    ['assignment', ['assignment-list']],
    ['announcement', ['announcement']],
    ['quiz', ['quiz-list']],
    ['calendar', ['calendar']],
    ['file', ['file-list']],
  ].filter(([, kinds]) => kinds.some((kind) => warningKinds.has(kind))).map(([kind]) => kind);
  const state = preserveIncompleteState(previousState, currentState, incompleteKinds);
  const changes = compareStates(previousState, state, incompleteKinds);
  for (const change of changes.filter((change) => change.action === 'removed')) {
    await unlinkArchivedPath(courseDirectory, previousState[change.document_id]?.local_path);
  }
  await cleanupGeneratedDocuments(courseDirectory, documents, incompleteKinds);
  await writeJson(statePath, state);
  await atomicWrite(path.join(courseDirectory, 'INDEX.md'), courseIndex(config, data, documents, fileEntries, collectedAt));
  return { code, data, documents, fileEntries, changes, baseline: Object.keys(previousState).length === 0 };
}

function changeSummary(changes) {
  return changes.reduce((totals, change) => {
    totals[change.action] += 1;
    return totals;
  }, { added: 0, modified: 0, removed: 0 });
}

function appendWarning(lines, warning) {
  const messageLines = String(warning.message || 'No details provided.')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  lines.push(`- **${warning.kind}**: ${messageLines.shift() || 'No details provided.'}`);
  for (const line of messageLines) lines.push(`  ${line}`);
}

async function moveOlderLogs(logsDirectory, olderDirectory) {
  await mkdir(olderDirectory, { recursive: true });
  const historicalLogPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d+)?Z\.(?:json|md)$/;
  const entries = await readdir(logsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !historicalLogPattern.test(entry.name)) continue;
    await rename(path.join(logsDirectory, entry.name), path.join(olderDirectory, entry.name));
  }
}

async function writeRunOutputs(config, results, startedAt) {
  const runId = startedAt.replace(/[:.]/g, '-');
  const completedAt = new Date().toISOString();
  const run = {
    run_id: runId, started_at: startedAt, completed_at: completedAt,
    courses: results.map((result) => ({ code: result.code, baseline: result.baseline, summary: changeSummary(result.changes), changes: result.changes, warnings: result.data.warnings })),
  };
  const lines = ['# Canvas CLI sync changes', '', `Run: ${formatDate(startedAt, config.timezone)}`, '', '| Course | Added | Modified | Removed |', '|---|---:|---:|---:|'];
  for (const course of run.courses) lines.push(`| ${course.code} | ${course.summary.added} | ${course.summary.modified} | ${course.summary.removed} |`);
  for (const course of run.courses) {
    lines.push('', `## ${course.code}`, '');
    if (course.baseline) lines.push('_Initial baseline: every discovered document is reported as added._', '');
    if (!course.changes.length) lines.push('No content changes detected.', '');
    for (const change of course.changes) {
      lines.push(`- **${change.action.toUpperCase()}** ${change.kind}: ${change.title}`);
      for (const field of change.fields) lines.push(`  - ${field.field}: \`${stableJson(field.before, 0)}\` → \`${stableJson(field.after, 0)}\``);
    }
    if (course.warnings.length) {
      lines.push('### Warnings', '');
      for (const warning of course.warnings) appendWarning(lines, warning);
      lines.push('');
    }
  }
  const logsDirectory = path.join(config.rawDirectory, 'logs');
  const olderDirectory = path.join(logsDirectory, 'older');
  await moveOlderLogs(logsDirectory, olderDirectory);
  await writeJson(path.join(olderDirectory, `${runId}.json`), run);
  await writeJson(path.join(logsDirectory, 'latest.json'), run);
  await atomicWrite(path.join(olderDirectory, `${runId}.md`), `${lines.join('\n')}\n`);
  await atomicWrite(path.join(logsDirectory, 'latest.md'), `${lines.join('\n')}\n`);

  const rootLines = ['# NUS Canvas corpus (canvas-cli)', '', `Last updated: ${formatDate(completedAt, config.timezone)}`, '', '## Courses', ''];
  for (const result of results) rootLines.push(`- [${result.code} — ${result.data.course.name}](${result.code}/INDEX.md) — ${result.documents.length} documents, ${result.fileEntries.length} files`);
  const deadlines = results.flatMap((result) => result.data.assignments.flatMap((assignment) => assignmentDates(assignment, result.data.assignmentOverrides[assignment.id])
    .filter((date) => date.due_at)
    .map((date) => ({ code: result.code, assignment, ...date }))))
    .sort((left, right) => new Date(left.due_at) - new Date(right.due_at));
  rootLines.push('', '## Assignment dates', '', '| Due | Course | Assignment | Audience |', '|---:|---|---|---|');
  for (const item of deadlines) rootLines.push(`| ${formatDate(item.due_at, config.timezone)} | ${item.code} | [${item.assignment.name}](${item.assignment.html_url}) | ${item.audience} |`);
  rootLines.push('', '## Latest changes', '', '- [Human-readable report](logs/latest.md)', '- [Machine-readable report](logs/latest.json)');
  const coursesWithWarnings = run.courses.filter((course) => course.warnings.length);
  if (coursesWithWarnings.length) {
    rootLines.push('', '## Warnings', '');
    for (const course of coursesWithWarnings) {
      rootLines.push(`### ${course.code}`, '');
      for (const warning of course.warnings) appendWarning(rootLines, warning);
      rootLines.push('');
    }
  }
  await atomicWrite(path.join(config.rawDirectory, 'INDEX.md'), `${rootLines.join('\n')}\n`);
  return run;
}

async function doctor(config) {
  const { stdout: version } = await execFileAsync(config.canvasBinary, ['version']);
  const { stdout: auth } = await execFileAsync(config.canvasBinary, ['auth', 'status']);
  console.log(version.trim());
  console.log(auth.trim());
  console.log(`Raw directory: ${config.rawDirectory}`);
  console.log(`View directory: ${config.viewDirectory}`);
}

function parseOptions(config, argv) {
  const courseFlag = argv.indexOf('--course');
  const requestedCourse = courseFlag >= 0 ? argv[courseFlag + 1]?.toUpperCase() : null;
  const courses = requestedCourse ? config.courses.filter((course) => course.code === requestedCourse) : config.courses;
  if (!courses.length) throw new Error(`Unknown course: ${requestedCourse}`);
  return {
    courses,
    downloadFiles: config.downloadFiles && !argv.includes('--metadata-only'),
    extractText: config.extractText && !argv.includes('--no-extract') && !argv.includes('--metadata-only'),
  };
}

async function sync(config, argv) {
  const options = parseOptions(config, argv);
  const startedAt = new Date().toISOString();
  const results = [];
  await mkdir(config.rawDirectory, { recursive: true });
  for (const course of options.courses) {
    console.log(`[${course.code}] collecting Canvas metadata`);
    const data = await collectCourse(config, course);
    console.log(`[${course.code}] downloading/indexing ${data.files.length} files`);
    results.push(await archiveCourse(config, data, options, startedAt));
  }
  const run = await writeRunOutputs(config, results, startedAt);
  await rebuildViewsFromArchive(config, options.courses.length === config.courses.length
    ? [] : ['--course', options.courses[0].code]);
  const total = run.courses.reduce((summary, course) => ({
    added: summary.added + course.summary.added,
    modified: summary.modified + course.summary.modified,
    removed: summary.removed + course.summary.removed,
  }), { added: 0, modified: 0, removed: 0 });
  console.log(`Completed: ${total.added} added, ${total.modified} modified, ${total.removed} removed.`);
  for (const course of run.courses) {
    for (const warning of course.warnings) {
      const message = String(warning.message || 'No details provided.').split('\n').filter(Boolean).join('\n  ');
      console.warn(`[${course.code}] ${warning.kind}: ${message}`);
    }
  }
  console.log(`Index: ${path.join(config.rawDirectory, 'INDEX.md')}`);
}

async function rebuildViewsFromArchive(config, argv) {
  const courseFlag = argv.indexOf('--course');
  const requestedCourse = courseFlag >= 0 ? argv[courseFlag + 1]?.toUpperCase() : null;
  const courses = requestedCourse ? config.courses.filter((course) => course.code === requestedCourse) : config.courses;
  if (!courses.length) throw new Error(`Unknown course: ${requestedCourse}`);
  for (const configuredCourse of courses) {
    const courseDirectory = path.join(config.rawDirectory, configuredCourse.code);
    const viewCourseDirectory = path.join(config.viewDirectory, configuredCourse.code);
    const rawDirectory = courseDirectory;
    const readRaw = async (name, fallback = []) => readJson(path.join(rawDirectory, `${name}.json`), fallback);
    const data = {
      configuredCourse,
      course: await readRaw('course', {}),
      modules: await readRaw('modules'),
      assignments: await readRaw('assignments'),
      assignmentGroups: await readRaw('assignmentGroups'),
      announcements: await readRaw('announcements'),
      files: await readRaw('files'),
      folders: await readRaw('folders'),
      quizzes: await readRaw('quizzes'),
      warnings: await readRaw('warnings'),
    };
    const documentsPath = path.join(courseDirectory, 'documents.jsonl');
    const existingDocuments = (await readFile(documentsPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const documents = [...existingDocuments];
    for (const quiz of data.quizzes) {
      const index = documents.findIndex((document) => document.document_id === `${configuredCourse.code}:quiz:${quiz.id}`);
      if (index < 0) continue;
      const localPath = path.posix.join('content/quizzes', `${quiz.id}.md`);
      const content = htmlToMarkdown(quiz.description || '');
      const dateLines = [quiz.due_at ? `- Due: ${quiz.due_at}` : '', quiz.unlock_at ? `- Opens: ${quiz.unlock_at}` : '', quiz.lock_at ? `- Closes: ${quiz.lock_at}` : ''].filter(Boolean).join('\n');
      await atomicWrite(path.join(courseDirectory, localPath), `# ${quiz.title}\n\n## Details\n\n${dateLines || '- No dated variants'}\n\n${content}`);
      documents[index] = { ...documents[index], local_path: localPath, content_sha256: documentRecord({ id: quiz.id, kind: 'quiz', course: configuredCourse.code, title: quiz.title, content }).content_sha256, content };
    }
    const fileManifest = await readJson(path.join(courseDirectory, 'file-manifest.json'), { files: {} });
    const fileEntries = Object.values(fileManifest.files || {});
    await rm(viewCourseDirectory, { recursive: true, force: true });
    await buildModuleView(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
    const extraPages = await buildCollectionViews(viewCourseDirectory, courseDirectory, data, documents, fileEntries);
    await atomicWrite(documentsPath, `${documents.map((document) => stableJson(document, 0)).join('\n')}\n`);
    console.log(`[${configuredCourse.code}] rebuilt views; ${extraPages.length} content-bearing pages are not in modules`);
  }
}

const config = await loadConfig();
const command = process.argv[2] || 'sync';
if (command === 'doctor') await doctor(config);
else if (command === 'sync') await sync(config, process.argv.slice(3));
else if (command === 'rebuild-views') await rebuildViewsFromArchive(config, process.argv.slice(3));
else throw new Error(`Unknown command: ${command}`);
