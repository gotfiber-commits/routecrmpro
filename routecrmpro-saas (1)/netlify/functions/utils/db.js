// Database connection utility for Neon PostgreSQL
const { Pool } = require('pg');

// Connection pool - reused across function invocations
let pool;

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

// Execute a query
async function query(text, params) {
    const client = await getPool().connect();
    try {
        const result = await client.query(text, params);
        return result;
    } finally {
        client.release();
    }
}

// Execute a transaction
async function transaction(callback) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
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
    transaction,
    getPool,
    getCompanyBySubdomain,
    getCompanyById
};
