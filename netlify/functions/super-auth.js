// Super Admin Authentication API
const { query } = require('./utils/db');
const { verifyPassword, generateSuperAdminToken, hashPassword } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/super-auth', '');
    const method = event.httpMethod;

    try {
        // POST /super-auth/login - Super admin login
        if (method === 'POST' && (path === '/login' || path === '')) {
            return await handleLogin(event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Super auth error:', err);
        return error('Internal server error', 500);
    }
};

async function handleLogin(event) {
    const { username, password } = parseBody(event);

    if (!username || !password) {
        return error('Username and password required', 400);
    }

    // Find super admin
    const result = await query(
        'SELECT * FROM super_admins WHERE username = $1 AND status = $2',
        [username, 'active']
    );

    const admin = result.rows[0];

    if (!admin) {
        return error('Invalid credentials', 401);
    }

    // Verify password
    const validPassword = await verifyPassword(password, admin.password_hash);

    if (!validPassword) {
        return error('Invalid credentials', 401);
    }

    // Update last login
    await query(
        'UPDATE super_admins SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [admin.id]
    );

    // Generate token
    const token = generateSuperAdminToken(admin);

    return success({
        token,
        admin: {
            id: admin.id,
            username: admin.username,
            name: admin.name,
            email: admin.email,
            permissions: {
                canCreateCompanies: admin.can_create_companies,
                canDeleteCompanies: admin.can_delete_companies,
                canImpersonate: admin.can_impersonate
            }
        }
    });
}
