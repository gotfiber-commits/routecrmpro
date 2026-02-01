// Tenant resolution utility
// Supports both subdomain-based and query param-based tenant identification

const { getCompanyBySubdomain, getCompanyById } = require('./db');

// Extract tenant identifier from request
async function resolveTenant(event) {
    let subdomain = null;
    let companyId = null;
    
    // Method 1: Check for tenant query parameter (free tier / testing)
    const params = event.queryStringParameters || {};
    if (params.tenant) {
        subdomain = params.tenant;
    }
    
    // Method 2: Check for company_id in query params
    if (params.company_id) {
        companyId = params.company_id;
    }
    
    // Method 3: Extract from subdomain (Pro tier)
    if (!subdomain && !companyId) {
        const host = event.headers.host || event.headers.Host || '';
        
        // Parse subdomain from host
        // Expected formats:
        // - acme.routecrmpro.com (production)
        // - acme.localhost:8888 (local development)
        // - acme.routecrmpro.netlify.app (Netlify preview)
        
        const hostParts = host.split('.');
        
        // Check if it looks like a subdomain setup
        if (hostParts.length >= 2) {
            const potentialSubdomain = hostParts[0];
            
            // Exclude common non-tenant subdomains
            const excludedSubdomains = ['www', 'app', 'api', 'admin', 'localhost'];
            
            if (!excludedSubdomains.includes(potentialSubdomain.toLowerCase())) {
                subdomain = potentialSubdomain;
            }
        }
    }
    
    // Method 4: Check Authorization token for company_id
    // This is used after login when the token contains company info
    
    // Look up the company
    let company = null;
    
    if (companyId) {
        company = await getCompanyById(companyId);
    } else if (subdomain) {
        company = await getCompanyBySubdomain(subdomain);
    }
    
    return {
        subdomain,
        companyId: company?.id || companyId,
        company,
        resolved: !!company
    };
}

// Middleware-style tenant check
async function requireTenant(event) {
    const tenant = await resolveTenant(event);
    
    if (!tenant.resolved) {
        return {
            error: 'Company not found or inactive',
            status: 404,
            tenant: null
        };
    }
    
    return {
        error: null,
        tenant: tenant.company
    };
}

// Check if tenant is within plan limits
async function checkTenantLimits(company, resource, currentCount) {
    const limits = {
        trial: {
            users: 5,
            distribution_centers: 1,
            trucks: 5,
            customers: 50,
            orders_per_month: 100
        },
        starter: {
            users: 10,
            distribution_centers: 2,
            trucks: 15,
            customers: 200,
            orders_per_month: 500
        },
        professional: {
            users: 50,
            distribution_centers: 10,
            trucks: 50,
            customers: 1000,
            orders_per_month: 5000
        },
        enterprise: {
            users: -1, // unlimited
            distribution_centers: -1,
            trucks: -1,
            customers: -1,
            orders_per_month: -1
        }
    };
    
    const plan = company.plan || 'trial';
    const planLimits = limits[plan] || limits.trial;
    const limit = planLimits[resource];
    
    // -1 means unlimited
    if (limit === -1) return { allowed: true };
    
    return {
        allowed: currentCount < limit,
        limit,
        current: currentCount,
        plan
    };
}

module.exports = {
    resolveTenant,
    requireTenant,
    checkTenantLimits
};
