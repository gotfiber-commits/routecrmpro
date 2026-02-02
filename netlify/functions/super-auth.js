// Super Admin Authentication API
const { query } = require('./utils/db');
const { verifyPassword, generateSuperAdminToken, hashPassword, requireSuperAdmin } = require('./utils/auth');
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

        // POST /super-auth/change-password - Change password
        if (method === 'POST' && path === '/change-password') {
            return await handleChangePassword(event);
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

async function handleChangePassword(event) {
    // Verify super admin token
    const authResult = requireSuperAdmin(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const { currentPassword, newPassword } = parseBody(event);

    if (!currentPassword || !newPassword) {
        return error('Current password and new password required', 400);
    }

    if (newPassword.length < 8) {
        return error('New password must be at least 8 characters', 400);
    }

    // Get admin
    const result = await query(
        'SELECT * FROM super_admins WHERE id = $1',
        [authResult.admin.adminId]
    );

    if (result.rows.length === 0) {
        return error('Admin not found', 404);
    }

    const admin = result.rows[0];

    // Verify current password
    const validPassword = await verifyPassword(currentPassword, admin.password_hash);
    if (!validPassword) {
        return error('Current password is incorrect', 401);
    }

    // Hash new password
    const newHash = await hashPassword(newPassword);

    // Update password
    await query(
        'UPDATE super_admins SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newHash, admin.id]
    );

    return success({ message: 'Password changed successfully' });
}
