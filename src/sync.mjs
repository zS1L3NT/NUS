#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  atomicWrite, compareStates, documentRecord, extractText, formatDate, htmlToMarkdown,
  readJson, safeName, sha256File, slug, stableJson, stateFromDocuments, writeJson,
} from './lib.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');

function resolveFromProject(value) {
  return path.resolve(projectDirectory, value);
}

async function loadConfig() {
  const config = await readJson(path.join(projectDirectory, 'config.json'));
  if (!config) throw new Error('Unable to read config.json');
  const knownContent = await readJson(resolveFromProject(config.knownContent || 'known-content.json'), {});
  return {
    ...config,
    canvasBinary: resolveFromProject(config.canvasBinary),
    archiveDirectory: resolveFromProject(config.archiveDirectory),
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

async function collectCourse(config, configuredCourse) {
  const warnings = [];
  const courseId = configuredCourse.id;
  const course = await canvasJson(config, ['courses', 'get', String(courseId)]);
  const modules = await collectResource(config, warnings, 'module', ['modules', 'list', '--course-id', String(courseId), '--include', 'items,content_details']);
  const listedPages = await collectResource(config, warnings, 'page-list', ['pages', 'list', '--course-id', String(courseId), '--include', 'body']);
  const pages = await supplementPages(config, warnings, courseId, modules, listedPages, configuredCourse.knownContent);
  const assignments = await collectResource(config, warnings, 'assignment', ['assignments', 'list', '--course-id', String(courseId)]);
  const assignmentOverrides = {};
  for (const assignment of assignments) {
    assignmentOverrides[assignment.id] = await collectResource(
      config, warnings, 'assignment',
      ['overrides', 'list', '--course-id', String(courseId), '--assignment-id', String(assignment.id)],
    );
  }
  const announcements = await collectResource(config, warnings, 'announcement', ['announcements', 'list', '--course-id', String(courseId)]);
  const quizzes = await collectResource(config, warnings, 'quiz-list', ['quizzes', 'list', '--course-id', String(courseId)]);
  const calendarEvents = await collectResource(config, warnings, 'calendar', ['calendar', 'list', '--course-id', String(courseId), '--all-events']);
  const folders = await collectResource(config, warnings, 'file-list', ['folders', 'list', '--course-id', String(courseId)]);
  const listedFiles = await collectResource(config, warnings, 'file-list', ['files', 'list', '--course-id', String(courseId)]);
  const files = await supplementFiles(config, warnings, { course, modules, pages, assignments, announcements, quizzes, calendarEvents }, listedFiles, configuredCourse.knownContent);
  return sanitizeCanvasSecrets({ configuredCourse, course, modules, pages, assignments, assignmentOverrides, announcements, files, folders, quizzes, calendarEvents, warnings });
}

function folderPath(file, folders) {
  const folder = folders.find((candidate) => candidate.id === file.folder_id);
  const fullName = String(folder?.full_name || folder?.name || 'root').replace(/^course files\/?/i, '');
  return fullName.split('/').filter(Boolean).map((part) => safeName(part)).join(path.sep) || 'root';
}

async function existingFileMatches(filePath, size) {
  try {
    return (await stat(filePath)).size === size;
  } catch {
    return false;
  }
}

async function archiveFiles(config, data, courseDirectory, options) {
  const manifestPath = path.join(courseDirectory, 'file-manifest.json');
  const previous = await readJson(manifestPath, { files: {} });
  const manifest = { course: data.configuredCourse.code, files: {} };
  const entries = [];
  for (const file of [...data.files].sort((left, right) => left.id - right.id)) {
    const displayName = file.display_name || file.filename || `file-${file.id}`;
    const relativePath = path.join('files', folderPath(file, data.folders), `${file.id}-${safeName(displayName)}`);
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
    const textRelativePath = path.join('text', 'files', folderPath(file, data.folders), `${file.id}-${safeName(displayName)}.txt`);
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
      const preservedTextRelative = path.join('text', 'legacy-preserved', `${file.id}-${safeName(displayName)}.txt`);
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
    const localPath = `documents/pages/${page.page_id || page.url}-${slug(page.title)}.md`;
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
    const localPath = `documents/assignments/${assignment.id}-${slug(assignment.name)}.md`;
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
  for (const announcement of data.announcements) {
    const content = htmlToMarkdown(announcement.message || '');
    const localPath = `documents/announcements/${announcement.id}-${slug(announcement.title)}.md`;
    await atomicWrite(path.join(courseDirectory, localPath), `# ${announcement.title}\n\n${content}`);
    documents.push(documentRecord({
      id: announcement.id, kind: 'announcement', course: code, title: announcement.title,
      sourceUrl: announcement.html_url, updatedAt: announcement.posted_at, localPath,
      metadata: { posted_at: announcement.posted_at, published: announcement.published }, content,
    }));
  }
  for (const module of data.modules) {
    const lines = (module.items || []).map((item) => `${'  '.repeat(item.indent || 0)}- ${item.type}: ${item.title} ${item.html_url || item.external_url || ''}`);
    documents.push(documentRecord({
      id: module.id, kind: 'module', course: code, title: module.name,
      metadata: { position: module.position, published: module.published, unlock_at: module.unlock_at },
      content: lines.join('\n'),
    }));
  }
  for (const quiz of data.quizzes) {
    documents.push(documentRecord({
      id: quiz.id, kind: 'quiz', course: code, title: quiz.title,
      sourceUrl: quiz.html_url, updatedAt: quiz.updated_at,
      metadata: { due_at: quiz.due_at, unlock_at: quiz.unlock_at, lock_at: quiz.lock_at, points_possible: quiz.points_possible, published: quiz.published },
      content: htmlToMarkdown(quiz.description || ''),
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
    '## Corpus', '',
    `- ${documents.length} normalized documents in [documents.jsonl](documents.jsonl)`,
    `- ${files.length} Canvas file records in [file-manifest.json](file-manifest.json)`,
    '- Lossless API responses in `raw/`', '',
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
  const courseDirectory = path.join(config.archiveDirectory, code);
  const rawDirectory = path.join(courseDirectory, 'raw');
  await mkdir(rawDirectory, { recursive: true });
  for (const key of ['course', 'modules', 'pages', 'assignments', 'assignmentOverrides', 'announcements', 'files', 'folders', 'quizzes', 'calendarEvents', 'warnings']) {
    await writeJson(path.join(rawDirectory, `${key}.json`), data[key]);
  }
  const fileEntries = await archiveFiles(config, data, courseDirectory, options);
  await writeJson(path.join(rawDirectory, 'warnings.json'), data.warnings);
  const documents = await buildDocuments(config, data, courseDirectory, fileEntries);
  const jsonl = documents.map((document) => stableJson(document, 0)).join('\n');
  await atomicWrite(path.join(courseDirectory, 'documents.jsonl'), `${jsonl}${jsonl ? '\n' : ''}`);

  const statePath = path.join(courseDirectory, 'state.json');
  const previousState = await readJson(statePath, {});
  const state = stateFromDocuments(documents);
  const incompleteKinds = [...new Set(data.warnings.map((warning) => warning.kind))];
  const changes = compareStates(previousState, state, incompleteKinds);
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
  const logsDirectory = path.join(config.archiveDirectory, 'logs');
  await writeJson(path.join(logsDirectory, `${runId}.json`), run);
  await writeJson(path.join(logsDirectory, 'latest.json'), run);
  await atomicWrite(path.join(logsDirectory, `${runId}.md`), `${lines.join('\n')}\n`);
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
  await atomicWrite(path.join(config.archiveDirectory, 'INDEX.md'), `${rootLines.join('\n')}\n`);
  return run;
}

async function doctor(config) {
  const { stdout: version } = await execFileAsync(config.canvasBinary, ['version']);
  const { stdout: auth } = await execFileAsync(config.canvasBinary, ['auth', 'status']);
  console.log(version.trim());
  console.log(auth.trim());
  console.log(`Archive: ${config.archiveDirectory}`);
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
  await mkdir(config.archiveDirectory, { recursive: true });
  for (const course of options.courses) {
    console.log(`[${course.code}] collecting Canvas metadata`);
    const data = await collectCourse(config, course);
    console.log(`[${course.code}] downloading/indexing ${data.files.length} files`);
    results.push(await archiveCourse(config, data, options, startedAt));
  }
  const run = await writeRunOutputs(config, results, startedAt);
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
  console.log(`Index: ${path.join(config.archiveDirectory, 'INDEX.md')}`);
}

const config = await loadConfig();
const command = process.argv[2] || 'sync';
if (command === 'doctor') await doctor(config);
else if (command === 'sync') await sync(config, process.argv.slice(3));
else throw new Error(`Unknown command: ${command}`);
