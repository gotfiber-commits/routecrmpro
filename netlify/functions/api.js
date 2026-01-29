// ============================================================
// RouteCRMPro - Netlify Functions API
// File: netlify/functions/api.js
// 
// This serverless function connects your React app to Neon PostgreSQL
// Uses Netlify's built-in Neon integration
// ============================================================

const { neon } = require('@neondatabase/serverless');

// Initialize Neon connection - Netlify provides NETLIFY_DATABASE_URL automatically
const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);

// CORS headers for browser requests
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
};

exports.handler = async (event, context) => {
    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const path = event.path.replace('/.netlify/functions/api', '');
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};

    try {
        // ============================================================
        // ROUTING
        // ============================================================
        
        // AUTH
        if (path === '/auth/login' && method === 'POST') {
            return await handleLogin(body);
        }

        // DISTRIBUTION CENTERS
        if (path === '/distribution-centers' && method === 'GET') {
            return await getDistributionCenters();
        }

        // TRUCKS
        if (path === '/trucks' && method === 'GET') {
            return await getTrucks(event.queryStringParameters);
        }

        // DRIVERS
        if (path === '/drivers' && method === 'GET') {
            return await getDrivers();
        }

        // CUSTOMERS
        if (path === '/customers' && method === 'GET') {
            return await getCustomers(event.queryStringParameters);
        }
        if (path === '/customers' && method === 'POST') {
            return await createCustomer(body);
        }

        // ORDERS
        if (path === '/orders' && method === 'GET') {
            return await getOrders(event.queryStringParameters);
        }
        if (path === '/orders' && method === 'POST') {
            return await createOrder(body);
        }

        // ROUTES
        if (path === '/routes' && method === 'GET') {
            return await getRoutes(event.queryStringParameters);
        }
        if (path === '/routes' && method === 'POST') {
            return await createRoute(body);
        }
        if (path.match(/\/routes\/[\w-]+\/stops/) && method === 'GET') {
            const routeId = path.split('/')[2];
            return await getRouteStops(routeId);
        }

        // PAYMENTS
        if (path === '/payments' && method === 'GET') {
            return await getPayments(event.queryStringParameters);
        }
        if (path === '/payments' && method === 'POST') {
            return await createPayment(body);
        }

        // PRODUCTS
        if (path === '/products' && method === 'GET') {
            return await getProducts();
        }

        // ALL DATA (for initial app load)
        if (path === '/data' && method === 'GET') {
            return await getAllData();
        }

        // 404
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Not found' })
        };

    } catch (error) {
        console.error('API Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// ============================================================
// HANDLER FUNCTIONS
// ============================================================

async function handleLogin({ username, password }) {
    const users = await sql`
        SELECT u.*, d.employee_id as driver_employee_id
        FROM users u
        LEFT JOIN drivers d ON u.driver_id = d.id
        WHERE u.username = ${username} AND u.password_hash = ${password}
    `;
    
    if (users.length === 0) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Invalid credentials' })
        };
    }

    const user = users[0];
    
    // Update last login
    await sql`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ${user.id}`;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            role: user.role,
            avatar: user.avatar,
            dcId: user.dc_id,
            driverId: user.driver_employee_id
        })
    };
}

async function getDistributionCenters() {
    const dcs = await sql`
        SELECT * FROM distribution_centers 
        WHERE status = 'active' 
        ORDER BY name
    `;
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(dcs.map(dc => ({
            id: dc.code,
            name: dc.name,
            address: dc.address,
            city: dc.city,
            state: dc.state,
            zipCode: dc.zip_code,
            lat: parseFloat(dc.lat),
            lng: parseFloat(dc.lng),
            phone: dc.phone,
            region: dc.region,
            capacity: dc.capacity
        })))
    };
}

async function getTrucks(params = {}) {
    const dcCode = params?.dc;
    
    let trucks;
    if (dcCode) {
        trucks = await sql`
            SELECT t.*, dc.code as dc_code
            FROM trucks t
            JOIN distribution_centers dc ON t.dc_id = dc.id
            WHERE dc.code = ${dcCode}
            ORDER BY t.name
        `;
    } else {
        trucks = await sql`
            SELECT t.*, dc.code as dc_code
            FROM trucks t
            JOIN distribution_centers dc ON t.dc_id = dc.id
            ORDER BY t.name
        `;
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(trucks.map(t => ({
            id: t.code,
            name: t.name,
            dcId: t.dc_code,
            capacity: t.capacity,
            status: t.status,
            currentLat: parseFloat(t.current_lat),
            currentLng: parseFloat(t.current_lng),
            speed: parseFloat(t.speed),
            lastUpdate: t.last_update,
            vin: t.vin,
            licensePlate: t.license_plate
        })))
    };
}

