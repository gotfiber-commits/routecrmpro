// Main Data API - Tenant CRUD operations
const { query, transaction } = require('./utils/db');
const { requireAuth, requireRole } = require('./utils/auth');
const { success, error, handleOptions, parseBody, getPagination, paginatedResponse } = require('./utils/response');

exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    // Require authentication
    const authResult = requireAuth(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const user = authResult.user;
    const { companyId, role } = user;
    
    const path = event.path.replace('/.netlify/functions/data', '');
    const method = event.httpMethod;

    try {
        // GET /data - Get all data (dashboard)
        if (method === 'GET' && path === '') {
            return await getAllData(companyId, user);
        }

        // Distribution Centers
        if (path.startsWith('/distribution-centers')) {
            return await handleDistributionCenters(method, path, companyId, user, event);
        }

        // Trucks
        if (path.startsWith('/trucks')) {
            return await handleTrucks(method, path, companyId, user, event);
        }

        // Drivers
        if (path.startsWith('/drivers')) {
            return await handleDrivers(method, path, companyId, user, event);
        }

        // Customers
        if (path.startsWith('/customers')) {
            return await handleCustomers(method, path, companyId, user, event);
        }

        // Orders
        if (path.startsWith('/orders')) {
            return await handleOrders(method, path, companyId, user, event);
        }

        // Routes
        if (path.startsWith('/routes')) {
            return await handleRoutes(method, path, companyId, user, event);
        }

        // Users (admin only)
        if (path.startsWith('/users')) {
            if (role !== 'admin') {
                return error('Admin access required', 403);
            }
            return await handleUsers(method, path, companyId, event);
        }

        // Company Settings (admin only)
        if (path === '/company-settings' && method === 'PUT') {
            if (role !== 'admin') {
                return error('Admin access required', 403);
            }
            const body = parseBody(event);
            
            // First, try to add the columns if they don't exist
            try {
                await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20) DEFAULT 'gallons'`);
                await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_empties BOOLEAN DEFAULT false`);
                await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_truck_inventory BOOLEAN DEFAULT false`);
            } catch (alterErr) {
                console.log('Columns may already exist or cannot be added:', alterErr.message);
            }
            
            // Now update the settings
            try {
                await query(
                    `UPDATE companies SET 
                        delivery_model = $1,
                        track_empties = $2,
                        track_truck_inventory = $3,
                        updated_at = NOW()
                     WHERE id = $4`,
                    [
                        body.delivery_model || 'gallons',
                        body.track_empties || false,
                        body.track_truck_inventory || false,
                        companyId
                    ]
                );
                return success({ message: 'Settings saved' });
            } catch (updateErr) {
                return error('Failed to save settings. Please run the database migration first.', 500);
            }
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Data API error:', err);
        // Include more details in error message for debugging
        const errMsg = err.message || 'Unknown error';
        return error(`Internal server error: ${errMsg}`, 500);
    }
};

// =====================================================
// GET ALL DATA (Dashboard)
// =====================================================

async function getAllData(companyId, user) {
    // Build DC filter based on user's access
    let dcFilter = '';
    const params = [companyId];
    
    if (user.dcId) {
        dcFilter = ' AND dc_id = $2';
        params.push(user.dcId);
    }

    const [dcs, trucks, drivers, customers, orders, routes, activeRoutes] = await Promise.all([
        query('SELECT * FROM distribution_centers WHERE company_id = $1 ORDER BY name', [companyId]),
        query(`SELECT t.*, dc.name as dc_name, d.name as driver_name
               FROM trucks t
               LEFT JOIN distribution_centers dc ON t.dc_id = dc.id
               LEFT JOIN drivers d ON t.assigned_driver_id = d.id
               WHERE t.company_id = $1${user.dcId ? ' AND t.dc_id = $2' : ''} 
               ORDER BY t.code`, params),
        query(`SELECT * FROM drivers WHERE company_id = $1${user.dcId ? ' AND dc_id = $2' : ''} ORDER BY name`, params),
        query(`SELECT * FROM customers WHERE company_id = $1${user.dcId ? ' AND preferred_dc_id = $2' : ''} ORDER BY name`, params),
        query(`SELECT o.*, c.name as customer_name, c.address as customer_address, c.city as customer_city, c.lat, c.lng
               FROM orders o 
               JOIN customers c ON o.customer_id = c.id 
               WHERE o.company_id = $1${user.dcId ? ' AND o.dc_id = $2' : ''} 
               ORDER BY o.created_at DESC LIMIT 100`, params),
        query(`SELECT r.*, d.name as driver_name, t.name as truck_name
               FROM routes r
               LEFT JOIN drivers d ON r.driver_id = d.id
               LEFT JOIN trucks t ON r.truck_id = t.id
               WHERE r.company_id = $1${user.dcId ? ' AND r.dc_id = $2' : ''}
               ORDER BY r.scheduled_date DESC LIMIT 50`, params),
        // Active routes from route_runs table
        query(`SELECT rr.*, dc.name as dc_name, d.name as driver_name, t.name as truck_name, t.code as truck_code
               FROM route_runs rr
               LEFT JOIN distribution_centers dc ON rr.dc_id = dc.id
               LEFT JOIN drivers d ON rr.driver_id = d.id
               LEFT JOIN trucks t ON rr.truck_id = t.id
               WHERE rr.company_id = $1 AND rr.status IN ('scheduled', 'in_progress')
               ${user.dcId ? ' AND rr.dc_id = $2' : ''}
               ORDER BY rr.scheduled_date DESC, rr.created_at DESC LIMIT 50`, params)
    ]);

    return success({
        distributionCenters: dcs.rows,
        trucks: trucks.rows,
        drivers: drivers.rows,
        customers: customers.rows,
        orders: orders.rows,
        routes: routes.rows,
        activeRoutes: activeRoutes.rows
    });
}

// =====================================================
// DISTRIBUTION CENTERS
// =====================================================

async function handleDistributionCenters(method, path, companyId, user, event) {
    const subPath = path.replace('/distribution-centers', '');

    if (method === 'GET' && subPath === '') {
        const result = await query(
            'SELECT * FROM distribution_centers WHERE company_id = $1 ORDER BY name',
            [companyId]
        );
        return success(result.rows);
    }

    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const result = await query(
            'SELECT * FROM distribution_centers WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const body = parseBody(event);
        const result = await query(
            `INSERT INTO distribution_centers (company_id, code, name, address, city, state, zip, phone, lat, lng, manager_name, capacity_gallons)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [companyId, body.code, body.name, body.address, body.city, body.state, body.zip, body.phone, body.lat, body.lng, body.manager_name, body.capacity_gallons || 50000]
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE distribution_centers SET code = $1, name = $2, address = $3, city = $4, state = $5, zip = $6, phone = $7, lat = $8, lng = $9, manager_name = $10, capacity_gallons = $11, status = $12
            WHERE id = $13 AND company_id = $14 RETURNING *`,
            [body.code, body.name, body.address, body.city, body.state, body.zip, body.phone, body.lat, body.lng, body.manager_name, body.capacity_gallons, body.status || 'active', id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        await query('DELETE FROM distribution_centers WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    return error('Not found', 404);
}

// =====================================================
// TRUCKS
// =====================================================

async function handleTrucks(method, path, companyId, user, event) {
    const subPath = path.replace('/trucks', '');

    if (method === 'GET' && subPath === '') {
        let sql = 'SELECT t.*, dc.name as dc_name, d.name as assigned_driver_name FROM trucks t LEFT JOIN distribution_centers dc ON t.dc_id = dc.id LEFT JOIN drivers d ON t.assigned_driver_id = d.id WHERE t.company_id = $1';
        const params = [companyId];
        if (user.dcId) {
            sql += ' AND t.dc_id = $2';
            params.push(user.dcId);
        }
        sql += ' ORDER BY t.code';
        const result = await query(sql, params);
        return success(result.rows);
    }

    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const result = await query(
            'SELECT t.*, dc.name as dc_name, d.name as assigned_driver_name FROM trucks t LEFT JOIN distribution_centers dc ON t.dc_id = dc.id LEFT JOIN drivers d ON t.assigned_driver_id = d.id WHERE t.id = $1 AND t.company_id = $2',
            [id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const body = parseBody(event);
        
        // Helper to parse integers safely
        const toInt = (v) => v ? parseInt(v, 10) || null : null;
        const toFloat = (v) => v ? parseFloat(v) || null : null;
        // Helper to convert empty strings to null (for dates and strings)
        const toVal = (v) => v && v.toString().trim() !== '' ? v : null;
        
        // Start with base columns that always exist
        let columns = [
            'company_id', 'dc_id', 'code', 'name', 'make', 'model', 'year', 'vin', 'license_plate',
            'capacity_gallons', 'mpg', 'current_lat', 'current_lng', 'status'
        ];
        let values = [
            companyId, toVal(body.dc_id), body.code, body.name, toVal(body.make), toVal(body.model), toInt(body.year), toVal(body.vin), toVal(body.license_plate),
            toInt(body.capacity_gallons) || 3000, toFloat(body.mpg) || 8, toFloat(body.current_lat), toFloat(body.current_lng), body.status || 'active'
        ];

        // Try to add enhanced columns if they exist (from enhanced-profiles.sql)
        const enhancedColumns = {
            'assigned_driver_id': toVal(body.assigned_driver_id),
            'empty_weight': toInt(body.empty_weight),
            'gvwr': toInt(body.gvwr),
            'gcwr': toInt(body.gcwr),
            'max_payload': toInt(body.max_payload),
            'front_axle_weight': toInt(body.front_axle_weight),
            'rear_axle_weight': toInt(body.rear_axle_weight),
            'axle_configuration': toVal(body.axle_configuration),
            'tank_capacity_gallons': toInt(body.tank_capacity_gallons),
            'tank_material': toVal(body.tank_material),
            'tank_last_inspection': toVal(body.tank_last_inspection),
            'tank_next_inspection': toVal(body.tank_next_inspection),
            'tank_certification': toVal(body.tank_certification),
            'tank_manufacturer': toVal(body.tank_manufacturer),
            'tank_serial_number': toVal(body.tank_serial_number),
            'tank_manufacture_date': toVal(body.tank_manufacture_date),
            'working_pressure_psi': toInt(body.working_pressure_psi),
            'product_type': body.product_type || 'propane',
            'product_weight_per_gallon': toFloat(body.product_weight_per_gallon) || 4.2,
            'fuel_tank_capacity': toInt(body.fuel_tank_capacity),
            'fuel_type': body.fuel_type || 'diesel',
            'diesel_weight_per_gallon': toFloat(body.diesel_weight_per_gallon) || 7.1,
            'avg_mpg': toFloat(body.avg_mpg),
            'cost_per_mile': toFloat(body.cost_per_mile),
            'def_tank_capacity': toInt(body.def_tank_capacity),
            'has_pump': body.has_pump !== false,
            'pump_type': toVal(body.pump_type),
            'meter_type': toVal(body.meter_type),
            'meter_serial_number': toVal(body.meter_serial_number),
            'meter_last_calibration': toVal(body.meter_last_calibration),
            'meter_next_calibration': toVal(body.meter_next_calibration),
            'dot_number': toVal(body.dot_number),
            'mc_number': toVal(body.mc_number),
            'registration_number': toVal(body.registration_number),
            'registration_state': toVal(body.registration_state),
            'registration_expiration': toVal(body.registration_expiration) || toVal(body.registration_expiry),
            'last_dot_inspection': toVal(body.last_dot_inspection),
            'next_dot_inspection': toVal(body.next_dot_inspection),
            'dot_inspection_status': toVal(body.dot_inspection_status),
            'inspection_decal_number': toVal(body.inspection_decal_number),
            'ifta_account': toVal(body.ifta_account),
            'irp_account': toVal(body.irp_account),
            'insurance_policy_number': toVal(body.insurance_policy_number),
            'insurance_provider': toVal(body.insurance_provider),
            'insurance_expiration': toVal(body.insurance_expiration),
            'liability_coverage': toFloat(body.liability_coverage),
            'cargo_coverage': toFloat(body.cargo_coverage),
            'last_oil_change': toVal(body.last_oil_change),
            'last_oil_change_miles': toInt(body.last_oil_change_miles),
            'next_oil_change_miles': toInt(body.next_oil_change_miles),
            'oil_change_interval_miles': toInt(body.oil_change_interval_miles) || 15000,
            'last_service_date': toVal(body.last_service_date),
            'last_service_mileage': toInt(body.last_service_mileage),
            'next_service_date': toVal(body.next_service_date),
            'next_service_mileage': toInt(body.next_service_mileage),
            'current_odometer': toInt(body.current_odometer) || toInt(body.odometer),
            'total_hours': toInt(body.total_hours),
            'tire_size': toVal(body.tire_size),
            'tire_type': toVal(body.tire_type),
            'tire_last_replaced': toVal(body.tire_last_replaced),
            'telematics_device_id': toVal(body.telematics_device_id),
            'telematics_provider': toVal(body.telematics_provider),
            'has_lift_gate': body.has_lift_gate || false,
            'has_pto_pump': body.has_pto_pump || false,
            'has_gps_tracker': body.has_gps_tracker !== false,
            'has_dash_cam': body.has_dash_cam || false,
            'has_eld': body.has_eld !== false,
            'eld_provider': toVal(body.eld_provider),
            'eld_serial_number': toVal(body.eld_serial_number),
            'purchase_date': toVal(body.purchase_date),
            'purchase_price': toFloat(body.purchase_price),
            'current_value': toFloat(body.current_value),
            'monthly_payment': toFloat(body.monthly_payment),
            'monthly_insurance': toFloat(body.monthly_insurance),
            'notes': toVal(body.notes)
        };

        // Check which enhanced columns exist and add them
        try {
            const colCheck = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trucks' AND table_schema = 'public'`);
            const existingCols = colCheck.rows.map(r => r.column_name);
            
            for (const [col, val] of Object.entries(enhancedColumns)) {
                if (existingCols.includes(col)) {
                    columns.push(col);
                    values.push(val);
                }
            }
        } catch (e) {
            // If column check fails, just use base columns
            console.log('Enhanced columns check failed, using base columns only');
        }

        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        try {
            const result = await query(
                `INSERT INTO trucks (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                values
            );
            return success(result.rows[0], 201);
        } catch (dbErr) {
            console.error('Truck INSERT error:', dbErr);
            if (dbErr.code === '23505') {
                return error('A truck with this code already exists', 400);
            }
            if (dbErr.code === '42703') {
                return error('Database schema outdated. Please run FULL_MIGRATION.sql in your Neon database.', 500);
            }
            return error(`Failed to create truck: ${dbErr.message}`, 500);
        }
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        
        // Helper to convert empty strings to null (for dates and strings)
        const toVal = (v) => v && v.toString().trim() !== '' ? v : null;
        
        // Start with base columns that always exist
        let updates = [];
        let values = [];
        let paramIndex = 1;

        const baseFields = {
            'code': body.code,
            'dc_id': toVal(body.dc_id),
            'name': body.name,
            'make': toVal(body.make),
            'model': toVal(body.model),
            'year': toVal(body.year),
            'vin': toVal(body.vin),
            'license_plate': toVal(body.license_plate),
            'capacity_gallons': toVal(body.capacity_gallons),
            'mpg': toVal(body.mpg),
            'current_lat': toVal(body.current_lat),
            'current_lng': toVal(body.current_lng),
            'status': body.status || 'active'
        };

        for (const [col, val] of Object.entries(baseFields)) {
            updates.push(`${col} = $${paramIndex}`);
            values.push(val);
            paramIndex++;
        }

        // Enhanced columns that may or may not exist
        const enhancedFields = {
            'assigned_driver_id': toVal(body.assigned_driver_id),
            'empty_weight': toVal(body.empty_weight),
            'gvwr': toVal(body.gvwr),
            'gcwr': toVal(body.gcwr),
            'max_payload': toVal(body.max_payload),
            'front_axle_weight': toVal(body.front_axle_weight),
            'rear_axle_weight': toVal(body.rear_axle_weight),
            'axle_configuration': toVal(body.axle_configuration),
            'tank_capacity_gallons': toVal(body.tank_capacity_gallons),
            'tank_material': toVal(body.tank_material),
            'tank_last_inspection': toVal(body.tank_last_inspection),
            'tank_next_inspection': toVal(body.tank_next_inspection),
            'tank_certification': toVal(body.tank_certification),
            'tank_manufacturer': toVal(body.tank_manufacturer),
            'tank_serial_number': toVal(body.tank_serial_number),
            'tank_manufacture_date': toVal(body.tank_manufacture_date),
            'working_pressure_psi': toVal(body.working_pressure_psi),
            'product_type': toVal(body.product_type),
            'product_weight_per_gallon': toVal(body.product_weight_per_gallon),
            'fuel_tank_capacity': toVal(body.fuel_tank_capacity),
            'fuel_type': toVal(body.fuel_type),
            'diesel_weight_per_gallon': toVal(body.diesel_weight_per_gallon),
            'avg_mpg': toVal(body.avg_mpg),
            'cost_per_mile': toVal(body.cost_per_mile),
            'def_tank_capacity': toVal(body.def_tank_capacity),
            'has_pump': body.has_pump,
            'pump_type': toVal(body.pump_type),
            'meter_type': toVal(body.meter_type),
            'meter_serial_number': toVal(body.meter_serial_number),
            'meter_last_calibration': toVal(body.meter_last_calibration),
            'meter_next_calibration': toVal(body.meter_next_calibration),
            'dot_number': toVal(body.dot_number),
            'mc_number': toVal(body.mc_number),
            'registration_number': toVal(body.registration_number),
            'registration_state': toVal(body.registration_state),
            'registration_expiration': toVal(body.registration_expiration) || toVal(body.registration_expiry),
            'last_dot_inspection': toVal(body.last_dot_inspection),
            'next_dot_inspection': toVal(body.next_dot_inspection),
            'dot_inspection_status': toVal(body.dot_inspection_status),
            'inspection_decal_number': toVal(body.inspection_decal_number),
            'ifta_account': toVal(body.ifta_account),
            'irp_account': toVal(body.irp_account),
            'insurance_policy_number': toVal(body.insurance_policy_number),
            'insurance_provider': toVal(body.insurance_provider),
            'insurance_expiration': toVal(body.insurance_expiration),
            'liability_coverage': toVal(body.liability_coverage),
            'cargo_coverage': toVal(body.cargo_coverage),
            'last_oil_change': toVal(body.last_oil_change),
            'last_oil_change_miles': toVal(body.last_oil_change_miles),
            'next_oil_change_miles': toVal(body.next_oil_change_miles),
            'oil_change_interval_miles': toVal(body.oil_change_interval_miles),
            'last_service_date': toVal(body.last_service_date),
            'last_service_mileage': toVal(body.last_service_mileage),
            'next_service_date': toVal(body.next_service_date),
            'next_service_mileage': toVal(body.next_service_mileage),
            'current_odometer': toVal(body.current_odometer) || toVal(body.odometer),
            'total_hours': toVal(body.total_hours),
            'tire_size': toVal(body.tire_size),
            'tire_type': toVal(body.tire_type),
            'tire_last_replaced': toVal(body.tire_last_replaced),
            'telematics_device_id': toVal(body.telematics_device_id),
            'telematics_provider': toVal(body.telematics_provider),
            'has_lift_gate': body.has_lift_gate,
            'has_pto_pump': body.has_pto_pump,
            'has_gps_tracker': body.has_gps_tracker,
            'has_dash_cam': body.has_dash_cam,
            'has_eld': body.has_eld,
            'eld_provider': toVal(body.eld_provider),
            'eld_serial_number': toVal(body.eld_serial_number),
            'purchase_date': toVal(body.purchase_date),
            'purchase_price': toVal(body.purchase_price),
            'current_value': toVal(body.current_value),
            'monthly_payment': toVal(body.monthly_payment),
            'monthly_insurance': toVal(body.monthly_insurance),
            'notes': toVal(body.notes)
        };

        // Check which enhanced columns exist
        try {
            const colCheck = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trucks' AND table_schema = 'public'`);
            const existingCols = colCheck.rows.map(r => r.column_name);
            
            for (const [col, val] of Object.entries(enhancedFields)) {
                if (existingCols.includes(col)) {
                    updates.push(`${col} = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }
            }
        } catch (e) {
            console.log('Enhanced columns check failed');
        }

        values.push(id);
        values.push(companyId);

        try {
            const result = await query(
                `UPDATE trucks SET ${updates.join(', ')} WHERE id = $${paramIndex} AND company_id = $${paramIndex + 1} RETURNING *`,
                values
            );
            if (result.rows.length === 0) return error('Not found', 404);
            return success(result.rows[0]);
        } catch (dbErr) {
            console.error('Truck UPDATE error:', dbErr);
            if (dbErr.code === '23505') {
                return error('A truck with this code already exists', 400);
            }
            if (dbErr.code === '42703') {
                return error('Database schema outdated. Please run FULL_MIGRATION.sql in your Neon database.', 500);
            }
            return error(`Failed to update truck: ${dbErr.message}`, 500);
        }
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        await query('DELETE FROM trucks WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    // PUT /trucks/:id/gps - Update GPS location
    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+\/gps$/)) {
        const id = subPath.split('/')[1];
        const body = parseBody(event);
        const result = await query(
            `UPDATE trucks SET current_lat = $1, current_lng = $2, speed = $3, heading = $4, last_gps_update = CURRENT_TIMESTAMP
            WHERE id = $5 AND company_id = $6 RETURNING *`,
            [body.lat, body.lng, body.speed || 0, body.heading || 0, id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    // GET /trucks/:id/load-capacity - Calculate load capacity based on current fuel and product
    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+\/load-capacity$/)) {
        const id = subPath.split('/')[1];
        const result = await query('SELECT * FROM trucks WHERE id = $1 AND company_id = $2', [id, companyId]);
        if (result.rows.length === 0) return error('Not found', 404);
        
        const truck = result.rows[0];
        const emptyWeight = truck.empty_weight || 0;
        const gvwr = truck.gvwr || 26000;
        const fuelGallons = truck.current_fuel_gallons || (truck.fuel_tank_capacity || 100);
        const dieselWeight = fuelGallons * (truck.diesel_weight_per_gallon || 7.1);
        const productWeightPerGal = truck.product_weight_per_gallon || 4.2;
        const tankCapacity = truck.capacity_gallons || 3000;
        
        const availablePayload = gvwr - emptyWeight - dieselWeight;
        const maxProductGallons = Math.floor(availablePayload / productWeightPerGal);
        const safLoadGallons = Math.min(maxProductGallons, tankCapacity);
        
        return success({
            truck_id: id,
            empty_weight: emptyWeight,
            gvwr: gvwr,
            fuel_weight: Math.round(dieselWeight),
            available_payload: Math.round(availablePayload),
            product_weight_per_gallon: productWeightPerGal,
            tank_capacity: tankCapacity,
            max_safe_load_gallons: safLoadGallons,
            max_product_weight: Math.round(safLoadGallons * productWeightPerGal),
            total_loaded_weight: Math.round(emptyWeight + dieselWeight + (safLoadGallons * productWeightPerGal))
        });
    }

    return error('Not found', 404);
}

// =====================================================
// DRIVERS
// =====================================================

async function handleDrivers(method, path, companyId, user, event) {
    const subPath = path.replace('/drivers', '');

    if (method === 'GET' && subPath === '') {
        let sql = 'SELECT d.*, dc.name as dc_name FROM drivers d LEFT JOIN distribution_centers dc ON d.dc_id = dc.id WHERE d.company_id = $1';
        const params = [companyId];
        if (user.dcId) {
            sql += ' AND d.dc_id = $2';
            params.push(user.dcId);
        }
        sql += ' ORDER BY d.name';
        const result = await query(sql, params);
        return success(result.rows);
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const body = parseBody(event);
        
        // Validate required fields
        if (!body.code || !body.name) {
            return error('Driver code and name are required', 400);
        }
        
        // Helper to convert empty strings to null for dates
        const toDate = (val) => (val && typeof val === 'string' && val.trim() !== '') ? val : null;
        const toNum = (val, def = null) => (val !== undefined && val !== null && val !== '') ? val : def;
        const toStr = (val) => (val && typeof val === 'string' && val.trim() !== '') ? val : null;
        
        try {
            const result = await query(
                `INSERT INTO drivers (
                    company_id, dc_id, code, name, email, phone, 
                    license_number, license_state, license_expiry, cdl_class, cdl_number, cdl_state, cdl_endorsements,
                    hazmat_certified, hazmat_endorsed, hazmat_expiration, tanker_endorsed, twic_card, twic_expiration,
                    hire_date, hourly_rate, overtime_rate, per_diem, pay_type, years_experience, date_of_birth,
                    medical_card_expiration, medical_examiner_name, medical_exam_date,
                    background_check_date, background_check_status, drug_test_date, drug_test_status, drug_test_type, mvr_check_date, mvr_status,
                    propane_certified, propane_cert_expiration, defensive_driving_cert, smith_system_trained, last_training_date,
                    emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
                    address, city, state, zip, notes, status
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, $18, $19,
                    $20, $21, $22, $23, $24, $25, $26,
                    $27, $28, $29,
                    $30, $31, $32, $33, $34, $35, $36,
                    $37, $38, $39, $40, $41,
                    $42, $43, $44,
                    $45, $46, $47, $48, $49, $50
                ) RETURNING *`,
                [
                    companyId, body.dc_id || null, body.code, body.name, body.email || null, body.phone || null,
                    body.license_number || null, body.license_state || null, toDate(body.license_expiry), body.cdl_class || null, body.cdl_number || null, body.cdl_state || null, body.cdl_endorsements || null,
                    body.hazmat_certified || false, body.hazmat_endorsed || false, toDate(body.hazmat_expiration), body.tanker_endorsed || false, body.twic_card || false, toDate(body.twic_expiration),
                    toDate(body.hire_date), toNum(body.hourly_rate, 25), toNum(body.overtime_rate), toNum(body.per_diem), body.pay_type || 'hourly', toNum(body.years_experience), toDate(body.date_of_birth),
                    toDate(body.medical_card_expiration), body.medical_examiner_name || null, toDate(body.medical_exam_date),
                    toDate(body.background_check_date), body.background_check_status || 'pending', toDate(body.drug_test_date), body.drug_test_status || 'pending', body.drug_test_type || null, toDate(body.mvr_check_date), body.mvr_status || 'pending',
                    body.propane_certified || false, toDate(body.propane_cert_expiration), body.defensive_driving_cert || false, body.smith_system_trained || false, toDate(body.last_training_date),
                    body.emergency_contact_name || null, body.emergency_contact_phone || null, body.emergency_contact_relation || null,
                    body.address || null, body.city || null, body.state || null, body.zip || null, body.notes || null, body.status || 'active'
                ]
            );
            return success(result.rows[0], 201);
        } catch (dbErr) {
            console.error('Driver INSERT error:', dbErr);
            if (dbErr.code === '23505') {
                return error('A driver with this code already exists', 400);
            }
            if (dbErr.code === '42703') {
                return error('Database schema outdated. Please run FULL_MIGRATION.sql in your Neon database.', 500);
            }
            return error(`Failed to create driver: ${dbErr.message}`, 500);
        }
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        
        // Validate required fields
        if (!body.code || !body.name) {
            return error('Driver code and name are required', 400);
        }
        
        // Helper to convert empty strings to null for dates
        const toDate = (val) => (val && typeof val === 'string' && val.trim() !== '') ? val : null;
        const toNum = (val, def = null) => (val !== undefined && val !== null && val !== '') ? val : def;
        const toStr = (val) => (val && typeof val === 'string' && val.trim() !== '') ? val : null;
        
        try {
            const result = await query(
                `UPDATE drivers SET 
                    code = $1, dc_id = $2, name = $3, email = $4, phone = $5, 
                    license_number = $6, license_state = $7, license_expiry = $8, cdl_class = $9, cdl_number = $10, cdl_state = $11, cdl_endorsements = $12,
                    hazmat_certified = $13, hazmat_endorsed = $14, hazmat_expiration = $15, tanker_endorsed = $16, twic_card = $17, twic_expiration = $18,
                    hire_date = $19, hourly_rate = $20, overtime_rate = $21, per_diem = $22, pay_type = $23, years_experience = $24, date_of_birth = $25,
                    medical_card_expiration = $26, medical_examiner_name = $27, medical_exam_date = $28,
                    background_check_date = $29, background_check_status = $30, drug_test_date = $31, drug_test_status = $32, drug_test_type = $33, mvr_check_date = $34, mvr_status = $35,
                    propane_certified = $36, propane_cert_expiration = $37, defensive_driving_cert = $38, smith_system_trained = $39, last_training_date = $40,
                    emergency_contact_name = $41, emergency_contact_phone = $42, emergency_contact_relation = $43,
                    address = $44, city = $45, state = $46, zip = $47, notes = $48, status = $49
                WHERE id = $50 AND company_id = $51 RETURNING *`,
                [
                    body.code, body.dc_id || null, body.name, body.email || null, body.phone || null,
                    body.license_number || null, body.license_state || null, toDate(body.license_expiry), body.cdl_class || null, body.cdl_number || null, body.cdl_state || null, body.cdl_endorsements || null,
                    body.hazmat_certified || false, body.hazmat_endorsed || false, toDate(body.hazmat_expiration), body.tanker_endorsed || false, body.twic_card || false, toDate(body.twic_expiration),
                    toDate(body.hire_date), toNum(body.hourly_rate, 25), toNum(body.overtime_rate), toNum(body.per_diem), body.pay_type || 'hourly', toNum(body.years_experience), toDate(body.date_of_birth),
                    toDate(body.medical_card_expiration), body.medical_examiner_name || null, toDate(body.medical_exam_date),
                    toDate(body.background_check_date), body.background_check_status || 'pending', toDate(body.drug_test_date), body.drug_test_status || 'pending', body.drug_test_type || null, toDate(body.mvr_check_date), body.mvr_status || 'pending',
                    body.propane_certified || false, toDate(body.propane_cert_expiration), body.defensive_driving_cert || false, body.smith_system_trained || false, toDate(body.last_training_date),
                    body.emergency_contact_name || null, body.emergency_contact_phone || null, body.emergency_contact_relation || null,
                    body.address || null, body.city || null, body.state || null, body.zip || null, body.notes || null, body.status || 'active',
                    id, companyId
                ]
            );
            if (result.rows.length === 0) return error('Not found', 404);
            return success(result.rows[0]);
        } catch (dbErr) {
            console.error('Driver UPDATE error:', dbErr);
            if (dbErr.code === '23505') {
                return error('A driver with this code already exists', 400);
            }
            if (dbErr.code === '42703') {
                return error('Database schema outdated. Please run FULL_MIGRATION.sql in your Neon database.', 500);
            }
            return error(`Failed to update driver: ${dbErr.message}`, 500);
        }
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        await query('DELETE FROM drivers WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    return error('Not found', 404);
}

// =====================================================
// CUSTOMERS
// =====================================================

async function handleCustomers(method, path, companyId, user, event) {
    const subPath = path.replace('/customers', '');

    if (method === 'GET' && subPath === '') {
        const { page, limit, offset } = getPagination(event);
        let sql = `SELECT c.*, dc.name as dc_name 
                   FROM customers c 
                   LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id 
                   WHERE c.company_id = $1`;
        const params = [companyId];
        let paramCount = 1;

        if (user.dcId) {
            paramCount++;
            sql += ` AND c.preferred_dc_id = $${paramCount}`;
            params.push(user.dcId);
        }

        // Count total
        const countResult = await query(`SELECT COUNT(*) FROM customers c WHERE c.company_id = $1${user.dcId ? ' AND c.preferred_dc_id = $2' : ''}`, user.dcId ? [companyId, user.dcId] : [companyId]);
        const total = parseInt(countResult.rows[0].count);

        sql += ` ORDER BY c.name LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(limit, offset);

        const result = await query(sql, params);
        return success(paginatedResponse(result.rows, total, page, limit));
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin', 'dispatch', 'accounting'])) {
            return error('Access denied', 403);
        }
        const body = parseBody(event);
        
        // Auto-assign to nearest DC if not specified and customer has coordinates
        let preferredDcId = body.preferred_dc_id || null;
        if (!preferredDcId && body.lat && body.lng) {
            const dcResult = await query(
                `SELECT id, lat, lng,
                 (3958.8 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) AS distance
                 FROM distribution_centers 
                 WHERE company_id = $3 AND lat IS NOT NULL AND lng IS NOT NULL
                 ORDER BY distance ASC LIMIT 1`,
                [parseFloat(body.lat), parseFloat(body.lng), companyId]
            );
            if (dcResult.rows.length > 0) {
                preferredDcId = dcResult.rows[0].id;
            }
        }
        
        const result = await query(
            `INSERT INTO customers (company_id, preferred_dc_id, code, name, contact_name, email, phone, address, city, state, zip, lat, lng, customer_type, tank_size, price_per_gallon, payment_terms, delivery_instructions, auto_delivery, minimum_level)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
            [companyId, preferredDcId, body.code, body.name, body.contact_name, body.email, body.phone, body.address, body.city, body.state, body.zip, body.lat, body.lng, body.customer_type || 'residential', body.tank_size || 500, body.price_per_gallon || 2.50, body.payment_terms || 'net30', body.delivery_instructions, body.auto_delivery || false, body.minimum_level || 20]
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch', 'accounting'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE customers SET preferred_dc_id = $1, code = $2, name = $3, contact_name = $4, email = $5, phone = $6, address = $7, city = $8, state = $9, zip = $10, lat = $11, lng = $12, customer_type = $13, tank_size = $14, price_per_gallon = $15, payment_terms = $16, delivery_instructions = $17, auto_delivery = $18, minimum_level = $19, status = $20, current_level = $21, balance = $22
            WHERE id = $23 AND company_id = $24 RETURNING *`,
            [body.preferred_dc_id, body.code, body.name, body.contact_name, body.email, body.phone, body.address, body.city, body.state, body.zip, body.lat, body.lng, body.customer_type, body.tank_size, body.price_per_gallon, body.payment_terms, body.delivery_instructions, body.auto_delivery, body.minimum_level, body.status || 'active', body.current_level, body.balance, id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        await query('DELETE FROM customers WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    // GET /customers/:id/account - Get customer account history
    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+\/account$/)) {
        const id = subPath.split('/')[1];
        
        // Get customer info with account summary
        const customerResult = await query(
            `SELECT c.*, dc.name as dc_name,
                    COALESCE(c.account_balance, 0) as account_balance,
                    c.credit_limit, c.payment_terms
             FROM customers c
             LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
             WHERE c.id = $1 AND c.company_id = $2`,
            [id, companyId]
        );
        
        if (customerResult.rows.length === 0) {
            return error('Customer not found', 404);
        }
        
        const customer = customerResult.rows[0];
        
        // Get recent transactions
        const transactionsResult = await query(
            `SELECT * FROM customer_transactions 
             WHERE customer_id = $1 AND company_id = $2
             ORDER BY transaction_date DESC, created_at DESC
             LIMIT 50`,
            [id, companyId]
        );
        
        // Get delivery history with details
        const deliveriesResult = await query(
            `SELECT 
                rrs.id,
                rrs.arrived_at,
                rrs.departed_at,
                rrs.tank_level_before,
                rrs.tank_level_after,
                rrs.gallons_delivered,
                rrs.delivery_total,
                rrs.delivery_model,
                rrs.items_total,
                rrs.deposits_collected,
                rrs.deposits_refunded,
                rrs.status,
                rrs.notes,
                rr.scheduled_date,
                rr.name as route_name,
                d.name as driver_name,
                t.code as truck_code
             FROM route_run_stops rrs
             JOIN route_runs rr ON rrs.run_id = rr.id
             LEFT JOIN drivers d ON rr.driver_id = d.id
             LEFT JOIN trucks t ON rr.truck_id = t.id
             WHERE rrs.customer_id = $1 AND rr.company_id = $2
             AND rrs.status IN ('completed', 'skipped')
             ORDER BY rr.scheduled_date DESC, rrs.departed_at DESC
             LIMIT 100`,
            [id, companyId]
        );
        
        // Get delivery items for product-based deliveries
        const deliveryIds = deliveriesResult.rows.filter(d => d.delivery_model === 'products').map(d => d.id);
        let deliveryItems = [];
        if (deliveryIds.length > 0) {
            const itemsResult = await query(
                `SELECT di.*, p.name as product_name, p.code as product_code
                 FROM delivery_items di
                 JOIN products p ON di.product_id = p.id
                 WHERE di.stop_id = ANY($1)
                 ORDER BY di.created_at`,
                [deliveryIds]
            );
            deliveryItems = itemsResult.rows;
        }
        
        // Calculate summary stats
        const statsResult = await query(
            `SELECT 
                COUNT(*) as total_deliveries,
                COALESCE(SUM(gallons_delivered), 0) as total_gallons,
                COALESCE(SUM(delivery_total), 0) as total_revenue,
                COALESCE(AVG(NULLIF(gallons_delivered, 0)), 0) as avg_gallons_per_delivery,
                MIN(rr.scheduled_date) as first_delivery,
                MAX(rr.scheduled_date) as last_delivery
             FROM route_run_stops rrs
             JOIN route_runs rr ON rrs.run_id = rr.id
             WHERE rrs.customer_id = $1 AND rr.company_id = $2
             AND rrs.status = 'completed'`,
            [id, companyId]
        );
        
        // Get product-based stats from delivery_items
        const productStatsResult = await query(
            `SELECT 
                COALESCE(SUM(di.quantity_delivered), 0) as total_items_delivered,
                COALESCE(SUM(di.quantity_collected), 0) as total_items_collected,
                COALESCE(SUM(di.line_total), 0) as total_product_revenue,
                COALESCE(SUM(di.deposit_collected), 0) as total_deposits_collected,
                COALESCE(SUM(di.deposit_refunded), 0) as total_deposits_refunded
             FROM delivery_items di
             JOIN route_run_stops rrs ON di.stop_id = rrs.id
             WHERE rrs.customer_id = $1 AND di.company_id = $2`,
            [id, companyId]
        );
        
        return success({
            customer,
            transactions: transactionsResult.rows,
            deliveries: deliveriesResult.rows,
            deliveryItems,
            stats: {
                ...statsResult.rows[0],
                ...productStatsResult.rows[0]
            }
        });
    }

    // POST /customers/:id/payment - Record a payment
    if (method === 'POST' && subPath.match(/^\/[a-f0-9-]+\/payment$/)) {
        if (!requireRole(user, ['admin', 'accounting'])) {
            return error('Access denied', 403);
        }
        const id = subPath.split('/')[1];
        const body = parseBody(event);
        
        if (!body.amount || body.amount <= 0) {
            return error('Valid payment amount required', 400);
        }
        
        // Record payment transaction (negative amount since it reduces balance)
        const result = await query(
            `INSERT INTO customer_transactions 
             (company_id, customer_id, transaction_type, amount, description, created_by)
             VALUES ($1, $2, 'payment', $3, $4, $5)
             RETURNING *`,
            [companyId, id, -Math.abs(body.amount), body.description || 'Payment received', user.userId]
        );
        
        // Update customer last payment info
        await query(
            `UPDATE customers SET 
                last_payment_date = CURRENT_DATE,
                last_payment_amount = $1,
                updated_at = NOW()
             WHERE id = $2 AND company_id = $3`,
            [Math.abs(body.amount), id, companyId]
        );
        
        return success(result.rows[0], 201);
    }

    // POST /customers/:id/credit - Apply credit/adjustment
    if (method === 'POST' && subPath.match(/^\/[a-f0-9-]+\/credit$/)) {
        if (!requireRole(user, ['admin', 'accounting'])) {
            return error('Access denied', 403);
        }
        const id = subPath.split('/')[1];
        const body = parseBody(event);
        
        if (!body.amount) {
            return error('Amount required', 400);
        }
        
        // Record credit/adjustment (negative reduces balance, positive adds to balance)
        const transactionType = body.amount < 0 ? 'credit' : 'adjustment';
        const result = await query(
            `INSERT INTO customer_transactions 
             (company_id, customer_id, transaction_type, amount, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [companyId, id, transactionType, body.amount, body.description || transactionType, user.userId]
        );
        
        return success(result.rows[0], 201);
    }

    // GET /customers/:id/products - Get customer's assigned products
    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+\/products$/)) {
        const id = subPath.split('/')[1];
        
        const result = await query(
            `SELECT cp.*, p.name as product_name, p.code as product_code, 
                    p.type as product_type, p.unit, p.default_price,
                    p.is_exchangeable, p.deposit_amount, p.category
             FROM customer_products cp
             JOIN products p ON cp.product_id = p.id
             WHERE cp.customer_id = $1 AND cp.company_id = $2
             ORDER BY p.sort_order, p.name`,
            [id, companyId]
        );
        
        return success({ products: result.rows });
    }

    // PUT /customers/:id/products - Save customer's assigned products
    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+\/products$/)) {
        if (!requireRole(user, ['admin', 'dispatch', 'accounting'])) {
            return error('Access denied', 403);
        }
        const id = subPath.split('/')[1];
        const body = parseBody(event);
        const products = body.products || [];
        
        // Verify customer exists
        const customerCheck = await query(
            'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );
        if (customerCheck.rows.length === 0) {
            return error('Customer not found', 404);
        }
        
        // Delete existing customer products
        await query(
            'DELETE FROM customer_products WHERE customer_id = $1 AND company_id = $2',
            [id, companyId]
        );
        
        // Insert new customer products
        for (const product of products) {
            await query(
                `INSERT INTO customer_products 
                 (company_id, customer_id, product_id, custom_price, is_enabled)
                 VALUES ($1, $2, $3, $4, $5)`,
                [companyId, id, product.product_id, product.custom_price, product.is_enabled !== false]
            );
        }
        
        // Return updated products
        const result = await query(
            `SELECT cp.*, p.name as product_name, p.code as product_code
             FROM customer_products cp
             JOIN products p ON cp.product_id = p.id
             WHERE cp.customer_id = $1 AND cp.company_id = $2`,
            [id, companyId]
        );
        
        return success({ products: result.rows });
    }

    return error('Not found', 404);
}

// =====================================================
// ORDERS
// =====================================================

async function handleOrders(method, path, companyId, user, event) {
    const subPath = path.replace('/orders', '');

    if (method === 'GET' && subPath === '') {
        const { page, limit, offset } = getPagination(event);
        const params = event.queryStringParameters || {};
        
        let sql = `SELECT o.*, c.name as customer_name, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.lat, c.lng, dc.name as dc_name
                   FROM orders o
                   JOIN customers c ON o.customer_id = c.id
                   LEFT JOIN distribution_centers dc ON o.dc_id = dc.id
                   WHERE o.company_id = $1`;
        const queryParams = [companyId];
        let paramCount = 1;

        if (user.dcId) {
            paramCount++;
            sql += ` AND o.dc_id = $${paramCount}`;
            queryParams.push(user.dcId);
        }

        if (params.status) {
            paramCount++;
            sql += ` AND o.status = $${paramCount}`;
            queryParams.push(params.status);
        }

        if (params.customer_id) {
            paramCount++;
            sql += ` AND o.customer_id = $${paramCount}`;
            queryParams.push(params.customer_id);
        }

        // Count
        const countSql = sql.replace('SELECT o.*, c.name as customer_name, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.lat, c.lng, dc.name as dc_name', 'SELECT COUNT(*)');
        const countResult = await query(countSql, queryParams);
        const total = parseInt(countResult.rows[0].count);

        sql += ` ORDER BY o.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        queryParams.push(limit, offset);

        const result = await query(sql, queryParams);
        return success(paginatedResponse(result.rows, total, page, limit));
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin', 'dispatch', 'accounting'])) {
            return error('Access denied', 403);
        }
        const body = parseBody(event);
        
        // Generate order number
        const orderNum = `ORD-${Date.now().toString(36).toUpperCase()}`;
        
        // Auto-inherit DC from customer if not specified
        let dcId = body.dc_id || null;
        if (!dcId && body.customer_id) {
            const custResult = await query(
                'SELECT preferred_dc_id FROM customers WHERE id = $1 AND company_id = $2',
                [body.customer_id, companyId]
            );
            if (custResult.rows.length > 0 && custResult.rows[0].preferred_dc_id) {
                dcId = custResult.rows[0].preferred_dc_id;
            }
        }
        
        const result = await query(
            `INSERT INTO orders (company_id, customer_id, dc_id, order_number, gallons_requested, price_per_gallon, total_amount, requested_date, scheduled_date, delivery_window, status, priority)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [companyId, body.customer_id, dcId, orderNum, body.gallons_requested, body.price_per_gallon, body.gallons_requested * (body.price_per_gallon || 2.50), body.requested_date, body.scheduled_date, body.delivery_window || 'anytime', body.status || 'pending', body.priority || 'normal']
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE orders SET dc_id = $1, gallons_requested = $2, gallons_delivered = $3, price_per_gallon = $4, total_amount = $5, scheduled_date = $6, delivery_window = $7, status = $8, priority = $9, delivery_notes = $10, payment_status = $11, paid_amount = $12, route_id = $13, delivered_at = $14
            WHERE id = $15 AND company_id = $16 RETURNING *`,
            [body.dc_id, body.gallons_requested, body.gallons_delivered, body.price_per_gallon, body.total_amount, body.scheduled_date, body.delivery_window, body.status, body.priority, body.delivery_notes, body.payment_status, body.paid_amount, body.route_id, body.delivered_at, id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        await query('DELETE FROM orders WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    return error('Not found', 404);
}

// =====================================================
// ROUTES
// =====================================================

async function handleRoutes(method, path, companyId, user, event) {
    const subPath = path.replace('/routes', '');

    if (method === 'GET' && subPath === '') {
        let sql = `SELECT r.*, dc.name as dc_name, d.name as driver_name, t.name as truck_name,
                   (SELECT COUNT(*) FROM route_stops WHERE route_id = r.id) as stop_count
                   FROM routes r
                   LEFT JOIN distribution_centers dc ON r.dc_id = dc.id
                   LEFT JOIN drivers d ON r.driver_id = d.id
                   LEFT JOIN trucks t ON r.truck_id = t.id
                   WHERE r.company_id = $1`;
        const params = [companyId];
        
        if (user.dcId) {
            sql += ' AND r.dc_id = $2';
            params.push(user.dcId);
        }
        sql += ' ORDER BY r.scheduled_date DESC, r.start_time';
        
        const result = await query(sql, params);
        return success(result.rows);
    }

    if (method === 'GET' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const routeResult = await query(
            `SELECT r.*, dc.name as dc_name, d.name as driver_name, t.name as truck_name
             FROM routes r
             LEFT JOIN distribution_centers dc ON r.dc_id = dc.id
             LEFT JOIN drivers d ON r.driver_id = d.id
             LEFT JOIN trucks t ON r.truck_id = t.id
             WHERE r.id = $1 AND r.company_id = $2`,
            [id, companyId]
        );
        if (routeResult.rows.length === 0) return error('Not found', 404);

        // Get stops with order details
        const stopsResult = await query(
            `SELECT rs.*, o.order_number, o.gallons_requested, o.status as order_status,
                    c.name as customer_name, c.address, c.city, c.state, c.lat, c.lng
             FROM route_stops rs
             JOIN orders o ON rs.order_id = o.id
             JOIN customers c ON o.customer_id = c.id
             WHERE rs.route_id = $1
             ORDER BY rs.stop_number`,
            [id]
        );

        return success({
            ...routeResult.rows[0],
            stops: stopsResult.rows
        });
    }

    if (method === 'POST' && subPath === '') {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const body = parseBody(event);
        const routeNum = `RTE-${Date.now().toString(36).toUpperCase()}`;
        
        const result = await query(
            `INSERT INTO routes (company_id, dc_id, truck_id, driver_id, route_number, name, scheduled_date, start_time, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [companyId, body.dc_id, body.truck_id, body.driver_id, routeNum, body.name, body.scheduled_date, body.start_time || '08:00', body.status || 'planned']
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch', 'driver'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE routes SET truck_id = $1, driver_id = $2, name = $3, scheduled_date = $4, start_time = $5, status = $6, total_stops = $7, total_gallons = $8, total_miles = $9, estimated_duration = $10, is_optimized = $11, started_at = $12, completed_at = $13
            WHERE id = $14 AND company_id = $15 RETURNING *`,
            [body.truck_id, body.driver_id, body.name, body.scheduled_date, body.start_time, body.status, body.total_stops, body.total_gallons, body.total_miles, body.estimated_duration, body.is_optimized, body.started_at, body.completed_at, id, companyId]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    // POST /routes/:id/stops - Add stops to route
    if (method === 'POST' && subPath.match(/^\/[a-f0-9-]+\/stops$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const routeId = subPath.split('/')[1];
        const body = parseBody(event);
        
        // body.orders should be array of { order_id, stop_number }
        const stops = body.orders || [];
        
        for (const stop of stops) {
            await query(
                `INSERT INTO route_stops (route_id, order_id, stop_number) VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [routeId, stop.order_id, stop.stop_number]
            );
            // Update order with route assignment
            await query(
                `UPDATE orders SET route_id = $1, status = 'scheduled' WHERE id = $2 AND company_id = $3`,
                [routeId, stop.order_id, companyId]
            );
        }

        // Update route totals
        const statsResult = await query(
            `SELECT COUNT(*) as stops, COALESCE(SUM(o.gallons_requested), 0) as gallons
             FROM route_stops rs
             JOIN orders o ON rs.order_id = o.id
             WHERE rs.route_id = $1`,
            [routeId]
        );
        
        await query(
            `UPDATE routes SET total_stops = $1, total_gallons = $2 WHERE id = $3`,
            [statsResult.rows[0].stops, statsResult.rows[0].gallons, routeId]
        );

        return success({ message: 'Stops added', count: stops.length });
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        const id = subPath.slice(1);
        // Clear route from orders first
        await query('UPDATE orders SET route_id = NULL WHERE route_id = $1', [id]);
        await query('DELETE FROM routes WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    return error('Not found', 404);
}

// =====================================================
// USERS (Admin only)
// =====================================================

async function handleUsers(method, path, companyId, event) {
    const { hashPassword } = require('./utils/auth');
    const subPath = path.replace('/users', '');

    if (method === 'GET' && subPath === '') {
        const result = await query(
            `SELECT id, username, email, name, phone, role, avatar, dc_id, driver_id, status, last_login, created_at
             FROM users WHERE company_id = $1 ORDER BY created_at DESC`,
            [companyId]
        );
        return success(result.rows);
    }

    if (method === 'POST' && subPath === '') {
        const body = parseBody(event);
        const passwordHash = await hashPassword(body.password);
        const result = await query(
            `INSERT INTO users (company_id, username, email, password_hash, name, phone, role, avatar, dc_id, driver_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, username, email, name, phone, role, avatar, dc_id, driver_id, status, created_at`,
            [companyId, body.username, body.email, passwordHash, body.name, body.phone, body.role, body.avatar || '👤', body.dc_id, body.driver_id, body.status || 'active']
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const body = parseBody(event);
        
        let sql = `UPDATE users SET username = $1, name = $2, email = $3, phone = $4, role = $5, avatar = $6, dc_id = $7, driver_id = $8, status = $9`;
        const params = [body.username, body.name, body.email, body.phone, body.role, body.avatar, body.dc_id, body.driver_id, body.status || 'active'];
        
        // Update password if provided
        if (body.password) {
            const passwordHash = await hashPassword(body.password);
            sql += `, password_hash = $10 WHERE id = $11 AND company_id = $12`;
            params.push(passwordHash, id, companyId);
        } else {
            sql += ` WHERE id = $10 AND company_id = $11`;
            params.push(id, companyId);
        }
        
        sql += ' RETURNING id, username, email, name, phone, role, avatar, dc_id, driver_id, status';
        
        const result = await query(sql, params);
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
    }

    if (method === 'DELETE' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        await query('DELETE FROM users WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Deleted' });
    }

    return error('Not found', 404);
}
