// backend/FileProcessor/fileExport.mjs
import { spawn } from 'child_process';
import path from 'node:path';
import fs from 'fs-extra'; // Using fs-extra for ensureDirSync
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto'; // For generating unique filenames

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure a temporary directory for exported files exists
const tempExportDir = path.join(__dirname, '..', 'temp_exports'); // Place it one level up, sibling to 'uploads' and 'FileProcessor'
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

    const pandocOutputArgs = {
        'docx': { ext: '.docx', pandocFormat: 'docx' },
        'pdf': { ext: '.pdf', pandocFormat: 'pdf' }, // Note: PDF often requires a LaTeX engine (like MiKTeX on Windows)
        // Add other formats here if needed, e.g., 'html': { ext: '.html', pandocFormat: 'html' }
    };

    if (!pandocOutputArgs[targetFormat]) {
        throw new Error(`Unsupported target format: ${targetFormat}. Supported formats: ${Object.keys(pandocOutputArgs).join(', ')}`);
    }

    const { ext, pandocFormat } = pandocOutputArgs[targetFormat];
    const uniqueId = crypto.randomBytes(8).toString('hex'); // More robust unique ID
    const outputFileName = `export-${Date.now()}-${uniqueId}${ext}`;
    const outputFilePath = path.join(tempExportDir, outputFileName);

    return new Promise((resolve, reject) => {
        const pandocArgs = [
            '-f', 'markdown',
            '-t', pandocFormat,
            '-o', outputFilePath,
            '-' // Read from stdin
        ];

        // For PDF, you might need to specify a PDF engine if the default doesn't work
        // or if you want to use a specific one like 'xelatex' for better Unicode support.
        // if (targetFormat === 'pdf') {
        //   pandocArgs.push('--pdf-engine=xelatex'); // Example
        // }

        console.log(`[FileExport] Pandoc args: ${pandocArgs.join(' ')}`);
        const pandocProcess = spawn('pandoc', pandocArgs);

        let processError = '';
        let processOutput = '';

        pandocProcess.stdin.write(markdownText);
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
                if (processError.toLowerCase().includes("pdflatex not found") || processError.toLowerCase().includes("latexmk not found")) {
                    errorMessage += " PDF generation often requires a LaTeX distribution (like MiKTeX for Windows, or TeX Live for Linux/macOS) to be installed and in the system PATH.";
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