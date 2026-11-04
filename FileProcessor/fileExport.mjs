import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getExportDir } from './localExports.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const MAX_MARKDOWN_BYTES = 1024 * 1024;
// OpenAI commonly writes \( ... \) and \[ ... \] math. Pandoc's default
// Markdown reader only enables dollar delimiters, so enable this native parser
// extension rather than rewriting source text (which would damage code blocks).
export const MARKDOWN_READER = 'markdown+tex_math_single_backslash';

function conversionError(code, message, exitCode) {
  return Object.assign(new Error(message), { code,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  });
}

function classifyConversionFailure(stderr, exitCode) {
  if (stderr.includes('EXPORT_EXTERNAL_RESOURCE_BLOCKED')) {
    return conversionError('EXPORT_EXTERNAL_RESOURCE_BLOCKED', 'Embedded images are not supported in document exports.', exitCode);
  }
  if (/xelatex[^\n]*(not found|not recognized)|could not find.*xelatex/i.test(stderr)) {
    return conversionError('EXPORT_PDF_ENGINE_MISSING', 'PDF conversion requires XeLaTeX on PATH.', exitCode);
  }
  if (/font.*cannot be found|font.*not found/i.test(stderr)) {
    return conversionError('EXPORT_FONT_UNAVAILABLE', 'The configured PDF font is unavailable. Check PDF_CJK_FONT.', exitCode);
  }
  if (/Missing \$ inserted|Undefined control sequence|LaTeX Error/i.test(stderr)) {
    return conversionError('EXPORT_LATEX_SYNTAX', 'PDF conversion could not render the document’s mathematical formatting.', exitCode);
  }
  return conversionError('EXPORT_CONVERSION_FAILED', 'Document conversion failed (exit code ' + (exitCode ?? 'unknown') + ').', exitCode);
}

export function validateExportInput(markdownText, targetFormat) {
  if (!['docx', 'pdf'].includes(targetFormat)) {
    throw Object.assign(new Error('Only PDF and Word exports are supported.'), { statusCode: 400 });
  }
  if (typeof markdownText !== 'string' || !markdownText.trim()) {
    throw Object.assign(new Error('Markdown text is required.'), { statusCode: 400 });
  }
  if (Buffer.byteLength(markdownText, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw Object.assign(new Error('Markdown must be no larger than 1 MB.'), { statusCode: 413 });
  }
}

function converterEnvironment(workDir) {
  // Do not pass API keys, database credentials, or caller-controlled TeX search
  // paths into Pandoc and its children. System executables/fonts remain usable.
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (['path', 'systemroot', 'windir', 'comspec', 'pathext'].includes(key.toLowerCase())) environment[key] = value;
  }
  return { ...environment, LANG: 'C.UTF-8', HOME: workDir, USERPROFILE: workDir,
    APPDATA: workDir, LOCALAPPDATA: workDir, TEMP: workDir, TMP: workDir, TMPDIR: workDir,
    TEXMFOUTPUT: workDir, TEXMF_OUTPUT_DIRECTORY: workDir,
    shell_escape: 'f', openout_any: 'p', openin_any: 'p' };
}

// Pandoc's sandbox excludes the PDF engine. openin_any is only defense in
// depth for older TeX: TeX Live 2026 ignores it and older versions have bypasses.
// These settings do NOT provide an OS filesystem sandbox for untrusted TeX;
// deployment must remain a trusted private preview until that boundary exists.
/** Convert in a private task directory with no application secrets in children. */
export async function exportMarkdown(markdownText, targetFormat, options = {}) {
  validateExportInput(markdownText, targetFormat);
  const outputDir = options.outputDir || getExportDir();
  await fs.mkdir(outputDir, { recursive: true });
  const fileName = 'export-' + Date.now() + '-' + randomBytes(8).toString('hex') + '.' + targetFormat;
  const outputPath = path.join(outputDir, fileName);
  const workRoot = path.resolve(os.tmpdir());
  const workDir = await fs.mkdtemp(path.join(workRoot, 'synapse-export-'));
  const taskOutput = path.join(workDir, 'document.' + targetFormat);
  const args = ['--sandbox', '--fail-if-warnings', '-f', MARKDOWN_READER, '-t', targetFormat, '-o', taskOutput, '-'];
  args.push('--lua-filter', path.join(moduleDir, 'exportSafety.lua'));
  const referenceDoc = path.join(moduleDir, 'reference.docx');
  if (targetFormat === 'docx' && existsSync(referenceDoc)) args.push('--reference-doc', referenceDoc);
  if (targetFormat === 'pdf') {
    args.push('--pdf-engine=xelatex', '--pdf-engine-opt=-no-shell-escape', '-V', 'colorlinks=true');
    const cjkFont = options.cjkFont || process.env.PDF_CJK_FONT ||
      (process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC');
    args.push('-V', 'CJKmainfont=' + cjkFont);
  }
  const configuredTimeout = Number(options.timeoutMs ?? process.env.EXPORT_TIMEOUT_MS ?? 90000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 90000;
  const spawnProcess = options.spawnProcess || spawn;

  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(options.pandocPath || process.env.PANDOC_PATH || 'pandoc', args, {
        windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'],
        cwd: workDir, env: converterEnvironment(workDir), detached: process.platform !== 'win32',
      });
      let settled = false;
      let timedOut = false;
      let stderr = '';
      let killDeadline;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killDeadline);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        const timeoutError = conversionError('EXPORT_TIMEOUT', 'Document conversion timed out. Please try a shorter document.');
        // Wait for the process to exit before removing its partial output file.
        killDeadline = setTimeout(() => finish(timeoutError), 5000);
        // Pandoc launches XeLaTeX; Windows requires terminating the process tree.
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true, shell: false, stdio: 'ignore',
          });
          killer.on('error', () => child.kill('SIGKILL'));
        } else if (child.pid) {
          // Pandoc launches XeLaTeX. Terminate their process group together.
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.stderr?.on('data', (chunk) => {
        // Never expose raw diagnostics: they can contain private document text.
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      child.on('error', (error) => {
        finish(conversionError(error.code === 'ENOENT' ? 'EXPORT_CONVERTER_MISSING' : 'EXPORT_SPAWN_FAILED',
          error.code === 'ENOENT' ? 'Pandoc is not installed or is not on PATH.' : 'Could not start the document converter.'));
      });
      child.on('close', (code) => {
        if (timedOut) return finish(conversionError('EXPORT_TIMEOUT', 'Document conversion timed out. Please try a shorter document.'));
        if (code === 0) return finish();
        finish(classifyConversionFailure(stderr, code));
      });
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') finish(conversionError('EXPORT_INPUT_FAILED', 'Could not send the document to the converter.'));
      });
      // Preserve Markdown exactly, including mathematical norms and logical OR (||).
      child.stdin.end(markdownText, 'utf8');
    });
    const output = await fs.lstat(taskOutput);
    if (!output.isFile() || output.isSymbolicLink()) throw conversionError('EXPORT_CONVERSION_FAILED', 'Document conversion did not produce a regular file.');
    // /tmp may be a different filesystem from the shared export volume.
    await fs.copyFile(taskOutput, outputPath, constants.COPYFILE_EXCL);
    return outputPath;
  } finally {
    const resolved = path.resolve(workDir);
    if (path.dirname(resolved) !== workRoot || !path.basename(resolved).startsWith('synapse-export-')) {
      throw new Error('Invalid export temporary directory.');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
