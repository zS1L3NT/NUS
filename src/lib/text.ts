import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TextExtraction } from "../types.ts";
import { atomicWrite, sha256 } from "./serialization.ts";

const execFileAsync = promisify(execFile);

const entityMap: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
};

const plainTextExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".markdown",
  ".md",
  ".mjs",
  ".py",
  ".sql",
  ".ts",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const zipTextExtensions = new Set([
  ".csv",
  ".java",
  ".js",
  ".json",
  ".md",
  ".py",
  ".sql",
  ".ts",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function decodeHtml(value: unknown = ""): string {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entityMap[entity.toLowerCase()] ?? match;
  });
}

export function htmlToMarkdown(html: unknown = ""): string {
  let text = String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const cleanLabel = decodeHtml(label.replace(/<[^>]+>/g, "")).trim() || href;
      return `[${cleanLabel}](${href})`;
    })
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level, body) => `\n${"#".repeat(Number(level))} ${body}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeHtml(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? `${text}\n` : "";
}

function xmlText(xml: string, tagPattern: RegExp): string {
  const values = [];
  for (const match of xml.matchAll(tagPattern)) {
    if (match[1]) values.push(decodeHtml(match[1].replace(/<[^>]+>/g, "")));
  }
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function officeXmlText(filePath: string, extension: string): Promise<string> {
  const { stdout: listing } = await execFileAsync("/usr/bin/unzip", ["-Z1", filePath], { maxBuffer: 50 * 1024 * 1024 });
  const entries = listing.split("\n").filter(Boolean).sort(naturalCompare);
  const selected =
    extension === ".pptx"
      ? entries.filter((entry) => /^ppt\/(slides|notesSlides)\/.*\.xml$/.test(entry))
      : entries.filter((entry) => /^xl\/(sharedStrings\.xml|worksheets\/.*\.xml)$/.test(entry));
  if (!selected.length) return "";
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", filePath, ...selected], {
    maxBuffer: 200 * 1024 * 1024,
  });
  if (extension === ".pptx") return xmlText(stdout, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g);
  return xmlText(stdout, /<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/g);
}

async function zipText(filePath: string): Promise<string> {
  const { stdout: listing } = await execFileAsync("/usr/bin/unzip", ["-Z1", filePath], { maxBuffer: 50 * 1024 * 1024 });
  const entries = listing
    .split("\n")
    .filter((entry) => entry && !entry.endsWith("/") && !entry.startsWith("/") && !entry.split("/").includes(".."))
    .sort(naturalCompare);
  const sections = [`Archive contents:\n${entries.join("\n")}`];
  for (const entry of entries) {
    const extension = path.extname(entry).toLowerCase();
    if (zipTextExtensions.has(extension)) {
      const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", filePath, entry], {
        maxBuffer: 100 * 1024 * 1024,
      });
      sections.push(`## ${entry}\n\n${stdout.trim()}`);
    } else if (extension === ".xlsx" || extension === ".pptx") {
      const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", filePath, entry], {
        encoding: "buffer",
        maxBuffer: 200 * 1024 * 1024,
      });
      const temporary = path.join(
        os.tmpdir(),
        `canvas-cli-extract-${process.pid}-${sha256(entry).slice(0, 12)}${extension}`,
      );
      await writeFile(temporary, stdout);
      try {
        const extracted = await officeXmlText(temporary, extension);
        if (extracted) sections.push(`## ${entry}\n\n${extracted}`);
      } finally {
        await unlink(temporary);
      }
    }
  }
  return sections.join("\n\n");
}

export async function extractText(
  filePath: string,
  destination: string,
  { contentType = "", maxSourceBytes = 100 * 1024 * 1024 }: { contentType?: string; maxSourceBytes?: number } = {},
): Promise<TextExtraction> {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxSourceBytes) return { status: "skipped-too-large", bytes: 0 };
  const extension = path.extname(filePath).toLowerCase();
  let text = "";
  try {
    if (plainTextExtensions.has(extension) || contentType.startsWith("text/")) {
      text = await readFile(filePath, "utf8");
      if (extension === ".html" || extension === ".htm" || contentType.includes("html")) text = htmlToMarkdown(text);
    } else if (extension === ".html" || extension === ".htm") {
      text = htmlToMarkdown(await readFile(filePath, "utf8"));
    } else if (extension === ".pdf" || contentType === "application/pdf") {
      const temporary = `${destination}.pdftotext-${process.pid}`;
      await mkdir(path.dirname(destination), { recursive: true });
      await execFileAsync("/opt/homebrew/bin/pdftotext", ["-layout", "-enc", "UTF-8", filePath, temporary], {
        maxBuffer: 10 * 1024 * 1024,
      });
      text = await readFile(temporary, "utf8");
      await unlink(temporary);
    } else if ([".doc", ".docx", ".rtf", ".odt"].includes(extension)) {
      const result = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
        maxBuffer: 200 * 1024 * 1024,
      });
      text = result.stdout;
    } else if (extension === ".pptx" || extension === ".xlsx") {
      text = await officeXmlText(filePath, extension);
    } else if (extension === ".zip" || contentType.includes("zip")) {
      text = await zipText(filePath);
    } else if ([".jpg", ".jpeg", ".png", ".tif", ".tiff"].includes(extension) || contentType.startsWith("image/")) {
      const result = await execFileAsync("/opt/homebrew/bin/tesseract", [filePath, "stdout", "-l", "eng"], {
        maxBuffer: 100 * 1024 * 1024,
      });
      text = result.stdout;
    } else {
      return { status: "unsupported", bytes: 0 };
    }
  } catch (error) {
    return { status: "failed", bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const normalized = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!normalized) return { status: "empty", bytes: 0 };
  await atomicWrite(destination, `${normalized}\n`);
  return { status: "extracted", bytes: Buffer.byteLength(normalized), sha256: sha256(normalized) };
}