async function getDrivers() {
    const drivers = await sql`
        SELECT * FROM drivers WHERE status = 'active' ORDER BY last_name, first_name
    `;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(drivers.map(d => ({
            id: d.employee_id,
            name: `${d.first_name} ${d.last_name}`,
            firstName: d.first_name,
            lastName: d.last_name,
            email: d.email,
            phone: d.phone,
            status: d.status,
            licenseNumber: d.license_number,
            licenseClass: d.license_class,
            licenseState: d.license_state,
            licenseExpiration: d.license_expiration,
            hourlyRate: parseFloat(d.hourly_rate),
            overtimeRate: parseFloat(d.overtime_rate)
        })))
    };
}

async function getCustomers(params = {}) {
    const dcCode = params?.dc;
    const search = params?.search;
    const state = params?.state;
    
    let query = sql`
        SELECT c.*, dc.code as dc_code
        FROM customers c
        LEFT JOIN distribution_centers dc ON c.preferred_dc = dc.id
        WHERE c.status = 'active'
    `;

    // Note: For complex filtering, you'd build the query dynamically
    // This is simplified for the example
    const customers = await sql`
        SELECT c.*, dc.code as dc_code
        FROM customers c
        LEFT JOIN distribution_centers dc ON c.preferred_dc = dc.id
        WHERE c.status = 'active'
        ORDER BY c.name
        LIMIT 100
    `;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(customers.map(c => ({
            id: c.customer_code,
            storeId: c.store_id,
            name: c.name,
            contactPerson: c.contact_person,
            email: c.email,
            phone: c.phone,
            address: c.address,
            city: c.city,
            state: c.state,
            zipCode: c.zip_code,
            lat: parseFloat(c.lat),
            lng: parseFloat(c.lng),
            preferredDC: c.dc_code,
            accountType: c.account_type,
            accountBalance: parseFloat(c.account_balance || 0),
            totalOrders: c.total_orders,
            yearlyVolume: parseFloat(c.yearly_volume || 0),
            lastOrderDate: c.last_order_date
        })))
    };
}

async function getOrders(params = {}) {
    const orders = await sql`
        SELECT o.*, c.name as customer_name, c.customer_code, dc.code as dc_code
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        LEFT JOIN distribution_centers dc ON o.dc_id = dc.id
        ORDER BY o.delivery_date DESC, o.created_at DESC
        LIMIT 100
    `;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(orders.map(o => ({
            id: o.order_number,
            customerId: o.customer_code,
            customer: o.customer_name,
            address: o.delivery_address,
            lat: parseFloat(o.delivery_lat),
            lng: parseFloat(o.delivery_lng),
            deliveryDate: o.delivery_date,
            priority: o.priority,
            status: o.status,
            volume: o.total_volume,
            revenue: parseFloat(o.total_revenue),
            preferredDC: o.dc_code
        })))
    };
}

