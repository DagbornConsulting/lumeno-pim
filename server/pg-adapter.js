/**
 * PostgreSQL adapter that mimics the Supabase client API.
 *
 * Allows existing code like:
 *   supabase.from('products').select('*').eq('store_id', id)
 * to work with a local PostgreSQL database via pg.Pool.
 *
 * Supports: select, insert, update, delete, upsert
 * Filters: eq, neq, in, lt, gt, gte, lte, not, or, overlaps, ilike
 * Modifiers: single, order, limit, range, select (after insert/update)
 * Relations: select('*, variants(*)') does separate queries and nests results
 */

/**
 * Parse a Supabase-style select string to extract columns and relations.
 * Examples:
 *   '*' => { columns: ['*'], relations: [] }
 *   '*, variants(*)' => { columns: ['*'], relations: [{ name: 'variants', columns: ['*'] }] }
 *   '*, variants(*), images(*)' => ...
 *   'id, title' => { columns: ['id', 'title'], relations: [] }
 *   '*, store_products(*, stores(id, name, domain))' => nested relations
 */
function parseSelect(selectStr) {
  const columns = [];
  const relations = [];

  if (!selectStr || selectStr.trim() === '*') {
    return { columns: ['*'], relations: [] };
  }

  // We need to split on commas that are NOT inside parentheses
  let depth = 0;
  let current = '';
  for (let i = 0; i < selectStr.length; i++) {
    const ch = selectStr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      const token = current.trim();
      if (token) columns.push(token);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) columns.push(current.trim());

  // Now separate plain columns from relations
  const plainColumns = [];
  for (const col of columns) {
    const match = col.match(/^(\w+)\s*\((.+)\)$/s);
    if (match) {
      const relName = match[1];
      const relSelect = match[2].trim();
      // Parse nested relations recursively
      const nested = parseSelect(relSelect);
      relations.push({ name: relName, columns: nested.columns, relations: nested.relations });
    } else {
      plainColumns.push(col);
    }
  }

  return { columns: plainColumns, relations };
}

/**
 * Infer the foreign key for a relation.
 * Convention: child table has parent_table_id column (singular form).
 * e.g., variants -> product_id for parent table products
 *        images -> product_id for parent table products
 *        store_products -> product_id for parent table products
 *        stores -> id for parent table store_products (via store_id)
 */
function inferForeignKey(parentTable, childTable) {
  // Special cases for known relationships
  const knownRelations = {
    'products.variants': { fk: 'product_id', pk: 'id' },
    'products.images': { fk: 'product_id', pk: 'id' },
    'products.store_products': { fk: 'product_id', pk: 'id' },
    'store_products.stores': { fk: 'id', pk: 'store_id' }, // reverse: stores.id = store_products.store_id
    'store_products.products': { fk: 'id', pk: 'product_id' }, // reverse: products.id = store_products.product_id
    'user_stores.stores': { fk: 'id', pk: 'store_id' }, // reverse: stores.id = user_stores.store_id
    'sync_queue.stores': { fk: 'id', pk: 'store_id' },
    'sync_queue.products': { fk: 'id', pk: 'product_id' },
    'price_campaign_products.products': { fk: 'id', pk: 'product_id' },
  };

  const key = `${parentTable}.${childTable}`;
  if (knownRelations[key]) {
    return knownRelations[key];
  }

  // Default: child has parent_singular_id
  const singularParent = parentTable.replace(/s$/, '');
  return { fk: `${singularParent}_id`, pk: 'id' };
}

class QueryBuilder {
  constructor(pool, tableName) {
    this._pool = pool;
    this._table = tableName;
    this._operation = null; // 'select', 'insert', 'update', 'delete', 'upsert'
    this._selectStr = '*';
    this._selectColumns = ['*'];
    this._relations = [];
    this._insertData = null;
    this._updateData = null;
    this._upsertData = null;
    this._upsertConflict = null;
    this._filters = [];
    this._orFilters = [];
    this._orderClauses = [];
    this._limitVal = null;
    this._offsetVal = null;
    this._rangeFrom = null;
    this._rangeTo = null;
    this._isSingle = false;
    this._returnSelect = false; // .select() after insert/update
    this._countMode = null; // 'exact' etc.
  }

