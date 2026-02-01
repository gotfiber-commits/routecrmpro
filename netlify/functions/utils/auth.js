// Authentication utilities
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '24h';
const SUPER_ADMIN_JWT_EXPIRES_IN = '8h';

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
    } catch (error) {
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
    requireSuperAdmin,
    requireRole
};