async function getRoutes(params = {}) {
    const routes = await sql`
        SELECT r.*, dc.code as dc_code, t.code as truck_code, d.employee_id as driver_code
        FROM routes r
        JOIN distribution_centers dc ON r.dc_id = dc.id
        LEFT JOIN trucks t ON r.truck_id = t.id
        LEFT JOIN drivers d ON r.driver_id = d.id
        ORDER BY r.route_date DESC
        LIMIT 50
    `;

    // Get stops for each route
    const routesWithStops = await Promise.all(routes.map(async (r) => {
        const stops = await sql`
            SELECT * FROM route_stops WHERE route_id = ${r.id} ORDER BY sequence
        `;
        
        return {
            id: r.route_number,
            dcId: r.dc_code,
            truckId: r.truck_code,
            driverId: r.driver_code,
            date: r.route_date,
            startTime: r.start_time,
            endTime: r.end_time,
            status: r.status,
            totalDistance: parseFloat(r.total_distance),
            totalDuration: r.total_duration,
            totalRevenue: parseFloat(r.total_revenue),
            totalCost: parseFloat(r.total_cost),
            initialLoad: r.initial_load,
            currentLoad: r.current_load,
            emptyPickups: r.empty_pickups,
            stops: stops.map(s => ({
                orderId: s.order_id,
                sequence: s.sequence,
                estimatedTime: s.estimated_time,
                actualTime: s.actual_arrival,
                completedTime: s.completed_time,
                duration: s.duration,
                distance: parseFloat(s.distance),
                status: s.status,
                delivered: s.delivered,
                emptiesCollected: s.empties_collected,
                signature: s.signature,
                notes: s.notes
            }))
        };
    }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(routesWithStops)
    };
}

async function getPayments(params = {}) {
    const payments = await sql`
        SELECT p.*, c.name as customer_name, c.customer_code
        FROM payments p
        JOIN customers c ON p.customer_id = c.id
        ORDER BY p.payment_date DESC
        LIMIT 100
    `;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(payments.map(p => ({
            id: p.payment_number,
            customerId: p.customer_code,
            customer: p.customer_name,
            orderId: p.order_id,
            amount: parseFloat(p.amount),
            method: p.method,
            cardType: p.card_type,
            cardLast4: p.card_last4,
            status: p.status,
            date: p.payment_date,
            signature: p.signature
        })))
    };
}

async function getProducts() {
    const products = await sql`SELECT * FROM products WHERE status = 'active' ORDER BY sku`;

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(products.map(p => ({
            id: p.sku,
            sku: p.sku,
            name: p.name,
            category: p.category,
            weight: parseFloat(p.weight_lbs),
            price: parseFloat(p.price),
            cost: parseFloat(p.cost)
        })))
    };
}

async function getAllData() {
    // Fetch all data needed for initial app load
    const [dcs, trucks, drivers, customers, orders, routes, products] = await Promise.all([
        sql`SELECT * FROM distribution_centers WHERE status = 'active'`,
        sql`SELECT t.*, dc.code as dc_code FROM trucks t JOIN distribution_centers dc ON t.dc_id = dc.id`,
        sql`SELECT * FROM drivers WHERE status = 'active'`,
        sql`SELECT c.*, dc.code as dc_code FROM customers c LEFT JOIN distribution_centers dc ON c.preferred_dc = dc.id WHERE c.status = 'active' LIMIT 100`,
        sql`SELECT o.*, c.name as customer_name, c.customer_code, dc.code as dc_code FROM orders o JOIN customers c ON o.customer_id = c.id LEFT JOIN distribution_centers dc ON o.dc_id = dc.id LIMIT 100`,
        sql`SELECT r.*, dc.code as dc_code, t.code as truck_code, d.employee_id as driver_code FROM routes r JOIN distribution_centers dc ON r.dc_id = dc.id LEFT JOIN trucks t ON r.truck_id = t.id LEFT JOIN drivers d ON r.driver_id = d.id LIMIT 50`,
        sql`SELECT * FROM products WHERE status = 'active'`
    ]);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            distributionCenters: dcs.map(dc => ({
                id: dc.code,
                name: dc.name,
                address: dc.address,
                city: dc.city,
                state: dc.state,
                zipCode: dc.zip_code,
                lat: parseFloat(dc.lat),
                lng: parseFloat(dc.lng),
                phone: dc.phone,
                region: dc.region,
                capacity: dc.capacity
            })),
            trucks: trucks.map(t => ({
                id: t.code,
                name: t.name,
                dcId: t.dc_code,
                capacity: t.capacity,
                status: t.status,
                currentLat: parseFloat(t.current_lat),
                currentLng: parseFloat(t.current_lng),
                speed: parseFloat(t.speed || 0),
                vin: t.vin,
                licensePlate: t.license_plate
            })),
            drivers: drivers.map(d => ({
                id: d.employee_id,
                name: `${d.first_name} ${d.last_name}`,
                firstName: d.first_name,
                lastName: d.last_name,
                email: d.email,
                phone: d.phone,
                status: d.status,
                licenseNumber: d.license_number,
                licenseClass: d.license_class,
                hourlyRate: parseFloat(d.hourly_rate || 0)
            })),
            customers: customers.map(c => ({
                id: c.customer_code,
                name: c.name,
                contactPerson: c.contact_person,
                email: c.email,
                phone: c.phone,
                address: c.address,
                city: c.city,
                state: c.state,
                lat: parseFloat(c.lat),
                lng: parseFloat(c.lng),
                preferredDC: c.dc_code,
                accountType: c.account_type
            })),
            orders: orders.map(o => ({
                id: o.order_number,
                customerId: o.customer_code,
                customer: o.customer_name,
                address: o.delivery_address,
                lat: parseFloat(o.delivery_lat || 0),
                lng: parseFloat(o.delivery_lng || 0),
                deliveryDate: o.delivery_date,
                priority: o.priority,
                status: o.status,
                volume: o.total_volume,
                revenue: parseFloat(o.total_revenue || 0),
                preferredDC: o.dc_code
            })),
            routes: routes.map(r => ({
                id: r.route_number,
                dcId: r.dc_code,
                truckId: r.truck_code,
                driverId: r.driver_code,
                date: r.route_date,
                status: r.status,
                totalDistance: parseFloat(r.total_distance || 0),
                totalRevenue: parseFloat(r.total_revenue || 0),
                stops: []
            })),
            products: products.map(p => ({
                id: p.sku,
                sku: p.sku,
                name: p.name,
                price: parseFloat(p.price),
                cost: parseFloat(p.cost)
            }))
        })
    };
}

