// Database Seed Script - Creates a demo company with sample data
// Usage: DATABASE_URL=your_connection_string node scripts/seed-db.js

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function seed() {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.error('❌ DATABASE_URL environment variable is required');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    try {
        console.log('🔌 Connecting to database...');
        const client = await pool.connect();
        
        console.log('🏢 Creating demo company...');
        
        // Create demo company
        const companyResult = await client.query(`
            INSERT INTO companies (name, subdomain, email, phone, city, state, plan, status)
            VALUES ('Demo Propane Co', 'demo', 'demo@routecrmpro.com', '555-123-4567', 'Atlanta', 'GA', 'professional', 'active')
            ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
        `);
        const companyId = companyResult.rows[0].id;
        console.log('   Company ID:', companyId);

        // Create users
        console.log('👥 Creating users...');
        const passwordHash = await bcrypt.hash('demo123', 10);
        
        const users = [
            { username: 'admin', name: 'Admin User', role: 'admin', avatar: '👨‍💼' },
            { username: 'dispatch', name: 'Dispatch Manager', role: 'dispatch', avatar: '📋' },
            { username: 'driver1', name: 'John Driver', role: 'driver', avatar: '🚚' },
            { username: 'accounting', name: 'Jane Accountant', role: 'accounting', avatar: '💰' }
        ];

        for (const user of users) {
            await client.query(`
                INSERT INTO users (company_id, username, email, password_hash, name, role, avatar)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (company_id, username) DO NOTHING
            `, [companyId, user.username, `${user.username}@demo.com`, passwordHash, user.name, user.role, user.avatar]);
        }

        // Create distribution centers
        console.log('🏭 Creating distribution centers...');
        const dcs = [
            { code: 'DC-ATL-001', name: 'Atlanta Main Hub', city: 'Atlanta', state: 'GA', lat: 33.7490, lng: -84.3880 },
            { code: 'DC-BHM-001', name: 'Birmingham Center', city: 'Birmingham', state: 'AL', lat: 33.5207, lng: -86.8025 },
            { code: 'DC-NSH-001', name: 'Nashville Depot', city: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816 }
        ];

        const dcIds = [];
        for (const dc of dcs) {
            const result = await client.query(`
                INSERT INTO distribution_centers (company_id, code, name, city, state, lat, lng, capacity_gallons)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 75000)
                ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
            `, [companyId, dc.code, dc.name, dc.city, dc.state, dc.lat, dc.lng]);
            dcIds.push(result.rows[0].id);
        }

        // Create trucks
        console.log('🚚 Creating trucks...');
        const trucks = [
            { code: 'TRK-001', name: 'Truck Alpha', capacity: 3000 },
            { code: 'TRK-002', name: 'Truck Bravo', capacity: 3500 },
            { code: 'TRK-003', name: 'Truck Charlie', capacity: 2500 },
            { code: 'TRK-004', name: 'Truck Delta', capacity: 4000 }
        ];

        for (let i = 0; i < trucks.length; i++) {
            const truck = trucks[i];
            const dcId = dcIds[i % dcIds.length];
            await client.query(`
                INSERT INTO trucks (company_id, dc_id, code, name, capacity_gallons, make, model, year)
                VALUES ($1, $2, $3, $4, $5, 'Freightliner', 'M2 106', 2022)
                ON CONFLICT (company_id, code) DO NOTHING
            `, [companyId, dcId, truck.code, truck.name, truck.capacity]);
        }

        // Create drivers
        console.log('👷 Creating drivers...');
        const drivers = [
            { code: 'DRV-001', name: 'Mike Johnson', phone: '555-0101' },
            { code: 'DRV-002', name: 'Sarah Williams', phone: '555-0102' },
            { code: 'DRV-003', name: 'Tom Brown', phone: '555-0103' },
            { code: 'DRV-004', name: 'Lisa Davis', phone: '555-0104' }
        ];

        for (let i = 0; i < drivers.length; i++) {
            const driver = drivers[i];
            const dcId = dcIds[i % dcIds.length];
            await client.query(`
                INSERT INTO drivers (company_id, dc_id, code, name, phone, license_number, license_state, hazmat_certified, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'GA', true, 'active')
                ON CONFLICT (company_id, code) DO NOTHING
            `, [companyId, dcId, driver.code, driver.name, driver.phone, `CDL${Math.random().toString().slice(2, 10)}`]);
        }

        // Create customers
        console.log('👥 Creating customers...');
        const customerData = [
            { name: 'Riverside Farm', city: 'Marietta', state: 'GA', lat: 33.9526, lng: -84.5499, type: 'commercial' },
            { name: 'Johnson Residence', city: 'Decatur', state: 'GA', lat: 33.7748, lng: -84.2963, type: 'residential' },
            { name: 'Smith Family Home', city: 'Alpharetta', state: 'GA', lat: 34.0754, lng: -84.2941, type: 'residential' },
            { name: 'Mountain View Ranch', city: 'Canton', state: 'GA', lat: 34.2368, lng: -84.4908, type: 'commercial' },
            { name: 'Lakeside Restaurant', city: 'Roswell', state: 'GA', lat: 34.0232, lng: -84.3616, type: 'commercial' },
            { name: 'Pine Grove Estates', city: 'Kennesaw', state: 'GA', lat: 34.0234, lng: -84.6155, type: 'residential' },
            { name: 'Thompson Industries', city: 'Smyrna', state: 'GA', lat: 33.8839, lng: -84.5144, type: 'industrial' },
            { name: 'Green Valley Farms', city: 'Cumming', state: 'GA', lat: 34.2073, lng: -84.1402, type: 'commercial' },
            { name: 'Roberts Home', city: 'Johns Creek', state: 'GA', lat: 34.0289, lng: -84.1989, type: 'residential' },
            { name: 'Hilltop Medical Center', city: 'Lawrenceville', state: 'GA', lat: 33.9562, lng: -83.9879, type: 'commercial' }
        ];

        const customerIds = [];
        for (let i = 0; i < customerData.length; i++) {
            const cust = customerData[i];
            const dcId = dcIds[i % dcIds.length];
            const code = `CUST-${String(i + 1).padStart(3, '0')}`;
            
            const result = await client.query(`
                INSERT INTO customers (company_id, preferred_dc_id, code, name, city, state, lat, lng, customer_type, tank_size, price_per_gallon, address, phone)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 2.49, $11, $12)
                ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
            `, [companyId, dcId, code, cust.name, cust.city, cust.state, cust.lat, cust.lng, cust.type, 
                cust.type === 'industrial' ? 1000 : cust.type === 'commercial' ? 500 : 250,
                `${Math.floor(Math.random() * 9000) + 1000} Main Street`,
                `555-${String(Math.floor(Math.random() * 9000) + 1000)}`]);
            customerIds.push(result.rows[0].id);
        }

        // Create some orders
        console.log('📦 Creating orders...');
        const statuses = ['pending', 'scheduled', 'delivered'];
        
        for (let i = 0; i < 15; i++) {
            const customerId = customerIds[i % customerIds.length];
            const dcId = dcIds[i % dcIds.length];
            const status = statuses[i % statuses.length];
            const gallons = Math.floor(Math.random() * 200) + 100;
            const orderNum = `ORD-${Date.now().toString(36).toUpperCase()}-${i}`;
            
            await client.query(`
                INSERT INTO orders (company_id, customer_id, dc_id, order_number, gallons_requested, price_per_gallon, total_amount, status, priority, requested_date, scheduled_date)
                VALUES ($1, $2, $3, $4, $5, 2.49, $6, $7, 'normal', CURRENT_DATE, CURRENT_DATE + $8)
                ON CONFLICT DO NOTHING
            `, [companyId, customerId, dcId, orderNum, gallons, gallons * 2.49, status, i % 7]);
        }

        console.log('');
        console.log('✅ Demo data created successfully!');
        console.log('');
        console.log('📋 Demo Company Login:');
        console.log('   URL: https://demo.routecrmpro.com (or use ?tenant=demo)');
        console.log('   Username: admin');
        console.log('   Password: demo123');
        console.log('');
        console.log('   Other users: dispatch, driver1, accounting (all use demo123)');

        client.release();
    } catch (error) {
        console.error('❌ Seed failed:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

seed();
