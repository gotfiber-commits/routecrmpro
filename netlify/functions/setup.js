// One-time setup endpoint - DELETE THIS FILE after use!
const { query } = require('./utils/db');
const bcrypt = require('bcryptjs');
const { success, error, handleOptions } = require('./utils/response');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    if (event.httpMethod !== 'POST') {
        return error('POST required', 405);
    }

    try {
        // Generate proper bcrypt hash
        const password = 'superadmin123';
        const hash = await bcrypt.hash(password, 10);
        
        // Delete existing and insert new
        await query('DELETE FROM super_admins WHERE username = $1', ['superadmin']);
        
        await query(
            `INSERT INTO super_admins (username, email, password_hash, name, can_delete_companies, can_impersonate)
             VALUES ($1, $2, $3, $4, true, true)`,
            ['superadmin', 'admin@routecrmpro.com', hash, 'Platform Administrator']
        );

        return success({ 
            message: 'Super admin created!',
            username: 'superadmin',
            password: 'superadmin123',
            warning: 'DELETE the setup.js file from your repo after this!'
        });
    } catch (err) {
        console.error('Setup error:', err);
        return error('Setup failed: ' + err.message, 500);
    }
};