  select(columns = '*', options = {}) {
    if (this._operation === 'insert' || this._operation === 'update' || this._operation === 'upsert') {
      // .select() after insert/update means RETURNING
      this._returnSelect = true;
      if (columns && columns !== '*') {
        const parsed = parseSelect(columns);
        this._selectColumns = parsed.columns;
        this._relations = parsed.relations;
      }
      return this;
    }
    this._operation = 'select';
    this._selectStr = columns;
    if (options.count) {
      this._countMode = options.count;
    }
    const parsed = parseSelect(columns);
    this._selectColumns = parsed.columns;
    this._relations = parsed.relations;
    return this;
  }

  insert(data) {
    this._operation = 'insert';
    this._insertData = data;
    return this;
  }

  update(data) {
    this._operation = 'update';
    this._updateData = data;
    return this;
  }

  delete() {
    this._operation = 'delete';
    return this;
  }

  upsert(data, options = {}) {
    this._operation = 'upsert';
    this._upsertData = data;
    this._upsertConflict = options.onConflict || null;
    return this;
  }

  // --- Filters ---

  eq(column, value) {
    this._filters.push({ type: 'eq', column, value });
    return this;
  }

  neq(column, value) {
    this._filters.push({ type: 'neq', column, value });
    return this;
  }

  lt(column, value) {
    this._filters.push({ type: 'lt', column, value });
    return this;
  }

  gt(column, value) {
    this._filters.push({ type: 'gt', column, value });
    return this;
  }

  gte(column, value) {
    this._filters.push({ type: 'gte', column, value });
    return this;
  }

  lte(column, value) {
    this._filters.push({ type: 'lte', column, value });
    return this;
  }

  in(column, values) {
    this._filters.push({ type: 'in', column, value: values });
    return this;
  }

  not(column, operator, value) {
    this._filters.push({ type: 'not', column, operator, value });
    return this;
  }

  or(filterString) {
    this._orFilters.push(filterString);
    return this;
  }

  overlaps(column, values) {
    this._filters.push({ type: 'overlaps', column, value: values });
    return this;
  }

  ilike(column, pattern) {
    this._filters.push({ type: 'ilike', column, value: pattern });
    return this;
  }

  // --- Modifiers ---

  single() {
    this._isSingle = true;
    return this;
  }

  order(column, options = {}) {
    const direction = options.ascending === false ? 'DESC' : 'ASC';
    this._orderClauses.push(`"${column}" ${direction}`);
    return this;
  }

  limit(count) {
    this._limitVal = count;
    return this;
  }

  range(from, to) {
    this._rangeFrom = from;
    this._rangeTo = to;
    return this;
  }

  // --- Build WHERE clause ---

  _buildWhere(params) {
    const conditions = [];

    for (const f of this._filters) {
      const col = `"${f.column}"`;
      switch (f.type) {
        case 'eq':
          params.push(f.value);
          conditions.push(`${col} = $${params.length}`);
          break;
        case 'neq':
          params.push(f.value);
          conditions.push(`${col} != $${params.length}`);
          break;
        case 'lt':
          params.push(f.value);
          conditions.push(`${col} < $${params.length}`);
          break;
        case 'gt':
          params.push(f.value);
          conditions.push(`${col} > $${params.length}`);
          break;
        case 'gte':
          params.push(f.value);
          conditions.push(`${col} >= $${params.length}`);
          break;
        case 'lte':
          params.push(f.value);
          conditions.push(`${col} <= $${params.length}`);
          break;
        case 'in':
          if (f.value && f.value.length > 0) {
            const placeholders = f.value.map((v) => {
              params.push(v);
              return `$${params.length}`;
            });
            conditions.push(`${col} IN (${placeholders.join(', ')})`);
          } else {
            conditions.push('FALSE'); // empty IN = no match
          }
          break;
        case 'not':
          if (f.operator === 'is' && f.value === null) {
            conditions.push(`${col} IS NOT NULL`);
          } else {
            params.push(f.value);
            conditions.push(`NOT (${col} = $${params.length})`);
          }
          break;
        case 'overlaps':
          if (f.value && f.value.length > 0) {
            params.push(f.value);
            conditions.push(`${col} && $${params.length}`);
          }
          break;
        case 'ilike':
          params.push(f.value);
          conditions.push(`${col} ILIKE $${params.length}`);
          break;
      }
    }

    // Handle .or() filters - Supabase format: 'col.op.value,col.op.value'
    for (const orStr of this._orFilters) {
      const orParts = this._parseOrFilter(orStr, params);
      if (orParts.length > 0) {
        conditions.push(`(${orParts.join(' OR ')})`);
      }
    }

    if (conditions.length === 0) return '';
    return ' WHERE ' + conditions.join(' AND ');
  }