// ============================================================
// CREATE FUNCTIONS
// ============================================================

async function createCustomer(data) {
    const result = await sql`
        INSERT INTO customers (customer_code, name, contact_person, email, phone, address, city, state, zip_code, lat, lng, account_type)
        VALUES (${data.customerCode}, ${data.name}, ${data.contactPerson}, ${data.email}, ${data.phone}, ${data.address}, ${data.city}, ${data.state}, ${data.zipCode}, ${data.lat}, ${data.lng}, ${data.accountType})
        RETURNING *
    `;
    
    return {
        statusCode: 201,
        headers,
        body: JSON.stringify(result[0])
    };
}

async function createOrder(data) {
    const result = await sql`
        INSERT INTO orders (order_number, customer_id, delivery_address, delivery_lat, delivery_lng, delivery_date, priority, status, total_volume, total_revenue)
        SELECT ${data.orderNumber}, id, ${data.address}, ${data.lat}, ${data.lng}, ${data.deliveryDate}, ${data.priority}, 'pending', ${data.volume}, ${data.revenue}
        FROM customers WHERE customer_code = ${data.customerId}
        RETURNING *
    `;
    
    return {
        statusCode: 201,
        headers,
        body: JSON.stringify(result[0])
    };
}

async function createRoute(data) {
    const result = await sql`
        INSERT INTO routes (route_number, dc_id, truck_id, driver_id, route_date, start_time, status)
        SELECT ${data.routeNumber}, dc.id, t.id, d.id, ${data.date}, ${data.startTime}, 'planned'
        FROM distribution_centers dc
        LEFT JOIN trucks t ON t.code = ${data.truckId}
        LEFT JOIN drivers d ON d.employee_id = ${data.driverId}
        WHERE dc.code = ${data.dcId}
        RETURNING *
    `;
    
    return {
        statusCode: 201,
        headers,
        body: JSON.stringify(result[0])
    };
}

async function createPayment(data) {
    const result = await sql`
        INSERT INTO payments (payment_number, customer_id, order_id, amount, method, card_type, card_last4, status, signature)
        SELECT ${data.paymentNumber}, c.id, ${data.orderId}, ${data.amount}, ${data.method}, ${data.cardType}, ${data.cardLast4}, 'completed', ${data.signature}
        FROM customers c WHERE c.customer_code = ${data.customerId}
        RETURNING *
    `;
    
    return {
        statusCode: 201,
        headers,
        body: JSON.stringify(result[0])
    };
}

async function getRouteStops(routeId) {
    const stops = await sql`
        SELECT rs.*, o.order_number
        FROM route_stops rs
        JOIN routes r ON rs.route_id = r.id
        LEFT JOIN orders o ON rs.order_id = o.id
        WHERE r.route_number = ${routeId}
        ORDER BY rs.sequence
    `;
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(stops)
    };
}
