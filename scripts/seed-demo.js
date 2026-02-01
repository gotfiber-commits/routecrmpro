// Seed Demo Company with Sample Data
// Run: node scripts/seed-demo.js

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function seed() {
    console.log('🌱 Seeding demo company...\n');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Create Demo Company
        const companyResult = await client.query(`
            INSERT INTO companies (name, subdomain, plan, status, billing_email, max_users, max_distribution_centers)
            VALUES ('Demo Propane Co', 'demo', 'professional', 'active', 'demo@routecrmpro.com', 50, 10)
            ON CONFLICT (subdomain) DO UPDATE SET name = 'Demo Propane Co'
            RETURNING id
        `);
        const companyId = companyResult.rows[0].id;
        console.log('✅ Company created: Demo Propane Co (slug: demo)');

        // 2. Create Admin User
        const adminHash = await bcrypt.hash('admin123', 10);
        await client.query(`
            INSERT INTO users (company_id, username, password_hash, role, name, email, avatar)
            VALUES ($1, 'admin', $2, 'admin', 'Admin User', 'admin@demo.com', '👨‍💼')
            ON CONFLICT (company_id, username) DO UPDATE SET password_hash = $2
        `, [companyId, adminHash]);
        console.log('✅ Admin user: admin / admin123');

        // 3. Create Distribution Centers
        const dcs = [
            { code: 'DC-ATL', name: 'Atlanta Hub', city: 'Atlanta', state: 'GA', lat: 33.749, lng: -84.388 },
            { code: 'DC-BHM', name: 'Birmingham Center', city: 'Birmingham', state: 'AL', lat: 33.520, lng: -86.802 },
            { code: 'DC-NSH', name: 'Nashville Depot', city: 'Nashville', state: 'TN', lat: 36.162, lng: -86.781 },
        ];

        const dcIds = {};
        for (const dc of dcs) {
            const result = await client.query(`
                INSERT INTO distribution_centers (company_id, code, name, city, state, lat, lng, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
                ON CONFLICT (company_id, code) DO UPDATE SET name = $3
                RETURNING id
            `, [companyId, dc.code, dc.name, dc.city, dc.state, dc.lat, dc.lng]);
            dcIds[dc.code] = result.rows[0].id;
        }
        console.log('✅ Distribution Centers: 3 created');

        // 4. Create Trucks
        const trucks = [
            { code: 'TRK-101', name: 'Truck 101', capacity: 2500, dc: 'DC-ATL' },
            { code: 'TRK-102', name: 'Truck 102', capacity: 3000, dc: 'DC-ATL' },
            { code: 'TRK-201', name: 'Truck 201', capacity: 2500, dc: 'DC-BHM' },
            { code: 'TRK-301', name: 'Truck 301', capacity: 3500, dc: 'DC-NSH' },
        ];

        for (const t of trucks) {
            await client.query(`
                INSERT INTO trucks (company_id, dc_id, code, name, capacity_gallons, status)
                VALUES ($1, $2, $3, $4, $5, 'active')
                ON CONFLICT DO NOTHING
            `, [companyId, dcIds[t.dc], t.code, t.name, t.capacity]);
        }
        console.log('✅ Trucks: 4 created');

        // 5. Create Drivers
        const drivers = [
            { name: 'John Smith', phone: '555-0101', dc: 'DC-ATL' },
            { name: 'Maria Garcia', phone: '555-0102', dc: 'DC-ATL' },
            { name: 'James Wilson', phone: '555-0201', dc: 'DC-BHM' },
            { name: 'Sarah Johnson', phone: '555-0301', dc: 'DC-NSH' },
        ];

        for (const d of drivers) {
            await client.query(`
                INSERT INTO drivers (company_id, dc_id, name, phone, status)
                VALUES ($1, $2, $3, $4, 'available')
                ON CONFLICT DO NOTHING
            `, [companyId, dcIds[d.dc], d.name, d.phone]);
        }
        console.log('✅ Drivers: 4 created');

        // 6. Create Customers
        const customers = [
            { name: 'Riverside Farms', city: 'Marietta', state: 'GA', type: 'commercial', tank: 1000, lat: 33.952, lng: -84.549, dc: 'DC-ATL' },
            { name: 'Smith Residence', city: 'Decatur', state: 'GA', type: 'residential', tank: 500, lat: 33.774, lng: -84.296, dc: 'DC-ATL' },
            { name: 'Mountain Lodge', city: 'Jasper', state: 'GA', type: 'commercial', tank: 1500, lat: 34.467, lng: -84.429, dc: 'DC-ATL' },
            { name: 'Johnson Family', city: 'Hoover', state: 'AL', type: 'residential', tank: 500, lat: 33.405, lng: -86.811, dc: 'DC-BHM' },
            { name: 'Steel City Diner', city: 'Birmingham', state: 'AL', type: 'commercial', tank: 750, lat: 33.520, lng: -86.802, dc: 'DC-BHM' },
            { name: 'Country Store', city: 'Franklin', state: 'TN', type: 'commercial', tank: 1000, lat: 35.925, lng: -86.868, dc: 'DC-NSH' },
            { name: 'Williams Ranch', city: 'Murfreesboro', state: 'TN', type: 'residential', tank: 500, lat: 35.845, lng: -86.390, dc: 'DC-NSH' },
            { name: 'Hilltop Restaurant', city: 'Chattanooga', state: 'TN', type: 'commercial', tank: 1200, lat: 35.045, lng: -85.309, dc: 'DC-NSH' },
        ];

        const customerIds = [];
        for (const c of customers) {
            const result = await client.query(`
                INSERT INTO customers (company_id, preferred_dc, name, city, state, customer_type, tank_size, lat, lng, price_per_gallon, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2.50, 'active')
                ON CONFLICT DO NOTHING
                RETURNING id
            `, [companyId, dcIds[c.dc], c.name, c.city, c.state, c.type, c.tank, c.lat, c.lng]);
            if (result.rows[0]) customerIds.push(result.rows[0].id);
        }
        console.log('✅ Customers: 8 created');

        // 7. Create Orders
        const orderStatuses = ['pending', 'scheduled', 'delivered'];
        let orderNum = 1000;

        for (const customerId of customerIds.slice(0, 5)) {
            const gallons = Math.floor(Math.random() * 300) + 100;
            const status = orderStatuses[Math.floor(Math.random() * orderStatuses.length)];
            
            await client.query(`
                INSERT INTO orders (company_id, customer_id, order_number, gallons_requested, price_per_gallon, total_amount, status, priority)
                VALUES ($1, $2, $3, $4, 2.50, $5, $6, 'normal')
            `, [companyId, customerId, `ORD-${orderNum++}`, gallons, gallons * 2.50, status]);
        }
        console.log('✅ Orders: 5 created');

        await client.query('COMMIT');
        
        console.log('\n🎉 Demo data seeded successfully!');
        console.log('\n📋 Login Details:');
        console.log('   URL: yoursite.com/?tenant=demo');
        console.log('   Username: admin');
        console.log('   Password: admin123');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Seed error:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

seed();
