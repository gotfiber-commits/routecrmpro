# RouteCRMPro Security Guide

## Security Features Implemented

### 1. Authentication & Authorization

#### JWT Token Security
- **Library**: jsonwebtoken
- **Token Expiry**: 24 hours for regular users, 8 hours for super admins
- **Secret**: Stored in `JWT_SECRET` environment variable
- **Payload**: Contains userId, companyId, role, username, and type

#### Password Security
- **Library**: bcryptjs
- **Salt Rounds**: 10 (industry standard)
- **Storage**: Only password hashes are stored, never plaintext

#### Role-Based Access Control (RBAC)
- **Roles**: admin, driver, dispatch, accounting, payroll
- **Enforcement**: `requireRole()` function validates user roles before sensitive operations
- **Super Admin**: Separate authentication flow with elevated permissions

### 2. Multi-Tenant Isolation

#### Data Separation
- All database queries filter by `company_id`
- Users can only access data for their assigned company
- Cross-tenant data access is prevented at the API level

#### Tenant Resolution
- Primary: JWT token `companyId` claim
- Fallback: URL subdomain or query parameter
- API endpoints validate tenant context before processing

### 3. API Security

#### CORS Configuration
```javascript
'Access-Control-Allow-Origin': '*',  // Restrict in production
'Access-Control-Allow-Headers': 'Content-Type, Authorization',
'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
```

#### Security Headers
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000`

#### Input Validation
- JSON body parsing with error handling
- Parameterized SQL queries (no string concatenation)
- Role validation on protected endpoints

### 4. Database Security

#### Connection
- SSL/TLS encrypted connection to Neon PostgreSQL
- Connection pooling with limits
- Connection string stored in environment variable

#### Query Safety
- All queries use parameterized placeholders ($1, $2, etc.)
- No string interpolation in SQL statements
- Transaction support for atomic operations

### 5. Environment Variables Required

```bash
# Required for production
DATABASE_URL=postgresql://...          # Neon PostgreSQL connection
JWT_SECRET=your-256-bit-secret         # Min 32 characters, random
GOOGLE_MAPS_API_KEY=AIza...           # Google Maps for geocoding

# Optional (for billing features)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
```

## Production Checklist

### Before Going Live

- [ ] Set strong `JWT_SECRET` (min 32 random characters)
- [ ] Update CORS `Access-Control-Allow-Origin` to your domain
- [ ] Remove or secure `/auth/setup-demo` endpoint
- [ ] Remove or secure `/super-auth/setup` endpoint
- [ ] Enable Netlify password protection on admin routes
- [ ] Configure custom domain with SSL
- [ ] Set up database backups
- [ ] Review and rotate API keys

### Recommended Improvements for Production

1. **Rate Limiting**: Add rate limiting to login and API endpoints
2. **IP Whitelisting**: Consider IP restrictions for admin access
3. **Audit Logging**: Enhanced audit trail for compliance
4. **2FA**: Add two-factor authentication for admin users
5. **Session Management**: Add refresh token rotation
6. **Monitoring**: Set up error tracking and security alerts

## Security Endpoints

### Public Endpoints (No Auth Required)
- `GET /settings` - Landing page configuration
- `GET /settings/:key` - Individual settings

### Protected Endpoints
All other endpoints require valid JWT token in `Authorization: Bearer <token>` header

### Super Admin Endpoints
- `/super-auth/*` - Requires super admin token
- `/settings` (PUT) - Requires super admin for modifications

## Incident Response

If you suspect a security breach:

1. Rotate `JWT_SECRET` immediately (invalidates all sessions)
2. Reset all admin passwords
3. Review audit logs for suspicious activity
4. Rotate database credentials
5. Rotate API keys (Google Maps, Stripe)

## Contact

For security concerns, contact your system administrator immediately.