  /**
   * Parse Supabase .or() filter string.
   * Format: 'col.op.value,col.op.value'
   * Supports: eq, neq, lt, gt, gte, lte, ilike, is
   * Also supports: store_id.is.null, store_id.eq.123
   */
  _parseOrFilter(orStr, params) {
    const parts = [];
    // Split on commas not inside values (simple split works for our use cases)
    const segments = orStr.split(',');

    for (const segment of segments) {
      const trimmed = segment.trim();
      // Match: column.operator.value
      const match = trimmed.match(/^(\w+)\.(eq|neq|lt|gt|gte|lte|ilike|is)\.(.+)$/);
      if (!match) continue;

      const [, column, op, value] = match;
      const col = `"${column}"`;

      switch (op) {
        case 'eq':
          params.push(value);
          parts.push(`${col} = $${params.length}`);
          break;
        case 'neq':
          params.push(value);
          parts.push(`${col} != $${params.length}`);
          break;
        case 'lt':
          params.push(value);
          parts.push(`${col} < $${params.length}`);
          break;
        case 'gt':
          params.push(value);
          parts.push(`${col} > $${params.length}`);
          break;
        case 'gte':
          params.push(value);
          parts.push(`${col} >= $${params.length}`);
          break;
        case 'lte':
          params.push(value);
          parts.push(`${col} <= $${params.length}`);
          break;
        case 'ilike':
          params.push(value);
          parts.push(`${col} ILIKE $${params.length}`);
          break;
        case 'is':
          if (value === 'null') {
            parts.push(`${col} IS NULL`);
          } else if (value === 'true') {
            parts.push(`${col} IS TRUE`);
          } else if (value === 'false') {
            parts.push(`${col} IS FALSE`);
          }
          break;
      }
    }

    return parts;
  }

  // --- Fetch relations (separate queries, nested) ---

  async _fetchRelations(rows, relations, parentTable) {
    if (!relations || relations.length === 0 || rows.length === 0) return;

    for (const rel of relations) {
      const { fk, pk } = inferForeignKey(parentTable, rel.name);

      // Determine the column select
      const relColumns = rel.columns.includes('*') ? '*' : rel.columns.map(c => `"${c}"`).join(', ');

      // Two modes:
      // 1. Normal: child.fk references parent.pk (e.g., variants.product_id = products.id)
      // 2. Reverse: parent.fk references child.pk (e.g., store_products.store_id = stores.id)

      const isReverse = fk === 'id'; // The child's PK is 'id', we join via parent's column

      if (isReverse) {
        // parent has a column (pk) that references child.id
        const parentIds = [...new Set(rows.map(r => r[pk]).filter(v => v != null))];
        if (parentIds.length === 0) {
          for (const row of rows) row[rel.name] = null;
          continue;
        }

        const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `SELECT ${relColumns} FROM "${rel.name}" WHERE "id" IN (${placeholders})`;
        const { rows: relRows } = await this._pool.query(sql, parentIds);

        // Build lookup by id
        const lookup = {};
        for (const rr of relRows) {
          lookup[rr.id] = rr;
        }

        // Attach - single object since it's a belongsTo
        for (const row of rows) {
          const relRow = lookup[row[pk]] || null;
          row[rel.name] = relRow;

          // Recursively fetch nested relations
          if (relRow && rel.relations.length > 0) {
            await this._fetchRelations([relRow], rel.relations, rel.name);
          }
        }
      } else {
        // Normal hasMany: child.fk = parent.id
        const parentIds = [...new Set(rows.map(r => r.id).filter(v => v != null))];
        if (parentIds.length === 0) {
          for (const row of rows) row[rel.name] = [];
          continue;
        }

        const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `SELECT ${relColumns} FROM "${rel.name}" WHERE "${fk}" IN (${placeholders})`;
        const { rows: relRows } = await this._pool.query(sql, parentIds);

        // Build lookup
        const lookup = {};
        for (const rr of relRows) {
          const key = rr[fk];
          if (!lookup[key]) lookup[key] = [];
          lookup[key].push(rr);
        }

        // Attach
        for (const row of rows) {
          row[rel.name] = lookup[row.id] || [];
        }

        // Recursively fetch nested relations on all related rows
        if (rel.relations.length > 0) {
          const allRelRows = relRows;
          if (allRelRows.length > 0) {
            await this._fetchRelations(allRelRows, rel.relations, rel.name);
          }
        }
      }
    }
  }

