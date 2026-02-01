// Tenant Authentication API
const { query } = require('./utils/db');
const { verifyPassword, generateToken, hashPassword, requireAuth } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/auth', '');
    const method = event.httpMethod;

    try {
        // POST /auth/login - Tenant user login
        if (method === 'POST' && (path === '/login' || path === '')) {
            return await handleLogin(event);
        }

        // GET /auth/me - Get current user info
        if (method === 'GET' && path === '/me') {
            return await getCurrentUser(event);
        }

        // POST /auth/change-password - Change password
        if (method === 'POST' && path === '/change-password') {
            return await changePassword(event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Auth error:', err);
        return error('Internal server error', 500);
    }
};

async function handleLogin(event) {
    const { username, password } = parseBody(event);

    if (!username || !password) {
        return error('Username and password required', 400);
    }

    // Resolve tenant from subdomain or query param
    const tenant = await resolveTenant(event);

    if (!tenant.resolved) {
        return error('Company not found. Please check the URL.', 404);
    }

    const company = tenant.company;

    // Check company status
    if (company.status !== 'active') {
        return error('This company account is not active. Please contact support.', 403);
    }

    // Check plan expiry for trial
    if (company.plan === 'trial' && company.plan_expires_at) {
        const expiry = new Date(company.plan_expires_at);
        if (expiry < new Date()) {
            return error('Trial period has expired. Please upgrade your plan.', 403);
        }
    }

    // Find user in this company
    const result = await query(
        `SELECT * FROM users 
        WHERE company_id = $1 AND username = $2 AND status = 'active'`,
        [company.id, username]
    );

    const user = result.rows[0];

    if (!user) {
        return error('Invalid username or password', 401);
    }

    // Verify password
    const validPassword = await verifyPassword(password, user.password_hash);

    if (!validPassword) {
        return error('Invalid username or password', 401);
    }

    // Update last login
    await query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );

    // Log the login
    await query(
        `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, ip_address)
        VALUES ($1, $2, 'login', 'user', $3, $4)`,
        [company.id, user.id, user.id, event.headers['x-forwarded-for'] || 'unknown']
    );

    // Generate token
    const token = generateToken(user, company.id);

    // Get user's DC info if assigned
    let dcInfo = null;
    if (user.dc_id) {
        const dcResult = await query(
            'SELECT id, code, name, city, state FROM distribution_centers WHERE id = $1',
            [user.dc_id]
        );
        dcInfo = dcResult.rows[0] || null;
    }

    return success({
        token,
        user: {
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            role: user.role,
            avatar: user.avatar,
            dcId: user.dc_id,
            driverId: user.driver_id,
            lastLogin: user.last_login
        },
        company: {
            id: company.id,
            name: company.name,
            subdomain: company.subdomain,
            plan: company.plan
        },
        dc: dcInfo
    });
}

async function getCurrentUser(event) {
    const authResult = requireAuth(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const { userId, companyId } = authResult.user;

    // Get fresh user data
    const userResult = await query(
        `SELECT u.*, c.name as company_name, c.subdomain, c.plan
        FROM users u
        JOIN companies c ON u.company_id = c.id
        WHERE u.id = $1 AND u.company_id = $2`,
        [userId, companyId]
    );

    if (userResult.rows.length === 0) {
        return error('User not found', 404);
    }

    const user = userResult.rows[0];

    // Get DC info if assigned
    let dcInfo = null;
    if (user.dc_id) {
        const dcResult = await query(
            'SELECT id, code, name, city, state FROM distribution_centers WHERE id = $1',
            [user.dc_id]
        );
        dcInfo = dcResult.rows[0] || null;
    }

    return success({
        user: {
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            role: user.role,
            avatar: user.avatar,
            dcId: user.dc_id,
            driverId: user.driver_id,
            lastLogin: user.last_login
        },
        company: {
            id: user.company_id,
            name: user.company_name,
            subdomain: user.subdomain,
            plan: user.plan
        },
        dc: dcInfo
    });
}

async function changePassword(event) {
    const authResult = requireAuth(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const { userId, companyId } = authResult.user;
    const { currentPassword, newPassword } = parseBody(event);

    if (!currentPassword || !newPassword) {
        return error('Current password and new password required', 400);
    }

    if (newPassword.length < 8) {
        return error('New password must be at least 8 characters', 400);
    }

    // Get user
    const userResult = await query(
        'SELECT * FROM users WHERE id = $1 AND company_id = $2',
        [userId, companyId]
    );

    if (userResult.rows.length === 0) {
        return error('User not found', 404);
    }

    const user = userResult.rows[0];

    // Verify current password
    const validPassword = await verifyPassword(currentPassword, user.password_hash);
    if (!validPassword) {
        return error('Current password is incorrect', 401);
    }

    // Hash new password
    const newHash = await hashPassword(newPassword);

    // Update password
    await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newHash, userId]
    );

    // Log the change
    await query(
        `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id)
        VALUES ($1, $2, 'password_change', 'user', $3)`,
        [companyId, userId, userId]
    );

    return success({ message: 'Password changed successfully' });
}
