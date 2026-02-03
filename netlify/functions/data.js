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

        return error('Not found', 404);
    } catch (err) {
        console.error('Data API error:', err);
        return error('Internal server error', 500);
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

    const [dcs, trucks, drivers, customers, orders, routes] = await Promise.all([
        query('SELECT * FROM distribution_centers WHERE company_id = $1 ORDER BY name', [companyId]),
        query(`SELECT * FROM trucks WHERE company_id = $1${user.dcId ? ' AND dc_id = $2' : ''} ORDER BY code`, params),
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
               ORDER BY r.scheduled_date DESC LIMIT 50`, params)
    ]);

    return success({
        distributionCenters: dcs.rows,
        trucks: trucks.rows,
        drivers: drivers.rows,
        customers: customers.rows,
        orders: orders.rows,
        routes: routes.rows
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
            `UPDATE distribution_centers SET name = $1, address = $2, city = $3, state = $4, zip = $5, phone = $6, lat = $7, lng = $8, manager_name = $9, capacity_gallons = $10, status = $11
            WHERE id = $12 AND company_id = $13 RETURNING *`,
            [body.name, body.address, body.city, body.state, body.zip, body.phone, body.lat, body.lng, body.manager_name, body.capacity_gallons, body.status || 'active', id, companyId]
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
        const result = await query(
            `INSERT INTO trucks (
                company_id, dc_id, assigned_driver_id, code, name, make, model, year, vin, license_plate,
                capacity_gallons, mpg, current_lat, current_lng, status,
                empty_weight, gvwr, gcwr, max_payload, front_axle_weight, rear_axle_weight, axle_configuration,
                tank_capacity_gallons, tank_material, tank_last_inspection, tank_next_inspection, tank_certification,
                tank_manufacturer, tank_serial_number, tank_manufacture_date, working_pressure_psi,
                product_type, product_weight_per_gallon,
                fuel_tank_capacity, fuel_type, diesel_weight_per_gallon, avg_mpg, cost_per_mile, def_tank_capacity,
                has_pump, pump_type, meter_type, meter_serial_number, meter_last_calibration, meter_next_calibration,
                dot_number, mc_number, registration_number, registration_state, registration_expiration, 
                last_dot_inspection, next_dot_inspection, dot_inspection_status, inspection_decal_number,
                ifta_account, irp_account,
                insurance_policy_number, insurance_provider, insurance_expiration, liability_coverage, cargo_coverage,
                last_oil_change, last_oil_change_miles, next_oil_change_miles, oil_change_interval_miles,
                last_service_date, last_service_mileage, next_service_date, next_service_mileage,
                current_odometer, total_hours, tire_size, tire_last_replaced,
                telematics_device_id, telematics_provider,
                has_lift_gate, has_pto_pump, has_gps_tracker, has_dash_cam, has_eld, eld_provider, eld_serial_number,
                purchase_date, purchase_price, current_value, monthly_payment, monthly_insurance, notes
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15,
                $16, $17, $18, $19, $20, $21, $22,
                $23, $24, $25, $26, $27,
                $28, $29, $30, $31,
                $32, $33,
                $34, $35, $36, $37, $38, $39,
                $40, $41, $42, $43, $44, $45,
                $46, $47, $48, $49, $50, $51, $52, $53, $54,
                $55, $56,
                $57, $58, $59, $60, $61,
                $62, $63, $64, $65,
                $66, $67, $68, $69,
                $70, $71, $72, $73,
                $74, $75,
                $76, $77, $78, $79, $80, $81, $82,
                $83, $84, $85, $86, $87, $88
            ) RETURNING *`,
            [
                companyId, body.dc_id, body.assigned_driver_id, body.code, body.name, body.make, body.model, body.year, body.vin, body.license_plate,
                body.capacity_gallons || 3000, body.mpg || 8, body.current_lat, body.current_lng, body.status || 'active',
                body.empty_weight, body.gvwr, body.gcwr, body.max_payload, body.front_axle_weight, body.rear_axle_weight, body.axle_configuration,
                body.tank_capacity_gallons, body.tank_material, body.tank_last_inspection, body.tank_next_inspection, body.tank_certification,
                body.tank_manufacturer, body.tank_serial_number, body.tank_manufacture_date, body.working_pressure_psi,
                body.product_type || 'propane', body.product_weight_per_gallon || 4.2,
                body.fuel_tank_capacity, body.fuel_type || 'diesel', body.diesel_weight_per_gallon || 7.1, body.avg_mpg || 8, body.cost_per_mile, body.def_tank_capacity,
                body.has_pump !== false, body.pump_type, body.meter_type, body.meter_serial_number, body.meter_last_calibration, body.meter_next_calibration,
                body.dot_number, body.mc_number, body.registration_number, body.registration_state, body.registration_expiration || body.registration_expiry,
                body.last_dot_inspection, body.next_dot_inspection, body.dot_inspection_status, body.inspection_decal_number,
                body.ifta_account, body.irp_account,
                body.insurance_policy_number, body.insurance_provider, body.insurance_expiration, body.liability_coverage, body.cargo_coverage,
                body.last_oil_change, body.last_oil_change_miles, body.next_oil_change_miles, body.oil_change_interval_miles || 15000,
                body.last_service_date, body.last_service_mileage, body.next_service_date, body.next_service_mileage,
                body.current_odometer || body.odometer, body.total_hours, body.tire_size, body.tire_last_replaced,
                body.telematics_device_id, body.telematics_provider,
                body.has_lift_gate || false, body.has_pto_pump || false, body.has_gps_tracker !== false, body.has_dash_cam || false, body.has_eld !== false, body.eld_provider, body.eld_serial_number,
                body.purchase_date, body.purchase_price, body.current_value, body.monthly_payment, body.monthly_insurance, body.notes
            ]
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE trucks SET 
                dc_id = $1, assigned_driver_id = $2, name = $3, make = $4, model = $5, year = $6, vin = $7, license_plate = $8,
                capacity_gallons = $9, mpg = $10, current_lat = $11, current_lng = $12, status = $13,
                empty_weight = $14, gvwr = $15, gcwr = $16, max_payload = $17, front_axle_weight = $18, rear_axle_weight = $19, axle_configuration = $20,
                tank_capacity_gallons = $21, tank_material = $22, tank_last_inspection = $23, tank_next_inspection = $24, tank_certification = $25,
                tank_manufacturer = $26, tank_serial_number = $27, tank_manufacture_date = $28, working_pressure_psi = $29,
                product_type = $30, product_weight_per_gallon = $31,
                fuel_tank_capacity = $32, fuel_type = $33, diesel_weight_per_gallon = $34, avg_mpg = $35, cost_per_mile = $36, def_tank_capacity = $37,
                has_pump = $38, pump_type = $39, meter_type = $40, meter_serial_number = $41, meter_last_calibration = $42, meter_next_calibration = $43,
                dot_number = $44, mc_number = $45, registration_number = $46, registration_state = $47, registration_expiration = $48,
                last_dot_inspection = $49, next_dot_inspection = $50, dot_inspection_status = $51, inspection_decal_number = $52,
                ifta_account = $53, irp_account = $54,
                insurance_policy_number = $55, insurance_provider = $56, insurance_expiration = $57, liability_coverage = $58, cargo_coverage = $59,
                last_oil_change = $60, last_oil_change_miles = $61, next_oil_change_miles = $62, oil_change_interval_miles = $63,
                last_service_date = $64, last_service_mileage = $65, next_service_date = $66, next_service_mileage = $67,
                current_odometer = $68, total_hours = $69, tire_size = $70, tire_last_replaced = $71,
                telematics_device_id = $72, telematics_provider = $73,
                has_lift_gate = $74, has_pto_pump = $75, has_gps_tracker = $76, has_dash_cam = $77, has_eld = $78, eld_provider = $79, eld_serial_number = $80,
                purchase_date = $81, purchase_price = $82, current_value = $83, monthly_payment = $84, monthly_insurance = $85, notes = $86
            WHERE id = $87 AND company_id = $88 RETURNING *`,
            [
                body.dc_id, body.assigned_driver_id, body.name, body.make, body.model, body.year, body.vin, body.license_plate,
                body.capacity_gallons, body.mpg, body.current_lat, body.current_lng, body.status || 'active',
                body.empty_weight, body.gvwr, body.gcwr, body.max_payload, body.front_axle_weight, body.rear_axle_weight, body.axle_configuration,
                body.tank_capacity_gallons, body.tank_material, body.tank_last_inspection, body.tank_next_inspection, body.tank_certification,
                body.tank_manufacturer, body.tank_serial_number, body.tank_manufacture_date, body.working_pressure_psi,
                body.product_type, body.product_weight_per_gallon,
                body.fuel_tank_capacity, body.fuel_type, body.diesel_weight_per_gallon, body.avg_mpg, body.cost_per_mile, body.def_tank_capacity,
                body.has_pump, body.pump_type, body.meter_type, body.meter_serial_number, body.meter_last_calibration, body.meter_next_calibration,
                body.dot_number, body.mc_number, body.registration_number, body.registration_state, body.registration_expiration || body.registration_expiry,
                body.last_dot_inspection, body.next_dot_inspection, body.dot_inspection_status, body.inspection_decal_number,
                body.ifta_account, body.irp_account,
                body.insurance_policy_number, body.insurance_provider, body.insurance_expiration, body.liability_coverage, body.cargo_coverage,
                body.last_oil_change, body.last_oil_change_miles, body.next_oil_change_miles, body.oil_change_interval_miles,
                body.last_service_date, body.last_service_mileage, body.next_service_date, body.next_service_mileage,
                body.current_odometer || body.odometer, body.total_hours, body.tire_size, body.tire_last_replaced,
                body.telematics_device_id, body.telematics_provider,
                body.has_lift_gate, body.has_pto_pump, body.has_gps_tracker, body.has_dash_cam, body.has_eld, body.eld_provider, body.eld_serial_number,
                body.purchase_date, body.purchase_price, body.current_value, body.monthly_payment, body.monthly_insurance, body.notes,
                id, companyId
            ]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
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
                companyId, body.dc_id, body.code, body.name, body.email, body.phone,
                body.license_number, body.license_state, body.license_expiry, body.cdl_class, body.cdl_number, body.cdl_state, body.cdl_endorsements,
                body.hazmat_certified || false, body.hazmat_endorsed || false, body.hazmat_expiration, body.tanker_endorsed || false, body.twic_card || false, body.twic_expiration,
                body.hire_date, body.hourly_rate || 25, body.overtime_rate, body.per_diem, body.pay_type || 'hourly', body.years_experience, body.date_of_birth,
                body.medical_card_expiration, body.medical_examiner_name, body.medical_exam_date,
                body.background_check_date, body.background_check_status || 'pending', body.drug_test_date, body.drug_test_status || 'pending', body.drug_test_type, body.mvr_check_date, body.mvr_status || 'pending',
                body.propane_certified || false, body.propane_cert_expiration, body.defensive_driving_cert || false, body.smith_system_trained || false, body.last_training_date,
                body.emergency_contact_name, body.emergency_contact_phone, body.emergency_contact_relation,
                body.address, body.city, body.state, body.zip, body.notes, body.status || 'active'
            ]
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        const id = subPath.slice(1);
        const body = parseBody(event);
        const result = await query(
            `UPDATE drivers SET 
                dc_id = $1, name = $2, email = $3, phone = $4, 
                license_number = $5, license_state = $6, license_expiry = $7, cdl_class = $8, cdl_number = $9, cdl_state = $10, cdl_endorsements = $11,
                hazmat_certified = $12, hazmat_endorsed = $13, hazmat_expiration = $14, tanker_endorsed = $15, twic_card = $16, twic_expiration = $17,
                hire_date = $18, hourly_rate = $19, overtime_rate = $20, per_diem = $21, pay_type = $22, years_experience = $23, date_of_birth = $24,
                medical_card_expiration = $25, medical_examiner_name = $26, medical_exam_date = $27,
                background_check_date = $28, background_check_status = $29, drug_test_date = $30, drug_test_status = $31, drug_test_type = $32, mvr_check_date = $33, mvr_status = $34,
                propane_certified = $35, propane_cert_expiration = $36, defensive_driving_cert = $37, smith_system_trained = $38, last_training_date = $39,
                emergency_contact_name = $40, emergency_contact_phone = $41, emergency_contact_relation = $42,
                address = $43, city = $44, state = $45, zip = $46, notes = $47, status = $48
            WHERE id = $49 AND company_id = $50 RETURNING *`,
            [
                body.dc_id, body.name, body.email, body.phone,
                body.license_number, body.license_state, body.license_expiry, body.cdl_class, body.cdl_number, body.cdl_state, body.cdl_endorsements,
                body.hazmat_certified, body.hazmat_endorsed, body.hazmat_expiration, body.tanker_endorsed, body.twic_card, body.twic_expiration,
                body.hire_date, body.hourly_rate, body.overtime_rate, body.per_diem, body.pay_type, body.years_experience, body.date_of_birth,
                body.medical_card_expiration, body.medical_examiner_name, body.medical_exam_date,
                body.background_check_date, body.background_check_status, body.drug_test_date, body.drug_test_status, body.drug_test_type, body.mvr_check_date, body.mvr_status,
                body.propane_certified, body.propane_cert_expiration, body.defensive_driving_cert, body.smith_system_trained, body.last_training_date,
                body.emergency_contact_name, body.emergency_contact_phone, body.emergency_contact_relation,
                body.address, body.city, body.state, body.zip, body.notes, body.status || 'active',
                id, companyId
            ]
        );
        if (result.rows.length === 0) return error('Not found', 404);
        return success(result.rows[0]);
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
        const result = await query(
            `INSERT INTO customers (company_id, preferred_dc_id, code, name, contact_name, email, phone, address, city, state, zip, lat, lng, customer_type, tank_size, price_per_gallon, payment_terms, delivery_instructions, auto_delivery, minimum_level)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
            [companyId, body.preferred_dc_id, body.code, body.name, body.contact_name, body.email, body.phone, body.address, body.city, body.state, body.zip, body.lat, body.lng, body.customer_type || 'residential', body.tank_size || 500, body.price_per_gallon || 2.50, body.payment_terms || 'net30', body.delivery_instructions, body.auto_delivery || false, body.minimum_level || 20]
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
            `UPDATE customers SET preferred_dc_id = $1, name = $2, contact_name = $3, email = $4, phone = $5, address = $6, city = $7, state = $8, zip = $9, lat = $10, lng = $11, customer_type = $12, tank_size = $13, price_per_gallon = $14, payment_terms = $15, delivery_instructions = $16, auto_delivery = $17, minimum_level = $18, status = $19, current_level = $20, balance = $21
            WHERE id = $22 AND company_id = $23 RETURNING *`,
            [body.preferred_dc_id, body.name, body.contact_name, body.email, body.phone, body.address, body.city, body.state, body.zip, body.lat, body.lng, body.customer_type, body.tank_size, body.price_per_gallon, body.payment_terms, body.delivery_instructions, body.auto_delivery, body.minimum_level, body.status || 'active', body.current_level, body.balance, id, companyId]
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
        
        const result = await query(
            `INSERT INTO orders (company_id, customer_id, dc_id, order_number, gallons_requested, price_per_gallon, total_amount, requested_date, scheduled_date, delivery_window, status, priority)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [companyId, body.customer_id, body.dc_id, orderNum, body.gallons_requested, body.price_per_gallon, body.gallons_requested * (body.price_per_gallon || 2.50), body.requested_date, body.scheduled_date, body.delivery_window || 'anytime', body.status || 'pending', body.priority || 'normal']
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
            `SELECT id, username, email, name, role, avatar, dc_id, driver_id, status, last_login, created_at
             FROM users WHERE company_id = $1 ORDER BY created_at DESC`,
            [companyId]
        );
        return success(result.rows);
    }

    if (method === 'POST' && subPath === '') {
        const body = parseBody(event);
        const passwordHash = await hashPassword(body.password);
        const result = await query(
            `INSERT INTO users (company_id, username, email, password_hash, name, role, avatar, dc_id, driver_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, username, email, name, role, avatar, dc_id, driver_id, status, created_at`,
            [companyId, body.username, body.email, passwordHash, body.name, body.role, body.avatar || '👤', body.dc_id, body.driver_id]
        );
        return success(result.rows[0], 201);
    }

    if (method === 'PUT' && subPath.match(/^\/[a-f0-9-]+$/)) {
        const id = subPath.slice(1);
        const body = parseBody(event);
        
        let sql = `UPDATE users SET name = $1, email = $2, role = $3, avatar = $4, dc_id = $5, driver_id = $6, status = $7`;
        const params = [body.name, body.email, body.role, body.avatar, body.dc_id, body.driver_id, body.status || 'active'];
        
        // Update password if provided
        if (body.password) {
            const passwordHash = await hashPassword(body.password);
            sql += `, password_hash = $8 WHERE id = $9 AND company_id = $10`;
            params.push(passwordHash, id, companyId);
        } else {
            sql += ` WHERE id = $8 AND company_id = $9`;
            params.push(id, companyId);
        }
        
        sql += ' RETURNING id, username, email, name, role, avatar, dc_id, driver_id, status';
        
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
