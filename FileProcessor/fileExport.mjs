// backend/FileProcessor/fileExport.mjs
import { spawn } from 'child_process';
import path from 'node:path';
import fs from 'fs-extra'; // Using fs-extra for ensureDirSync
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto'; // For generating unique filenames

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure a temporary directory for exported files exists
const tempExportDir = process.env.EXPORT_DIR || path.join(__dirname, '..', 'temp_exports');
fs.ensureDirSync(tempExportDir);
console.log(`[FileExport] Temporary export directory ensured at: ${tempExportDir}`);
/**
 * Converts Markdown text to a specified file format using Pandoc.
 * @param {string} markdownText The Markdown content to convert.
 * @param {string} targetFormat The desired output format (e.g., 'docx', 'pdf').
 * @returns {Promise<string>} A promise that resolves with the full path to the generated file.
 * @throws {Error} If Pandoc conversion fails or an unsupported format is requested.
 */
export async function exportMarkdown(markdownText, targetFormat) {
    console.log(`[FileExport] Attempting to convert markdown to ${targetFormat}`);
    const sanitizedMarkdown = markdownText.replace(/\|\|/g, '\n');

    const ext = `.${targetFormat}`;
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const outputFileName = `export-${Date.now()}-${uniqueId}${ext}`;
    const outputFilePath = path.join(tempExportDir, outputFileName);

    const referenceDocPath = path.join(__dirname, 'reference.docx'); // Path to your template

    return new Promise((resolve, reject) => {
        const pandocArgs = [
            '-f', 'markdown',
            '-t', targetFormat,
            '--mathml',
            '-o', outputFilePath,
            '-' // Read from stdin
        ];

        // Add format-specific arguments
        if (targetFormat === 'docx') {
            // Check if reference doc exists before adding the argument
            if (fs.existsSync(referenceDocPath)) {
                 pandocArgs.splice(4, 0, '--reference-doc', referenceDocPath);
                 console.log(`[FileExport] Using reference document: ${referenceDocPath}`);
            } else {
                 console.warn(`[FileExport] Warning: reference.docx not found at ${referenceDocPath}. Using Pandoc defaults.`);
            }
        } else if (targetFormat === 'pdf') {
            // Using xelatex is a good default for unicode characters
            pandocArgs.splice(4, 0, '--pdf-engine=xelatex');
            // This tells pandoc to use a variable for colored code blocks,
            // which requires the xcolor latex package.
            pandocArgs.push('-V', 'colorlinks');
        }

        console.log(`[FileExport] Pandoc args: ${pandocArgs.join(' ')}`);
        const pandocProcess = spawn('pandoc', pandocArgs);

        let processError = '';
        let processOutput = '';

        pandocProcess.stdin.write(sanitizedMarkdown);
        pandocProcess.stdin.end();

        pandocProcess.stdout.on('data', (data) => {
            processOutput += data.toString();
        });

        pandocProcess.stderr.on('data', (data) => {
            processError += data.toString();
        });

        pandocProcess.on('close', (code) => {
            if (processOutput) console.log(`[FileExport] Pandoc stdout: ${processOutput}`);
            if (processError) console.error(`[FileExport] Pandoc stderr: ${processError}`);

            if (code === 0) {
                console.log(`[FileExport] Conversion to ${targetFormat} successful. File saved at: ${outputFilePath}`);
                resolve(outputFilePath);
            } else {
                console.error(`[FileExport] Pandoc process exited with code ${code}.`);
                let errorMessage = `Pandoc conversion failed (exit code ${code}).`;
                if (processError.toLowerCase().includes("pdflatex not found") || processError.toLowerCase().includes("latexmk not found") || processError.toLowerCase().includes("xelatex not found")) {
                    errorMessage += " PDF generation requires a LaTeX distribution (like MiKTeX for Windows, or TeX Live for Linux/macOS) to be installed and in the system PATH.";
                } else if (processError) {
                    errorMessage += ` Details: ${processError.substring(0, 500)}`; // Limit error length
                }
                // Attempt to clean up if a partial/corrupt file was created
                fs.unlink(outputFilePath).catch(err => console.warn(`[FileExport] Failed to delete potentially corrupt output file: ${outputFilePath}`, err));
                reject(new Error(errorMessage));
            }
        });

        pandocProcess.on('error', (err) => {
            console.error('[FileExport] Failed to start Pandoc process:', err);
            let detail = "";
            if (err.code === 'ENOENT') {
                detail = " This usually means the 'pandoc' command was not found. Ensure Pandoc is installed and its directory is in your system's PATH.";
            }
            reject(new Error(`Failed to start Pandoc process. ${detail}`));
        });
    });
}

/**
 * Schedules a file for deletion after a specified timeout.
 * @param {string} filePath Full path to the file.
 * @param {number} delayMilliseconds Delay in milliseconds before deletion.
 */
export function scheduleFileDeletion(filePath, delayMilliseconds = 5 * 60 * 1000) { // Default 5 minutes
    setTimeout(() => {
        fs.unlink(filePath)
            .then(() => console.log(`[FileExport] Successfully deleted temporary file: ${filePath}`))
            .catch(err => console.error(`[FileExport] Error deleting temporary file ${filePath}:`, err));
    }, delayMilliseconds);
}