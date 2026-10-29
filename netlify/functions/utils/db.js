// Database connection utility for Neon PostgreSQL
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Connection pool - reused across function invocations
let pool;

// Request-scoped tenant context. Netlify Functions (Lambda) handle one request
// per instance at a time, and AsyncLocalStorage keeps the value correct across
// await boundaries, so this cannot leak between concurrent requests.
const tenantContext = new AsyncLocalStorage();

// Run a block of code with an active tenant scope. While active, every query()
// call automatically runs inside a transaction with the RLS session variable
// set, so Row-Level Security policies isolate this company's data — even if a
// query forgot its WHERE company_id filter.
function runWithTenant(companyId, fn) {
    return tenantContext.run({ companyId: companyId ? String(companyId) : null }, fn);
}

// Alternative to runWithTenant for handlers that determine companyId partway
// through their body: sets the tenant for the remainder of the current async
// execution. Safe here because each Netlify Function instance handles one
// request at a time and this is called at the top of the handler.
function setTenant(companyId) {
    tenantContext.enterWith({ companyId: companyId ? String(companyId) : null });
}

// Current tenant id, or null if we're outside a tenant scope (e.g. login,
// super-admin, cross-tenant jobs).
function currentTenant() {
    const store = tenantContext.getStore();
    return store ? store.companyId : null;
}

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });
    }
    return pool;
}

// Execute a query.
// If a tenant scope is active (see runWithTenant), the statement runs inside a
// transaction with app.current_company_id set so RLS applies. Otherwise it runs
// as a plain pooled query exactly as before (unchanged behavior for
// super-admin / auth / cross-tenant code paths).
async function query(text, params) {
    const companyId = currentTenant();
    const client = await getPool().connect();
    try {
        if (companyId) {
            try {
                await client.query('BEGIN');
                await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
                const result = await client.query(text, params);
                await client.query('COMMIT');
                return result;
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (e) { /* ignore rollback failure */ }
                throw err;
            }
        } else {
            const result = await client.query(text, params);
            return result;
        }
    } finally {
        client.release();
    }
}

// Execute a transaction.
// If a tenant scope is active, the RLS session variable is set for the whole
// transaction so all statements in the callback are company-isolated.
async function transaction(callback) {
    const companyId = currentTenant();
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        if (companyId) {
            await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
        }
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Tenant-scoped query for Row-Level Security.
// Wraps the statement(s) in a transaction and sets a transaction-local
// variable that RLS policies read via current_setting('app.current_company_id').
// Because it's SET LOCAL inside BEGIN/COMMIT, the value cannot leak to the
// next request that reuses this pooled connection.
//
// Usage:
//   await tenantQuery(companyId, 'SELECT * FROM customers'); // RLS adds the company filter
// Or run several statements under one tenant context:
//   await tenantQuery(companyId, async (client) => {
//       await client.query('INSERT ...');
//       return client.query('SELECT ...');
//   });
async function tenantQuery(companyId, textOrFn, params) {
    if (!companyId) throw new Error('tenantQuery called without a companyId');
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // set_config(key, value, is_local=true) => scoped to this transaction only
        await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
        let result;
        if (typeof textOrFn === 'function') {
            result = await textOrFn(client);
        } else {
            result = await client.query(textOrFn, params);
        }
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Get company by subdomain
async function getCompanyBySubdomain(subdomain) {
    const result = await query(
        'SELECT * FROM companies WHERE subdomain = $1 AND status = $2',
        [subdomain, 'active']
    );
    return result.rows[0] || null;
}

// Get company by ID
async function getCompanyById(id) {
    const result = await query(
        'SELECT * FROM companies WHERE id = $1',
        [id]
    );
    return result.rows[0] || null;
}

module.exports = {
    query,
    tenantQuery,
    transaction,
    runWithTenant,
    setTenant,
    currentTenant,
    getPool,
    getCompanyBySubdomain,
    getCompanyById
};
