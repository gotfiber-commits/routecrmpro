// Companies Management API (Super Admin only)
const { query, transaction } = require('./utils/db');
const { requireSuperAdmin, hashPassword } = require('./utils/auth');
const { success, error, handleOptions, parseBody, getPagination, paginatedResponse } = require('./utils/response');

exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    // Require super admin authentication
    const authResult = requireSuperAdmin(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const admin = authResult.admin;
    const path = event.path.replace('/.netlify/functions/companies', '');
    const method = event.httpMethod;

    try {
        // GET /companies - List all companies
        if (method === 'GET' && path === '') {
            return await listCompanies(event);
        }

        // GET /companies/stats - Get platform statistics
        if (method === 'GET' && path === '/stats') {
            return await getStats();
        }

        // GET /companies/:id - Get single company
        if (method === 'GET' && path.match(/^\/[a-f0-9-]+$/)) {
            const companyId = path.slice(1);
            return await getCompany(companyId);
        }

        // POST /companies - Create new company
        if (method === 'POST' && path === '') {
            if (!admin.permissions.canCreateCompanies) {
                return error('Permission denied', 403);
            }
            return await createCompany(event);
        }

        // PUT /companies/:id - Update company
        if (method === 'PUT' && path.match(/^\/[a-f0-9-]+$/)) {
            const companyId = path.slice(1);
            return await updateCompany(companyId, event);
        }

        // DELETE /companies/:id - Delete company
        if (method === 'DELETE' && path.match(/^\/[a-f0-9-]+$/)) {
            if (!admin.permissions.canDeleteCompanies) {
                return error('Permission denied', 403);
            }
            const companyId = path.slice(1);
            return await deleteCompany(companyId);
        }

        // POST /companies/:id/setup-admin - Create initial admin user for company
        if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/setup-admin$/)) {
            const companyId = path.split('/')[1];
            return await setupCompanyAdmin(companyId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Companies API error:', err);
        return error('Internal server error', 500);
    }
};

async function listCompanies(event) {
    const { page, limit, offset } = getPagination(event);
    const params = event.queryStringParameters || {};

    let whereClause = '';
    const queryParams = [];
    let paramCount = 0;

    // Filter by status
    if (params.status) {
        paramCount++;
        whereClause += ` WHERE status = $${paramCount}`;
        queryParams.push(params.status);
    }

    // Filter by plan
    if (params.plan) {
        paramCount++;
        whereClause += whereClause ? ` AND plan = $${paramCount}` : ` WHERE plan = $${paramCount}`;
        queryParams.push(params.plan);
    }

    // Search by name or subdomain
    if (params.search) {
        paramCount++;
        const searchClause = ` (name ILIKE $${paramCount} OR subdomain ILIKE $${paramCount})`;
        whereClause += whereClause ? ` AND ${searchClause}` : ` WHERE ${searchClause}`;
        queryParams.push(`%${params.search}%`);
    }

    // Get total count
    const countResult = await query(
        `SELECT COUNT(*) FROM companies${whereClause}`,
        queryParams
    );
    const total = parseInt(countResult.rows[0].count);

    // Get companies
    const result = await query(
        `SELECT 
            c.*,
            (SELECT COUNT(*) FROM users WHERE company_id = c.id) as user_count,
            (SELECT COUNT(*) FROM distribution_centers WHERE company_id = c.id) as dc_count,
            (SELECT COUNT(*) FROM customers WHERE company_id = c.id) as customer_count
        FROM companies c
        ${whereClause}
        ORDER BY c.created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
        [...queryParams, limit, offset]
    );

    return success(paginatedResponse(result.rows, total, page, limit));
}

async function getStats() {
    const result = await query(`
        SELECT
            (SELECT COUNT(*) FROM companies) as total_companies,
            (SELECT COUNT(*) FROM companies WHERE status = 'active') as active_companies,
            (SELECT COUNT(*) FROM companies WHERE plan = 'trial') as trial_companies,
            (SELECT COUNT(*) FROM companies WHERE plan = 'starter') as starter_companies,
            (SELECT COUNT(*) FROM companies WHERE plan = 'professional') as pro_companies,
            (SELECT COUNT(*) FROM companies WHERE plan = 'enterprise') as enterprise_companies,
            (SELECT COUNT(*) FROM users) as total_users,
            (SELECT COUNT(*) FROM distribution_centers) as total_dcs,
            (SELECT COUNT(*) FROM customers) as total_customers,
            (SELECT COUNT(*) FROM orders) as total_orders,
            (SELECT COUNT(*) FROM companies WHERE created_at > NOW() - INTERVAL '30 days') as new_companies_30d
    `);

    return success(result.rows[0]);
}

async function getCompany(companyId) {
    const result = await query(
        `SELECT 
            c.*,
            (SELECT COUNT(*) FROM users WHERE company_id = c.id) as user_count,
            (SELECT COUNT(*) FROM distribution_centers WHERE company_id = c.id) as dc_count,
            (SELECT COUNT(*) FROM trucks WHERE company_id = c.id) as truck_count,
            (SELECT COUNT(*) FROM drivers WHERE company_id = c.id) as driver_count,
            (SELECT COUNT(*) FROM customers WHERE company_id = c.id) as customer_count,
            (SELECT COUNT(*) FROM orders WHERE company_id = c.id) as order_count,
            (SELECT COUNT(*) FROM routes WHERE company_id = c.id) as route_count
        FROM companies c
        WHERE c.id = $1`,
        [companyId]
    );

    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    // Get recent activity
    const activityResult = await query(
        `SELECT * FROM audit_log 
        WHERE company_id = $1 
        ORDER BY created_at DESC 
        LIMIT 10`,
        [companyId]
    );

    // Get users
    const usersResult = await query(
        `SELECT id, username, name, email, role, status, last_login 
        FROM users 
        WHERE company_id = $1 
        ORDER BY created_at DESC`,
        [companyId]
    );

    return success({
        ...result.rows[0],
        recent_activity: activityResult.rows,
        users: usersResult.rows
    });
}

async function createCompany(event) {
    const body = parseBody(event);
    const { name, subdomain, email, phone, address, city, state, zip, plan } = body;

    // Validation
    if (!name || !subdomain || !email) {
        return error('Name, subdomain, and email are required', 400);
    }

    // Validate subdomain format
    const subdomainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    if (!subdomainRegex.test(subdomain.toLowerCase())) {
        return error('Invalid subdomain format. Use lowercase letters, numbers, and hyphens only.', 400);
    }

    // Reserved subdomains
    const reserved = ['www', 'app', 'api', 'admin', 'mail', 'ftp', 'localhost', 'test', 'demo', 'staging'];
    if (reserved.includes(subdomain.toLowerCase())) {
        return error('This subdomain is reserved', 400);
    }

    // Check if subdomain exists
    const existingResult = await query(
        'SELECT id FROM companies WHERE subdomain = $1',
        [subdomain.toLowerCase()]
    );

    if (existingResult.rows.length > 0) {
        return error('Subdomain already taken', 400);
    }

    // Set plan limits
    const planLimits = {
        trial: { max_users: 5, max_distribution_centers: 1, max_trucks: 5 },
        starter: { max_users: 10, max_distribution_centers: 2, max_trucks: 15 },
        professional: { max_users: 50, max_distribution_centers: 10, max_trucks: 50 },
        enterprise: { max_users: 999, max_distribution_centers: 999, max_trucks: 999 }
    };
    const limits = planLimits[plan] || planLimits.trial;

    // Calculate plan expiry (30 days for trial)
    const planStarted = new Date();
    let planExpires = null;
    if (plan === 'trial' || !plan) {
        planExpires = new Date();
        planExpires.setDate(planExpires.getDate() + 30);
    }

    // Create company
    const result = await query(
        `INSERT INTO companies (
            name, subdomain, email, phone, address, city, state, zip,
            plan, plan_started_at, plan_expires_at,
            max_users, max_distribution_centers, max_trucks
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
            name,
            subdomain.toLowerCase(),
            email,
            phone || null,
            address || null,
            city || null,
            state || null,
            zip || null,
            plan || 'trial',
            planStarted,
            planExpires,
            limits.max_users,
            limits.max_distribution_centers,
            limits.max_trucks
        ]
    );

    return success(result.rows[0], 201);
}

