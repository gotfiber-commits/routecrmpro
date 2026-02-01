// Response helper utilities

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
};

// Success response
function success(data, statusCode = 200) {
    return {
        statusCode,
        headers: CORS_HEADERS,
        body: JSON.stringify(data)
    };
}

// Error response
function error(message, statusCode = 400, details = null) {
    const body = {
        error: message,
        ...(details && { details })
    };
    return {
        statusCode,
        headers: CORS_HEADERS,
        body: JSON.stringify(body)
    };
}

// Handle OPTIONS preflight
function handleOptions() {
    return {
        statusCode: 204,
        headers: CORS_HEADERS,
        body: ''
    };
}

// Parse JSON body safely
function parseBody(event) {
    try {
        if (!event.body) return {};
        return JSON.parse(event.body);
    } catch (e) {
        return {};
    }
}

// Get query parameters
function getQueryParams(event) {
    return event.queryStringParameters || {};
}

// Get path parameter (for routes like /api/users/:id)
function getPathParam(event, paramName) {
    // Netlify Functions path parsing
    const path = event.path;
    const pathParts = path.split('/').filter(Boolean);
    
    // Find the parameter index based on function structure
    // This is a simple implementation - adjust based on your URL patterns
    return event.pathParameters?.[paramName] || null;
}

// Pagination helper
function getPagination(event, defaultLimit = 50) {
    const params = getQueryParams(event);
    const page = Math.max(1, parseInt(params.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(params.limit) || defaultLimit));
    const offset = (page - 1) * limit;
    
    return { page, limit, offset };
}

// Build pagination response
function paginatedResponse(data, total, page, limit) {
    return {
        data,
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasMore: page * limit < total
        }
    };
}

module.exports = {
    CORS_HEADERS,
    success,
    error,
    handleOptions,
    parseBody,
    getQueryParams,
    getPathParam,
    getPagination,
    paginatedResponse
};