  // --- Execute ---

  async then(resolve, reject) {
    try {
      const result = await this._execute();
      resolve(result);
    } catch (err) {
      if (reject) reject(err);
      else resolve({ data: null, error: { message: err.message, code: err.code } });
    }
  }

  async _execute() {
    try {
      switch (this._operation) {
        case 'select':
          return await this._executeSelect();
        case 'insert':
          return await this._executeInsert();
        case 'update':
          return await this._executeUpdate();
        case 'delete':
          return await this._executeDelete();
        case 'upsert':
          return await this._executeUpsert();
        default:
          return { data: null, error: { message: `Unknown operation: ${this._operation}` } };
      }
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }

  async _executeSelect() {
    const params = [];

    // Build column list (exclude relation names)
    let columnSql;
    if (this._selectColumns.includes('*')) {
      columnSql = '*';
    } else {
      columnSql = this._selectColumns.map(c => `"${c}"`).join(', ');
    }

    let sql = `SELECT ${columnSql} FROM "${this._table}"`;
    sql += this._buildWhere(params);

    // ORDER BY
    if (this._orderClauses.length > 0) {
      sql += ` ORDER BY ${this._orderClauses.join(', ')}`;
    }

    // LIMIT / OFFSET from .range()
    if (this._rangeFrom !== null && this._rangeTo !== null) {
      const limit = this._rangeTo - this._rangeFrom + 1;
      sql += ` LIMIT ${limit} OFFSET ${this._rangeFrom}`;
    } else if (this._limitVal !== null) {
      sql += ` LIMIT ${this._limitVal}`;
      if (this._offsetVal !== null) {
        sql += ` OFFSET ${this._offsetVal}`;
      }
    }

    const { rows } = await this._pool.query(sql, params);

    // Fetch relations
    if (this._relations.length > 0) {
      await this._fetchRelations(rows, this._relations, this._table);
    }

    // Count query if requested
    let count = null;
    if (this._countMode === 'exact') {
      const countParams = [];
      let countSql = `SELECT COUNT(*) as count FROM "${this._table}"`;
      countSql += this._buildWhere(countParams);
      const countResult = await this._pool.query(countSql, countParams);
      count = parseInt(countResult.rows[0].count, 10);
    }

    if (this._isSingle) {
      if (rows.length === 0) {
        return { data: null, error: { message: 'Row not found', code: 'PGRST116' }, count };
      }
      return { data: rows[0], error: null, count };
    }

    return { data: rows, error: null, count };
  }

  async _executeInsert() {
    const isArray = Array.isArray(this._insertData);
    const dataArr = isArray ? this._insertData : [this._insertData];

    if (dataArr.length === 0) {
      return { data: isArray ? [] : null, error: null };
    }

    // Get column names from the first item
    const columns = Object.keys(dataArr[0]);
    const returning = this._returnSelect ? 'RETURNING *' : '';

    // Build multi-row insert
    const params = [];
    const valueRows = [];

    for (const item of dataArr) {
      const placeholders = columns.map(col => {
        const val = item[col];
        // Handle JSON/array values
        if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
          params.push(JSON.stringify(val));
        } else if (Array.isArray(val)) {
          params.push(JSON.stringify(val));
        } else {
          params.push(val);
        }
        return `$${params.length}`;
      });
      valueRows.push(`(${placeholders.join(', ')})`);
    }

    const colList = columns.map(c => `"${c}"`).join(', ');
    const sql = `INSERT INTO "${this._table}" (${colList}) VALUES ${valueRows.join(', ')} ${returning}`;

    const { rows } = await this._pool.query(sql, params);

    // Fetch relations if needed
    if (this._returnSelect && this._relations.length > 0 && rows.length > 0) {
      await this._fetchRelations(rows, this._relations, this._table);
    }

    if (this._isSingle) {
      return { data: rows[0] || null, error: null };
    }

    return { data: this._returnSelect ? (isArray ? rows : rows) : null, error: null };
  }

