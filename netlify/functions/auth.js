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
        // POST /auth/portal-login - Universal login (finds company by email)
        if (method === 'POST' && path === '/portal-login') {
            return await handlePortalLogin(event);
        }

        // POST /auth/login - Tenant user login (requires tenant context)
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

        // GET /auth/setup-demo - Setup demo environment with proper hash (TEMPORARY)
        if (method === 'GET' && path === '/setup-demo') {
            const newHash = await hashPassword('admin123');
            
            // Check if demo company exists
            const companyCheck = await query(`SELECT id FROM companies WHERE subdomain = 'demo'`);
            
            if (companyCheck.rows.length === 0) {
                // Create demo company
                await query(`
                    INSERT INTO companies (id, name, subdomain, email, status, settings)
                    VALUES ('de000000-0000-0000-0000-000000000001', 'Southeast Propane Distribution', 'demo', 'info@southeastpropane.com', 'active', '{}')
                    ON CONFLICT (subdomain) DO NOTHING
                `);
            }
            
            // Delete and recreate demo user
            await query(`DELETE FROM users WHERE company_id = 'de000000-0000-0000-0000-000000000001' AND username = 'demo'`);
            
            const result = await query(`
                INSERT INTO users (company_id, username, email, password_hash, name, role, status)
                VALUES ('de000000-0000-0000-0000-000000000001', 'demo', 'demo@southeastpropane.com', $1, 'Demo Administrator', 'admin', 'active')
                RETURNING username, email
            `, [newHash]);
            
            return success({ 
                message: 'Demo user created! Login at /demo with admin123',
                user: result.rows[0],
                hashCreated: newHash.substring(0, 20) + '...'
            });
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Auth error:', err);
        return error('Internal server error', 500);
    }
};

// Universal Portal Login - finds user by email across all companies
async function handlePortalLogin(event) {
    const body = parseBody(event);
    const { email, password, username } = body;

    // Accept either email or username
    const loginId = email || username;

    if (!loginId || !password) {
        return error('Email/username and password required', 400);
    }

    // Find user by email or username across all companies
    const result = await query(
        `SELECT u.*, c.id as company_id, c.name as company_name, c.subdomain, c.plan, c.status as company_status, c.plan_expires_at
        FROM users u
        JOIN companies c ON u.company_id = c.id
        WHERE (LOWER(u.email) = LOWER($1) OR LOWER(u.username) = LOWER($1))
        AND u.status = 'active'
        LIMIT 1`,
        [loginId]
    );

    const user = result.rows[0];

    if (!user) {
        return error('Invalid email/username or password', 401);
    }

    // Check company status
    if (user.company_status !== 'active') {
        return error('Your company account is not active. Please contact support.', 403);
    }

    // Check trial expiry
    if (user.plan === 'trial' && user.plan_expires_at) {
        const expiry = new Date(user.plan_expires_at);
        if (expiry < new Date()) {
            return error('Trial period has expired. Please upgrade your plan.', 403);
        }
    }

    // Verify password
    const validPassword = await verifyPassword(password, user.password_hash);

    if (!validPassword) {
        return error('Invalid email/username or password', 401);
    }

    // Update last login
    await query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );

    // Log the login
    try {
        await query(
            `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, ip_address)
            VALUES ($1, $2, 'portal_login', 'user', $3, $4)`,
            [user.company_id, user.id, user.id, event.headers['x-forwarded-for'] || 'unknown']
        );
    } catch (e) {
        // Audit log failure shouldn't block login
        console.log('Audit log error:', e.message);
    }

    // Generate token
    const token = generateToken(user, user.company_id);

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
            id: user.company_id,
            name: user.company_name,
            subdomain: user.subdomain,
            plan: user.plan
        },
        dc: dcInfo,
        redirect: `/app.html?tenant=${user.subdomain}`
    });
}

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

    // Get driver info if user is linked to a driver
    let driverInfo = null;
    let truckInfo = null;
    if (user.driver_id) {
        const driverResult = await query(
            `SELECT d.*, dc.name as dc_name, dc.code as dc_code
             FROM drivers d
             LEFT JOIN distribution_centers dc ON d.dc_id = dc.id
             WHERE d.id = $1`,
            [user.driver_id]
        );
        if (driverResult.rows.length > 0) {
            const driver = driverResult.rows[0];
            driverInfo = {
                id: driver.id,
                code: driver.code,
                name: driver.name,
                phone: driver.phone,
                cdlClass: driver.cdl_class,
                hazmatCertified: driver.hazmat_certified,
                dcId: driver.dc_id,
                dcName: driver.dc_name,
                dcCode: driver.dc_code
            };

            // Get assigned truck
            const truckResult = await query(
                `SELECT t.*, dc.name as dc_name
                 FROM trucks t
                 LEFT JOIN distribution_centers dc ON t.dc_id = dc.id
                 WHERE t.assigned_driver_id = $1 AND t.status = 'active'`,
                [user.driver_id]
            );
            if (truckResult.rows.length > 0) {
                const truck = truckResult.rows[0];
                truckInfo = {
                    id: truck.id,
                    code: truck.code,
                    name: truck.name,
                    make: truck.make,
                    model: truck.model,
                    year: truck.year,
                    licensePlate: truck.license_plate,
                    capacityGallons: truck.capacity_gallons,
                    currentOdometer: truck.current_odometer
                };
            }
        }
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
        dc: dcInfo,
        driver: driverInfo,
        truck: truckInfo
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