async function updateCompany(companyId, event) {
    const body = parseBody(event);
    const allowedFields = ['name', 'email', 'phone', 'address', 'city', 'state', 'zip', 
                          'plan', 'status', 'max_users', 'max_distribution_centers', 'max_trucks', 'settings'];

    const updates = [];
    const values = [];
    let paramCount = 0;

    for (const field of allowedFields) {
        if (body[field] !== undefined) {
            paramCount++;
            updates.push(`${field} = $${paramCount}`);
            values.push(field === 'settings' ? JSON.stringify(body[field]) : body[field]);
        }
    }

    if (updates.length === 0) {
        return error('No valid fields to update', 400);
    }

    // Handle plan changes - update expiry
    if (body.plan) {
        paramCount++;
        updates.push(`plan_started_at = $${paramCount}`);
        values.push(new Date());

        if (body.plan === 'trial') {
            paramCount++;
            const expires = new Date();
            expires.setDate(expires.getDate() + 30);
            updates.push(`plan_expires_at = $${paramCount}`);
            values.push(expires);
        } else {
            paramCount++;
            updates.push(`plan_expires_at = $${paramCount}`);
            values.push(null);
        }
    }

    paramCount++;
    values.push(companyId);

    const result = await query(
        `UPDATE companies SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        values
    );

    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    return success(result.rows[0]);
}

async function deleteCompany(companyId) {
    // Soft delete - set status to cancelled
    const result = await query(
        `UPDATE companies SET status = 'cancelled' WHERE id = $1 RETURNING *`,
        [companyId]
    );

    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    return success({ message: 'Company cancelled', company: result.rows[0] });
}

async function setupCompanyAdmin(companyId, event) {
    const body = parseBody(event);
    const { username, email, password, name } = body;

    if (!username || !email || !password || !name) {
        return error('Username, email, password, and name are required', 400);
    }

    // Check company exists
    const companyResult = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
    if (companyResult.rows.length === 0) {
        return error('Company not found', 404);
    }

    // Check if admin already exists
    const existingAdmin = await query(
        'SELECT id FROM users WHERE company_id = $1 AND role = $2',
        [companyId, 'admin']
    );

    if (existingAdmin.rows.length > 0) {
        return error('Admin user already exists for this company', 400);
    }

    // Hash password and create admin
    const passwordHash = await hashPassword(password);

    const result = await query(
        `INSERT INTO users (company_id, username, email, password_hash, name, role, avatar)
        VALUES ($1, $2, $3, $4, $5, 'admin', '👨‍💼')
        RETURNING id, username, email, name, role, status, created_at`,
        [companyId, username, email, passwordHash, name]
    );

    return success({
        message: 'Admin user created',
        user: result.rows[0]
    }, 201);
}
