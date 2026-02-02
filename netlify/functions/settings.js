// Site Settings API - Manage landing page content
const { query } = require('./utils/db');
const { requireSuperAdmin } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/settings', '');
    const method = event.httpMethod;

    try {
        // GET /settings - Public endpoint to get all settings (for landing page)
        if (method === 'GET' && path === '') {
            return await getAllSettings();
        }

        // GET /settings/:key - Public endpoint to get specific setting
        if (method === 'GET' && path.match(/^\/[\w-]+$/)) {
            const key = path.slice(1);
            return await getSetting(key);
        }

        // PUT /settings/:key - Super admin only - update setting
        if (method === 'PUT' && path.match(/^\/[\w-]+$/)) {
            const authResult = requireSuperAdmin(event);
            if (authResult.error) {
                return error(authResult.error, authResult.status);
            }
            const key = path.slice(1);
            return await updateSetting(key, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Settings error:', err);
        return error('Internal server error', 500);
    }
};

async function getAllSettings() {
    const result = await query('SELECT key, value FROM site_settings');
    
    const settings = {};
    for (const row of result.rows) {
        settings[row.key] = row.value;
    }
    
    return success(settings);
}

async function getSetting(key) {
    const result = await query(
        'SELECT value FROM site_settings WHERE key = $1',
        [key]
    );
    
    if (result.rows.length === 0) {
        return error('Setting not found', 404);
    }
    
    return success(result.rows[0].value);
}

async function updateSetting(key, event) {
    const body = parseBody(event);
    
    if (!body.value) {
        return error('Value is required', 400);
    }

    const result = await query(
        `INSERT INTO site_settings (key, value, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [key, JSON.stringify(body.value)]
    );

    return success(result.rows[0]);
}
