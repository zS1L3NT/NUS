import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const entityMap = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®',
};

export function decodeHtml(value = '') {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entityMap[entity.toLowerCase()] ?? match;
  });
}

export function htmlToMarkdown(html = '') {
  let text = String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const cleanLabel = decodeHtml(label.replace(/<[^>]+>/g, '')).trim() || href;
      return `[${cleanLabel}](${href})`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, body) => `\n${'#'.repeat(Number(level))} ${body}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeHtml(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? `${text}\n` : '';
}

export function safeName(value, fallback = 'untitled') {
  const normalized = decodeHtml(String(value ?? ''))
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (normalized || fallback).slice(0, 180);
}

export function slug(value, fallback = 'untitled') {
  return safeName(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value ?? null;
}

export function stableJson(value, space = 2) {
  return JSON.stringify(stableValue(value), null, space);
}

export async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

export async function writeJson(filePath, value) {
  await atomicWrite(filePath, `${stableJson(value)}\n`);
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function formatDate(value, timezone = 'Asia/Singapore') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function documentRecord({ id, kind, course, title, sourceUrl = '', updatedAt = '', metadata = {}, content = '', localPath = '' }) {
  const normalizedContent = String(content ?? '').replace(/\r\n?/g, '\n').trim();
  return stableValue({
    document_id: `${course}:${kind}:${id}`,
    course,
    kind,
    title: String(title ?? ''),
    source_url: String(sourceUrl ?? ''),
    local_path: String(localPath ?? ''),
    updated_at: String(updatedAt ?? ''),
    metadata,
    content_sha256: sha256(normalizedContent),
    content: normalizedContent,
  });
}

export function stateFromDocuments(documents) {
  return Object.fromEntries(documents.map((document) => [document.document_id, {
    kind: document.kind,
    title: document.title,
    source_url: document.source_url,
    local_path: document.local_path,
    updated_at: document.updated_at,
    metadata: document.metadata,
    content_sha256: document.content_sha256,
  }]));
}

export function compareStates(previous = {}, current = {}, incompleteKinds = []) {
  const incomplete = new Set(incompleteKinds);
  const changes = [];
  for (const [id, after] of Object.entries(current)) {
    const before = previous[id];
    if (!before) {
      changes.push({ action: 'added', document_id: id, kind: after.kind, title: after.title, fields: [] });
      continue;
    }
    const fieldNames = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...fieldNames]
      .sort()
      .filter((field) => stableJson(before[field], 0) !== stableJson(after[field], 0))
      .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
    if (fields.length) changes.push({ action: 'modified', document_id: id, kind: after.kind, title: after.title, fields });
  }
  for (const [id, before] of Object.entries(previous)) {
    if (!current[id] && !incomplete.has(before.kind)) {
      changes.push({ action: 'removed', document_id: id, kind: before.kind, title: before.title, fields: [] });
    }
  }
  return changes.sort((left, right) => left.document_id.localeCompare(right.document_id));
}

function xmlText(xml, tagPattern) {
  const values = [];
  for (const match of xml.matchAll(tagPattern)) values.push(decodeHtml(match[1].replace(/<[^>]+>/g, '')));
  return values.map((value) => value.trim()).filter(Boolean).join('\n');
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

async function officeXmlText(filePath, extension) {
  const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-Z1', filePath], { maxBuffer: 50 * 1024 * 1024 });
  const entries = listing.split('\n').filter(Boolean).sort(naturalCompare);
  let selected;
  if (extension === '.pptx') selected = entries.filter((entry) => /^ppt\/(slides|notesSlides)\/.*\.xml$/.test(entry));
  else selected = entries.filter((entry) => /^xl\/(sharedStrings\.xml|worksheets\/.*\.xml)$/.test(entry));
  if (!selected.length) return '';
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, ...selected], { maxBuffer: 200 * 1024 * 1024 });
  if (extension === '.pptx') return xmlText(stdout, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g);
  return xmlText(stdout, /<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/g);
}

async function zipText(filePath) {
  const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-Z1', filePath], { maxBuffer: 50 * 1024 * 1024 });
  const entries = listing.split('\n')
    .filter((entry) => entry && !entry.endsWith('/') && !entry.startsWith('/') && !entry.split('/').includes('..'))
    .sort(naturalCompare);
  const sections = [`Archive contents:\n${entries.join('\n')}`];
  const plainExtensions = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.js', '.ts', '.py', '.java', '.sql']);
  for (const entry of entries) {
    const extension = path.extname(entry).toLowerCase();
    if (plainExtensions.has(extension)) {
      const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], { maxBuffer: 100 * 1024 * 1024 });
      sections.push(`## ${entry}\n\n${stdout.trim()}`);
    } else if (extension === '.xlsx' || extension === '.pptx') {
      const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 });
      const temporary = path.join(os.tmpdir(), `canvas-cli-extract-${process.pid}-${sha256(entry).slice(0, 12)}${extension}`);
      await writeFile(temporary, stdout);
      try {
        const extracted = await officeXmlText(temporary, extension);
        if (extracted) sections.push(`## ${entry}\n\n${extracted}`);
      } finally {
        await unlink(temporary);
      }
    }
  }
  return sections.join('\n\n');
}

export async function extractText(filePath, destination, { contentType = '', maxSourceBytes = 100 * 1024 * 1024 } = {}) {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxSourceBytes) return { status: 'skipped-too-large', bytes: 0 };
  const extension = path.extname(filePath).toLowerCase();
  const plainExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.js', '.mjs', '.ts', '.java', '.py', '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.sql']);
  let text = '';
  try {
    if (plainExtensions.has(extension) || contentType.startsWith('text/')) {
      text = await readFile(filePath, 'utf8');
      if (extension === '.html' || extension === '.htm' || contentType.includes('html')) text = htmlToMarkdown(text);
    } else if (extension === '.html' || extension === '.htm') {
      text = htmlToMarkdown(await readFile(filePath, 'utf8'));
    } else if (extension === '.pdf' || contentType === 'application/pdf') {
      const temporary = `${destination}.pdftotext-${process.pid}`;
      await mkdir(path.dirname(destination), { recursive: true });
      await execFileAsync('/opt/homebrew/bin/pdftotext', ['-layout', '-enc', 'UTF-8', filePath, temporary], { maxBuffer: 10 * 1024 * 1024 });
      text = await readFile(temporary, 'utf8');
      await unlink(temporary);
    } else if (['.doc', '.docx', '.rtf', '.odt'].includes(extension)) {
      const result = await execFileAsync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], { maxBuffer: 200 * 1024 * 1024 });
      text = result.stdout;
    } else if (extension === '.pptx' || extension === '.xlsx') {
      text = await officeXmlText(filePath, extension);
    } else if (extension === '.zip' || contentType.includes('zip')) {
      text = await zipText(filePath);
    } else if (['.jpg', '.jpeg', '.png', '.tif', '.tiff'].includes(extension) || contentType.startsWith('image/')) {
      const result = await execFileAsync('/opt/homebrew/bin/tesseract', [filePath, 'stdout', '-l', 'eng'], { maxBuffer: 100 * 1024 * 1024 });
      text = result.stdout;
    } else {
      return { status: 'unsupported', bytes: 0 };
    }
  } catch (error) {
    return { status: 'failed', bytes: 0, error: String(error.message ?? error) };
  }
  const normalized = String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!normalized) return { status: 'empty', bytes: 0 };
  await atomicWrite(destination, `${normalized}\n`);
  return { status: 'extracted', bytes: Buffer.byteLength(normalized), sha256: sha256(normalized) };
}
