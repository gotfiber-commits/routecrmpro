// Tenant Authentication API
const { query, transaction } = require('./utils/db');
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

        // POST /auth/register - Public self-serve signup (creates company + admin, 30-day trial)
        if (method === 'POST' && path === '/register') {
            return await handleRegister(event);
        }

        // GET /auth/check-subdomain?subdomain=x - Live availability check for the signup form
        if (method === 'GET' && path === '/check-subdomain') {
            return await checkSubdomain(event);
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
            try {
                const newHash = await hashPassword('admin123');
                
                // Check if demo company exists
                const companyCheck = await query(`SELECT id FROM companies WHERE subdomain = 'demo'`);
                
                let companyCreated = false;
                if (companyCheck.rows.length === 0) {
                    // Create demo company
                    await query(`
                        INSERT INTO companies (id, name, subdomain, email, status, settings)
                        VALUES ('de000000-0000-0000-0000-000000000001', 'Southeast Propane Distribution', 'demo', 'info@southeastpropane.com', 'active', '{}')
                        ON CONFLICT (subdomain) DO UPDATE SET name = 'Southeast Propane Distribution'
                    `);
                    companyCreated = true;
                }
                
                // Check if demo user exists
                const userCheck = await query(`SELECT id FROM users WHERE company_id = 'de000000-0000-0000-0000-000000000001' AND username = 'demo'`);
                
                let userCreated = false;
                if (userCheck.rows.length === 0) {
                    // Create demo user
                    await query(`
                        INSERT INTO users (company_id, username, email, password_hash, name, role, status)
                        VALUES ('de000000-0000-0000-0000-000000000001', 'demo', 'demo@southeastpropane.com', $1, 'Demo Administrator', 'admin', 'active')
                    `, [newHash]);
                    userCreated = true;
                } else {
                    // Update existing user's password
                    await query(`
                        UPDATE users SET password_hash = $1 
                        WHERE company_id = 'de000000-0000-0000-0000-000000000001' AND username = 'demo'
                    `, [newHash]);
                }
                
                return success({ 
                    message: 'Demo environment ready! Login at /demo with username: demo, password: admin123',
                    companyCreated,
                    userCreated: userCreated,
                    userUpdated: !userCreated
                });
            } catch (setupErr) {
                console.error('Demo setup error:', setupErr);
                return error('Failed to setup demo: ' + setupErr.message, 500);
            }
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
        `SELECT u.*, c.id as company_id, c.name as company_name, c.subdomain, c.plan, c.status as company_status, c.plan_expires_at, c.google_maps_enabled
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
            plan: user.plan,
            google_maps_enabled: user.google_maps_enabled === true
        },
        dc: dcInfo,
        redirect: `/app.html?tenant=${user.subdomain}`
    });
}

// ---------------------------------------------------------------------------
// SELF-SERVE SIGNUP
// ---------------------------------------------------------------------------

const RESERVED_SUBDOMAINS = [
    'www', 'app', 'api', 'admin', 'mail', 'ftp', 'localhost', 'test', 'demo',
    'staging', 'portal', 'dashboard', 'login', 'signup', 'register', 'support',
    'help', 'billing', 'status', 'blog', 'docs', 'cdn', 'assets', 'static'
];
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

function normalizeSubdomain(s) {
    return String(s || '').toLowerCase().trim();
}

// GET /auth/check-subdomain?subdomain=acme -> { available: bool, reason?: string }
async function checkSubdomain(event) {
    const params = event.queryStringParameters || {};
    const subdomain = normalizeSubdomain(params.subdomain);

    if (!subdomain) return success({ available: false, reason: 'Enter a company ID' });
    if (subdomain.length < 3) return success({ available: false, reason: 'Must be at least 3 characters' });
    if (subdomain.length > 63) return success({ available: false, reason: 'Too long (max 63 characters)' });
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
        return success({ available: false, reason: 'Use lowercase letters, numbers and hyphens only' });
    }
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
        return success({ available: false, reason: 'This company ID is reserved' });
    }

    const existing = await query('SELECT id FROM companies WHERE subdomain = $1', [subdomain]);
    if (existing.rows.length > 0) {
        return success({ available: false, reason: 'Already taken' });
    }
    return success({ available: true });
}

// POST /auth/register
// Body: { companyName, subdomain, adminName, email, password, phone? }
// Creates a company (30-day trial) + first admin user atomically, then logs them in.
async function handleRegister(event) {
    const body = parseBody(event);
    const companyName = String(body.companyName || '').trim();
    const subdomain = normalizeSubdomain(body.subdomain);
    const adminName = String(body.adminName || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const phone = body.phone ? String(body.phone).trim() : null;

    // --- Validation ---
    if (!companyName || !subdomain || !adminName || !email || !password) {
        return error('All fields are required', 400);
    }
    if (companyName.length < 2) return error('Company name is too short', 400);

    if (subdomain.length < 3 || subdomain.length > 63 || !SUBDOMAIN_REGEX.test(subdomain)) {
        return error('Invalid company ID. Use 3-63 lowercase letters, numbers and hyphens.', 400);
    }
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
        return error('This company ID is reserved. Please choose another.', 400);
    }

    // Email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return error('Please enter a valid email address', 400);

    // Password strength (reasonable minimum)
    if (password.length < 8) return error('Password must be at least 8 characters', 400);

    // --- Uniqueness checks ---
    // Subdomain must be globally unique.
    const subTaken = await query('SELECT id FROM companies WHERE subdomain = $1', [subdomain]);
    if (subTaken.rows.length > 0) {
        return error('That company ID is already taken. Please choose another.', 409);
    }

    // Email must be globally unique: portal-login matches email across ALL companies,
    // so a duplicate would make login ambiguous. Enforce it here.
    const emailTaken = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (emailTaken.rows.length > 0) {
        return error('An account with that email already exists. Try signing in instead.', 409);
    }

    const passwordHash = await hashPassword(password);

    // Derive a username from the email local-part (unique within the company anyway).
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'admin';

    // Trial window: 30 days.
    const planStarted = new Date();
    const planExpires = new Date();
    planExpires.setDate(planExpires.getDate() + 30);

    let created;
    try {
        created = await transaction(async (client) => {
            // Create company (trial)
            const companyRes = await client.query(
                `INSERT INTO companies (
                    name, subdomain, email, phone,
                    plan, plan_started_at, plan_expires_at,
                    max_users, max_distribution_centers, max_trucks,
                    status, settings
                ) VALUES ($1,$2,$3,$4,'trial',$5,$6,5,1,5,'active','{}')
                RETURNING *`,
                [companyName, subdomain, email, phone, planStarted, planExpires]
            );
            const company = companyRes.rows[0];

            // Create first admin user
            const userRes = await client.query(
                `INSERT INTO users (company_id, username, email, password_hash, name, phone, role, avatar, status)
                 VALUES ($1,$2,$3,$4,$5,$6,'admin','👤','active')
                 RETURNING id, username, email, name, role, status`,
                [company.id, username, email, passwordHash, adminName, phone]
            );
            const user = userRes.rows[0];

            return { company, user };
        });
    } catch (e) {
        // Unique-constraint race (two signups at once) or other DB error.
        console.error('Registration failed:', e.message);
        if (e.code === '23505') {
            return error('That company ID or email was just taken. Please try again.', 409);
        }
        return error('Could not create your account. Please try again.', 500);
    }

    // Audit (non-blocking)
    try {
        await query(
            `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, ip_address)
             VALUES ($1,$2,'signup','company',$1,$3)`,
            [created.company.id, created.user.id, event.headers['x-forwarded-for'] || 'unknown']
        );
    } catch (e) { /* ignore */ }

    // Auto-login: issue a token exactly like login does.
    const token = generateToken(
        { id: created.user.id, role: created.user.role, username: created.user.username },
        created.company.id
    );

    return success({
        token,
        user: {
            id: created.user.id,
            username: created.user.username,
            name: created.user.name,
            email: created.user.email,
            role: created.user.role,
            avatar: '👤',
            dcId: null,
            driverId: null
        },
        company: {
            id: created.company.id,
            name: created.company.name,
            subdomain: created.company.subdomain,
            plan: created.company.plan,
            plan_expires_at: created.company.plan_expires_at,
            google_maps_enabled: created.company.google_maps_enabled === true
        },
        isNewSignup: true,
        redirect: `/app.html?tenant=${created.company.subdomain}&welcome=1`
    }, 201);
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
            plan: company.plan,
            google_maps_enabled: company.google_maps_enabled === true
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
        `SELECT u.*, c.name as company_name, c.subdomain, c.plan, c.google_maps_enabled
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
            plan: user.plan,
            google_maps_enabled: user.google_maps_enabled === true
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
