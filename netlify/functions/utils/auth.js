// Authentication utilities
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';
const SUPER_ADMIN_JWT_EXPIRES_IN = '8h';

// Fail fast if the signing secret is missing. Falling back to a hardcoded
// default would let anyone forge tokens for ANY company_id and read every
// tenant's data — so we refuse to operate without a real secret.
if (!JWT_SECRET) {
    throw new Error(
        'FATAL: JWT_SECRET environment variable is not set. ' +
        'Set it in Netlify (Site settings → Environment variables) before deploying. ' +
        'Refusing to start with an insecure default.'
    );
}

// Reject a known-weak leftover value in case it was copied into the env var.
if (JWT_SECRET === 'development-secret-key-change-in-production') {
    throw new Error(
        'FATAL: JWT_SECRET is set to the insecure development default. ' +
        'Generate a strong random secret (e.g. `openssl rand -base64 48`) and set it in Netlify.'
    );
}

// Hash password
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

// Verify password
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

// Generate JWT token for regular users
function generateToken(user, companyId) {
    const payload = {
        userId: user.id,
        companyId: companyId,
        role: user.role,
        username: user.username,
        type: 'user'
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Generate JWT token for super admins
function generateSuperAdminToken(admin) {
    const payload = {
        adminId: admin.id,
        username: admin.username,
        type: 'superadmin',
        permissions: {
            canCreateCompanies: admin.can_create_companies,
            canDeleteCompanies: admin.can_delete_companies,
            canImpersonate: admin.can_impersonate
        }
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: SUPER_ADMIN_JWT_EXPIRES_IN });
}

// Verify token
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        console.log('Token verification failed:', err.message);
        return null;
    }
}

// Extract token from Authorization header
function extractToken(headers) {
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader) return null;
    
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return authHeader;
}

// Middleware-style auth check for regular users
function requireAuth(event) {
    const token = extractToken(event.headers);
    if (!token) {
        return { error: 'No token provided', status: 401 };
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        return { error: 'Invalid or expired token', status: 401 };
    }
    
    if (decoded.type !== 'user') {
        return { error: 'Invalid token type', status: 401 };
    }
    
    return { user: decoded };
}

// Return the authoritative company scope for a request.
// SECURITY: the tenant is taken ONLY from the verified token, never from
// query params or the body. If a request tries to pass a different
// company_id, it is ignored (and flagged) so a user can never read or write
// another tenant's data by tampering with the URL or payload.
function getTenantScope(event, user) {
    const params = event.queryStringParameters || {};
    let bodyCompanyId;
    try {
        bodyCompanyId = event.body ? (JSON.parse(event.body).company_id) : undefined;
    } catch (e) {
        bodyCompanyId = undefined;
    }
    const claimed = params.company_id || bodyCompanyId;
    if (claimed && String(claimed) !== String(user.companyId)) {
        console.warn(
            `Tenant scope mismatch: token company=${user.companyId} but request claimed company=${claimed}. Using token value.`
        );
    }
    return user.companyId; // token is always authoritative
}

// Promise-style auth used by some endpoints (predictions.js, import.js).
// Resolves to { user, companyId, role }. Throws on failure so callers can
// try/catch. This mirrors requireAuth but in a shape those handlers expect.
async function authenticateRequest(event) {
    const result = requireAuth(event);
    if (result.error) {
        const err = new Error(result.error);
        err.statusCode = result.status;
        throw err;
    }
    return {
        user: result.user,
        companyId: result.user.companyId,
        role: result.user.role
    };
}

// Middleware-style auth check for super admins
function requireSuperAdmin(event) {
    const token = extractToken(event.headers);
    if (!token) {
        return { error: 'No token provided', status: 401 };
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        return { error: 'Invalid or expired token', status: 401 };
    }
    
    if (decoded.type !== 'superadmin') {
        return { error: 'Super admin access required', status: 403 };
    }
    
    return { admin: decoded };
}

// Check if user has specific role
function requireRole(user, allowedRoles) {
    if (!Array.isArray(allowedRoles)) {
        allowedRoles = [allowedRoles];
    }
    return allowedRoles.includes(user.role);
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    generateSuperAdminToken,
    verifyToken,
    extractToken,
    requireAuth,
    authenticateRequest,
    getTenantScope,
    requireSuperAdmin,
    requireRole
};