  async _executeUpdate() {
    const columns = Object.keys(this._updateData);
    if (columns.length === 0) {
      return { data: null, error: null };
    }

    const params = [];
    const setClauses = columns.map(col => {
      const val = this._updateData[col];
      if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
        params.push(JSON.stringify(val));
      } else if (Array.isArray(val)) {
        params.push(JSON.stringify(val));
      } else {
        params.push(val);
      }
      return `"${col}" = $${params.length}`;
    });

    const returning = this._returnSelect ? 'RETURNING *' : '';
    let sql = `UPDATE "${this._table}" SET ${setClauses.join(', ')}`;
    sql += this._buildWhere(params);
    sql += ` ${returning}`;

    const { rows } = await this._pool.query(sql, params);

    // Fetch relations if needed
    if (this._returnSelect && this._relations.length > 0 && rows.length > 0) {
      await this._fetchRelations(rows, this._relations, this._table);
    }

    if (this._isSingle) {
      return { data: rows[0] || null, error: null };
    }

    return { data: this._returnSelect ? rows : null, error: null };
  }

  async _executeDelete() {
    const params = [];
    let sql = `DELETE FROM "${this._table}"`;
    sql += this._buildWhere(params);

    await this._pool.query(sql, params);
    return { data: null, error: null };
  }

  async _executeUpsert() {
    const isArray = Array.isArray(this._upsertData);
    const dataArr = isArray ? this._upsertData : [this._upsertData];

    if (dataArr.length === 0) {
      return { data: isArray ? [] : null, error: null };
    }

    const columns = Object.keys(dataArr[0]);
    const returning = this._returnSelect ? 'RETURNING *' : '';

    const params = [];
    const valueRows = [];

    for (const item of dataArr) {
      const placeholders = columns.map(col => {
        const val = item[col];
        if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
          params.push(JSON.stringify(val));
        } else if (Array.isArray(val)) {
          params.push(JSON.stringify(val));
        } else {
          params.push(val);
        }
        return `$${params.length}`;
      });
      valueRows.push(`(${placeholders.join(', ')})`);
    }

    const colList = columns.map(c => `"${c}"`).join(', ');

    // Build ON CONFLICT clause
    let conflictClause = '';
    if (this._upsertConflict) {
      const conflictCols = this._upsertConflict.split(',').map(c => `"${c.trim()}"`).join(', ');
      const updateCols = columns
        .filter(c => !this._upsertConflict.split(',').map(x => x.trim()).includes(c))
        .map(c => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      conflictClause = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`;
    } else {
      const updateCols = columns.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
      conflictClause = `ON CONFLICT DO UPDATE SET ${updateCols}`;
    }

    const sql = `INSERT INTO "${this._table}" (${colList}) VALUES ${valueRows.join(', ')} ${conflictClause} ${returning}`;

    const { rows } = await this._pool.query(sql, params);

    if (this._isSingle) {
      return { data: rows[0] || null, error: null };
    }

    return { data: this._returnSelect ? rows : null, error: null };
  }
}

/**
 * Create a Supabase-compatible adapter backed by a pg.Pool.
 *
 * Usage:
 *   import pg from 'pg';
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *   const supabase = createPgAdapter(pool);
 *
 *   // Now use it exactly like Supabase:
 *   const { data, error } = await supabase.from('products').select('*').eq('store_id', id);
 */
export function createPgAdapter(pool) {
  return {
    from(tableName) {
      return new QueryBuilder(pool, tableName);
    }
  };
}
