import express from 'express';
import db from '../db.mjs';
const router = express.Router();
// Textbook storage is intentionally deferred; do not import GCS or its workers.
router.all(['/status', '/upload-to-gcs'], (_req, res) => {
  res.status(410).json({ message: 'Textbook uploads and cloud processing are paused.' });
});

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