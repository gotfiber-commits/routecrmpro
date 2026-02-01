// Database Setup Script
// Run this once to initialize your Neon PostgreSQL database
// Usage: DATABASE_URL=your_connection_string node scripts/setup-db.js

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

async function setup() {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.error('❌ DATABASE_URL environment variable is required');
        console.log('   Usage: DATABASE_URL=postgres://... node scripts/setup-db.js');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    try {
        console.log('🔌 Connecting to database...');
        const client = await pool.connect();
        
        console.log('📄 Reading schema file...');
        const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
        let schema = fs.readFileSync(schemaPath, 'utf8');
        
        // Generate a proper password hash for the super admin
        console.log('🔐 Generating super admin password hash...');
        const defaultPassword = 'superadmin123';
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        
        // Replace placeholder with actual hash
        schema = schema.replace('$2b$10$placeholder_hash_change_this', passwordHash);
        
        console.log('🏗️  Creating tables...');
        await client.query(schema);
        
        console.log('✅ Database setup complete!');
        console.log('');
        console.log('📋 Super Admin Credentials:');
        console.log('   Username: superadmin');
        console.log('   Password: superadmin123');
        console.log('');
        console.log('⚠️  IMPORTANT: Change the super admin password after first login!');
        
        client.release();
    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        
        if (error.message.includes('already exists')) {
            console.log('');
            console.log('💡 Tables may already exist. To reset, drop all tables first:');
            console.log('   DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        }
        
        process.exit(1);
    } finally {
        await pool.end();
    }
}

setup();
