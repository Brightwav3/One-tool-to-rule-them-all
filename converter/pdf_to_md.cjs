'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { processPdf } = require('@firecrawl/pdf-inspector');

function inspectPdf(inputPath) {
  const result = processPdf(fs.readFileSync(inputPath));
  if (!result.markdown || !result.markdown.trim()) {
    const pages = result.pagesNeedingOcr?.length
      ? ` Pages needing OCR: ${result.pagesNeedingOcr.join(', ')}.`
      : '';
    throw new Error(`PDF Inspector found no reliable text (${result.pdfType}).${pages}`);
  }
  return result;
}

function writeAtomic(outputPath, markdown, commit = true) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const partialPath = `${outputPath}.partial`;
  try {
    fs.rmSync(partialPath, { force: true });
    fs.writeFileSync(partialPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
    if (commit) fs.renameSync(partialPath, outputPath);
  } catch (error) {
    try { fs.rmSync(partialPath, { force: true }); } catch (_) { /* best effort cleanup */ }
    throw error;
  }
}

function processOne(inputPath, outputPath, commit = true) {
  const result = inspectPdf(inputPath);
  writeAtomic(outputPath, result.markdown, commit);
  return {
    ok: true,
    pdfType: result.pdfType,
    pageCount: result.pageCount,
    pagesNeedingOcr: result.pagesNeedingOcr,
    processingTimeMs: result.processingTimeMs,
  };
}

async function runWorker() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      const result = processOne(request.inputPath, request.outputPath, false);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
    }
  }
}

async function main() {
  if (process.argv[2] === '--worker') {
    await runWorker();
    return;
  }
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    throw new Error('Usage: pdf_to_md.cjs <input.pdf> <output.md>');
  }
  const result = processOne(inputPath, outputPath);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
