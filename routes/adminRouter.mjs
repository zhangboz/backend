// backend/routes/adminRouter.mjs
import express from 'express';
import multer from 'multer';
import { rawBucket } from '../FileProcessor/gcs_client.mjs';
import redis from '../services/redisClient.mjs';
import db from '../db.mjs';
const router = express.Router();


// Polling endpoint remains unchanged
router.get('/status', async (req, res) => {
    const { fullGcsPath } = req.query;
    if (!fullGcsPath) {
        return res.status(400).json({ status: 'error', message: 'No fullGcsPath provided.' });
    }

    try {
        const statusKey = `status:${fullGcsPath}`;
        const statusData = await redis.get(statusKey);

        if (!statusData) {
            return res.json({ status: 'pending', message: 'Awaiting upload completion...' });
        }

        const parsedData = JSON.parse(statusData);
        res.json(parsedData);

    } catch (error) {
        console.error(`[Admin Status Poll] Error fetching status for ${fullGcsPath}:`, error);
        res.status(500).json({ status: 'error', message: 'Server error checking status.' });
    }
});


const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- HEAVILY MODIFIED: Upload endpoint with find-or-create logic and self-cleanup on GCS stream error ---
router.post('/upload-to-gcs', upload.single('courseFile'), async (req, res, next) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    const { institution, department, courseCode, professorFirstName, professorLastName, year, semester } = req.body;

    if (!institution || !department || !courseCode) {
        return res.status(400).json({ message: 'Institution, Department, and Course Code are required.' });
    }
    if (!rawBucket) {
        console.error('[Admin Upload] Raw GCS bucket is not initialized.');
        return res.status(500).json({ message: 'Server configuration error: GCS bucket not available.' });
    }

    const originalFileName = req.file.originalname;
    const gcsFolderName = `${institution.trim()}/${department.trim()}/${courseCode.trim()}`;
    const fullGcsPath = `${gcsFolderName}/${originalFileName}`;
    const statusKey = `status:${fullGcsPath}`;

    let documentId = null; // --- NEW: Capture the document ID for potential cleanup

    let client;
    try {
        client = await db.getClient();
        await client.query('BEGIN');

        // 1. Find or create Institution
        let instRes = await client.query('SELECT institution_id FROM institutions WHERE short_name = $1', [institution]);
        let institutionId = instRes.rows[0]?.institution_id;
        if (!institutionId) {
            instRes = await client.query('INSERT INTO institutions (short_name) VALUES ($1) RETURNING institution_id', [institution]);
            institutionId = instRes.rows[0].institution_id;
        }

        // 2. Find or create Department
        let deptRes = await client.query('SELECT department_id FROM departments WHERE name = $1 AND institution_id = $2', [department, institutionId]);
        let departmentId = deptRes.rows[0]?.department_id;
        if (!departmentId) {
            deptRes = await client.query('INSERT INTO departments (name, institution_id) VALUES ($1, $2) RETURNING department_id', [department, institutionId]);
            departmentId = deptRes.rows[0].department_id;
        }
        
        // 3. Find or create Course
        let courseRes = await client.query('SELECT course_id FROM courses WHERE course_code = $1 AND department_id = $2', [courseCode, departmentId]);
        let courseId = courseRes.rows[0]?.course_id;
        if (!courseId) {
            courseRes = await client.query('INSERT INTO courses (course_code, department_id) VALUES ($1, $2) RETURNING course_id', [courseCode, departmentId]);
            courseId = courseRes.rows[0].course_id;
        }

        let offeringId = null;
        if (year && semester) {
            let offeringRes = await client.query('SELECT offering_id FROM course_offerings WHERE course_id = $1 AND year = $2 AND semester = $3', [courseId, year, semester]);
            offeringId = offeringRes.rows[0]?.offering_id;
            if (!offeringId) {
                offeringRes = await client.query('INSERT INTO course_offerings (course_id, year, semester) VALUES ($1, $2, $3) RETURNING offering_id', [courseId, year, semester]);
                offeringId = offeringRes.rows[0].offering_id;
            }

            // Optional: Handle Professor and link to offering
            if (professorLastName) {
                let profRes = await client.query('SELECT professor_id FROM professors WHERE last_name = $1 AND department_id = $2', [professorLastName, departmentId]);
                let professorId = profRes.rows[0]?.professor_id;
                if (!professorId) {
                    profRes = await client.query(
                        'INSERT INTO professors (first_name, last_name, department_id) VALUES ($1, $2, $3) RETURNING professor_id',
                        [professorFirstName || null, professorLastName, departmentId]
                    );
                    professorId = profRes.rows[0].professor_id;
                }
                 // Link professor to offering
                await client.query(
                    'INSERT INTO course_instructors (course_offering_id, professor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [offeringId, professorId]
                );
            }
        }

        // 4. Create preliminary document record
        const docInsertResult = await client.query(
            `INSERT INTO documents (file_url, file_name, mime_type, file_size, course_offering_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [fullGcsPath, originalFileName, req.file.mimetype, req.file.size, offeringId]
        );
        documentId = docInsertResult.rows[0].id;

        await client.query('COMMIT');

    } catch (dbError) {
        if (client) await client.query('ROLLBACK');
        console.error('[Admin Upload] Database transaction error:', dbError);
        return res.status(500).json({ message: `Database setup failed: ${dbError.message}` });
    } finally {
        if (client) client.release();
    }
    
    // 5. Stream file to GCS (only after DB success)
    const blob = rawBucket.file(fullGcsPath);
    const blobStream = blob.createWriteStream({
        resumable: false,
        contentType: req.file.mimetype,
    });

    // --- HEAVILY MODIFIED: Error handler now cleans up the database ---
    blobStream.on('error', async (err) => {
        console.error(`[Admin Upload] GCS stream error for ${fullGcsPath}:`, err);

        // 1. Set Redis status to error
        const errorPayload = JSON.stringify({ status: 'error', message: `GCS Upload Failed: ${err.message}` });
        await redis.set(statusKey, errorPayload, 'EX', 3600);

        // 2. Clean up the placeholder document record from the database
        if (documentId) {
            try {
                console.log(`[Admin Upload Cleanup] Deleting orphaned document record (ID: ${documentId}) due to GCS upload failure.`);
                await db.query('DELETE FROM documents WHERE id = $1', [documentId]);
                console.log(`[Admin Upload Cleanup] Successfully deleted orphaned document record.`);
            } catch (cleanupError) {
                console.error(`[Admin Upload Cleanup] CRITICAL: Failed to delete orphaned document record (ID: ${documentId}). Manual cleanup required.`, cleanupError);
            }
        }
        
        // Let the default error handler deal with the response
        next(err);
    });

    blobStream.on('finish', async () => {
        console.log(`[Admin Upload] Successfully uploaded to: ${fullGcsPath}`);
        
        const processingPayload = JSON.stringify({
            status: 'processing',
            message: '1/4: File uploaded. Awaiting cloud function trigger...' // Message updated for clarity
        });
        await redis.set(statusKey, processingPayload, 'EX', 7200);

        res.status(200).json({
            message: 'File uploaded to GCS successfully. Awaiting processing.',
            fullGcsPath: fullGcsPath 
        });
    });

    blobStream.end(req.file.buffer);
});

// ... rest of the file (db routes) remains unchanged ...
router.get('/db/tables', async (req, res, next) => {
  try {
    const query = `
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename;
    `;
    const { rows } = await db.query(query);
    const tableNames = rows.map(row => row.tablename);
    res.json({ success: true, tables: tableNames });
  } catch (err) {
    err.message = `Failed to fetch table list: ${err.message}`;
    next(err);
  }
});

// --- UPDATED (FINAL): Custom parser now supports LIKE, ILIKE, etc. ---
const parseFilter = (filterString, validColumns) => {
    if (!filterString || filterString.trim() === '') {
        return { where: '', params: [] };
    }
    
    const conditions = filterString.split(/\s+AND\s+/i);
    const sqlParts = [];
    const params = [];
    let paramIndex = 1;

    const parseSingleCondition = (conditionStr) => {
        conditionStr = conditionStr.trim();
        const inRegex = /^\s*(\w+)\s+IN\s+\((.+)\)\s*$/i;
        // --- MODIFIED REGEX to include LIKE, ILIKE, etc. ---
        const opRegex = /^\s*(\w+)\s*(>=|<=|<>|!=|=|>|<|contains|not contains|LIKE|NOT LIKE|ILIKE|NOT ILIKE)\s*(.+)\s*$/i;
        
        let match;

        if ((match = conditionStr.match(inRegex))) {
            const [, column, rawValues] = match;
            if (!validColumns.includes(column.toLowerCase())) throw new Error(`Invalid column: ${column}`);
            
            const values = rawValues.split(',').map(v => {
                const trimmed = v.trim();
                if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
                if (!isNaN(trimmed)) return Number(trimmed);
                throw new Error(`Invalid value in IN clause: ${v}`);
            });

            sqlParts.push(`"${column}" = ANY($${paramIndex++})`);
            params.push(values);

        } else if ((match = conditionStr.match(opRegex))) {
            let [, column, operator, value] = match;
            if (!validColumns.includes(column.toLowerCase())) throw new Error(`Invalid column: ${column}`);

            value = value.trim();
            if (value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1);
            } else if (!isNaN(value) && value !== '') {
                value = Number(value);
            } else {
                throw new Error(`Value must be a number or enclosed in single quotes: ${value}`);
            }

            let sqlOperator = operator.toUpperCase();
            let queryValue = value;

            // --- MODIFIED LOGIC ---
            switch (sqlOperator) {
                case 'CONTAINS':
                    sqlOperator = 'ILIKE';
                    queryValue = `%${value}%`; // We add wildcards for convenience
                    break;
                case 'NOT CONTAINS':
                    sqlOperator = 'NOT ILIKE';
                    queryValue = `%${value}%`; // We add wildcards for convenience
                    break;
                case '!=':
                    sqlOperator = '<>';
                    break;
                // For LIKE/ILIKE, the user provides the wildcards. We do nothing.
                case 'LIKE':
                case 'NOT LIKE':
                case 'ILIKE':
                case 'NOT ILIKE':
                    // Operator is already correct. queryValue is already correct.
                    break;
            }
            // --- END MODIFICATION ---

            sqlParts.push(`"${column}" ${sqlOperator} $${paramIndex++}`);
            params.push(queryValue);
        } else {
            throw new Error(`Invalid condition format: ${conditionStr}`);
        }
    };

    try {
        conditions.forEach(parseSingleCondition);
        return {
            where: `WHERE ${sqlParts.join(' AND ')}`,
            params: params,
        };
    } catch (err) {
        throw new Error(`Invalid filter syntax: ${err.message}`);
    }
};

router.get('/db/tables/:tableName', async (req, res, next) => {
    const { tableName } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const filter = req.query.filter || '';
    const limit = 100;
    const offset = (page - 1) * limit;

    try {
        const tablesResult = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        const allowedTables = tablesResult.rows.map(r => r.tablename);
        if (!allowedTables.includes(tableName)) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }

        const structureQuery = {
            text: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position;`,
            values: [tableName],
        };
        const structureResult = await db.query(structureQuery);
        const validColumns = structureResult.rows.map(col => col.column_name.toLowerCase());

        let whereClause = '';
        let queryParams = [];

        if (filter) {
            try {
                const parsed = parseFilter(filter, validColumns);
                whereClause = parsed.where;
                queryParams = parsed.params;
            } catch (err) {
                 return res.status(400).json({ success: false, message: err.message });
            }
        }

        const countQuery = {
            text: `SELECT COUNT(*) AS total_rows FROM "${tableName}" ${whereClause}`,
            values: queryParams
        };

        const dataQuery = {
            text: `SELECT * FROM "${tableName}" ${whereClause} ORDER BY 1 ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
            values: [...queryParams, limit, offset]
        };

        const [countResult, dataResult] = await Promise.all([
            db.query(countQuery),
            db.query(dataQuery)
        ]);

        const totalRows = parseInt(countResult.rows[0].total_rows, 10);

        res.json({
            success: true,
            tableName: tableName,
            structure: structureResult.rows,
            data: dataResult.rows,
            totalRows: totalRows,
        });

    } catch (err) {
        err.message = `Failed to fetch data for table '${tableName}': ${err.message}`;
        next(err);
    }
});

router.delete('/db/tables/:tableName', async (req, res, next) => {
    const { tableName } = req.params;
    const { primaryKeys } = req.body;

    if (!primaryKeys || !Array.isArray(primaryKeys) || primaryKeys.length === 0) {
        return res.status(400).json({ success: false, message: 'An array of primaryKeys is required.' });
    }

    try {
        // Security Check 1: Ensure the table is in our allowed list
        const tablesResult = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        const allowedTables = tablesResult.rows.map(r => r.tablename);
        if (!allowedTables.includes(tableName)) {
            return res.status(404).json({ success: false, message: 'Table not found or not accessible.' });
        }

        // Security Check 2: Find the actual primary key column for the table from the database schema
        const pkQuery = `
            SELECT a.attname
            FROM   pg_index i
            JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE  i.indrelid = $1::regclass AND i.indisprimary;
        `;
        const pkResult = await db.query(pkQuery, [tableName]);
        if (pkResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: `Table '${tableName}' does not have a primary key, deletion is not allowed.` });
        }
        const primaryKeyColumn = pkResult.rows[0].attname;

        // Perform the deletion
        const deleteQuery = {
            // Use = ANY($1) for efficient deletion of multiple rows
            text: `DELETE FROM "${tableName}" WHERE "${primaryKeyColumn}" = ANY($1)`,
            values: [primaryKeys],
        };

        const deleteResult = await db.query(deleteQuery);

        res.json({
            success: true,
            message: `${deleteResult.rowCount} row(s) deleted successfully from ${tableName}.`,
            deletedCount: deleteResult.rowCount,
        });

    } catch (err) {
        err.message = `Failed to delete rows from table '${tableName}': ${err.message}`;
        next(err);
    }
});

export default router;