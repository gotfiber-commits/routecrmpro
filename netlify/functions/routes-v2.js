// Route Templates & Route Runs API
// Handles route-based delivery model (keep-full service)

const { query } = require('./utils/db');
const { requireAuth, requireRole } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/routes-v2', '');
    const method = event.httpMethod;

    try {
        // Auth required first
        const authResult = requireAuth(event);
        if (authResult.error) {
            return error(authResult.error, authResult.status);
        }
        const user = authResult.user;

        // Get companyId - prefer from token, fallback to tenant resolution
        let companyId = user.companyId;
        
        // Optionally verify tenant matches token (if provided)
        const tenant = await resolveTenant(event);
        if (tenant.resolved && tenant.company.id !== companyId) {
            return error('Unauthorized - company mismatch', 403);
        }

        // My Routes - Driver-specific routes (uses driver_id from user)
        if (path === '/my-routes' && method === 'GET') {
            return await getDriverRoutes(user, companyId, event);
        }

        // GET /customer-products/:customerId - Get products available for a customer (for driver stop completion)
        if (method === 'GET' && path.match(/^\/customer-products\/[a-f0-9-]+$/)) {
            const customerId = path.split('/')[2];
            return await getCustomerProductsForDriver(companyId, customerId);
        }

        // Route Templates
        if (path.startsWith('/templates')) {
            return await handleTemplates(method, path.replace('/templates', ''), companyId, user, event);
        }

        // Route Runs
        if (path.startsWith('/runs')) {
            return await handleRuns(method, path.replace('/runs', ''), companyId, user, event);
        }

        // Optimize route (for templates or ad-hoc)
        if (path === '/optimize' && method === 'POST') {
            return await optimizeStops(companyId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Routes V2 error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// DRIVER-SPECIFIC ROUTES
// =====================================================

async function getDriverRoutes(user, companyId, event) {
    const params = event.queryStringParameters || {};
    
    // Get user's driver_id from the users table
    const userResult = await query(
        'SELECT driver_id FROM users WHERE id = $1 AND company_id = $2',
        [user.userId, companyId]
    );
    
    if (userResult.rows.length === 0) {
        return error('User not found', 404);
    }
    
    const driverId = userResult.rows[0].driver_id;
    
    if (!driverId) {
        return error('No driver profile linked to this user. Please contact your administrator.', 400);
    }
    
    // Get today's date for filtering
    const today = new Date().toISOString().split('T')[0];
    
    // Get routes assigned to this driver
    let dateFilter = '';
    const queryParams = [companyId, driverId];
    
    if (params.date) {
        dateFilter = ' AND rr.scheduled_date = $3';
        queryParams.push(params.date);
    } else {
        // Default: show today and future scheduled routes, plus any in-progress
        dateFilter = ' AND (rr.scheduled_date >= $3 OR rr.status = \'in_progress\')';
        queryParams.push(today);
    }
    
    const result = await query(
        `SELECT rr.*,
                dc.name as dc_name, dc.code as dc_code,
                dc.address as dc_address, dc.city as dc_city, dc.state as dc_state,
                dc.lat as dc_lat, dc.lng as dc_lng,
                d.name as driver_name, d.code as driver_code, d.phone as driver_phone,
                t.name as truck_name, t.code as truck_code, 
                t.capacity_gallons as truck_capacity,
                t.make as truck_make, t.model as truck_model,
                t.license_plate as truck_license_plate
         FROM route_runs rr
         LEFT JOIN distribution_centers dc ON rr.dc_id = dc.id
         LEFT JOIN drivers d ON rr.driver_id = d.id
         LEFT JOIN trucks t ON rr.truck_id = t.id
         WHERE rr.company_id = $1 
         AND rr.driver_id = $2
         ${dateFilter}
         AND rr.status != 'cancelled'
         ORDER BY 
            CASE rr.status 
                WHEN 'in_progress' THEN 1 
                WHEN 'scheduled' THEN 2 
                ELSE 3 
            END,
            rr.scheduled_date ASC`,
        queryParams
    );
    
    // Get driver info
    const driverResult = await query(
        `SELECT d.*, 
                dc.name as dc_name, dc.code as dc_code,
                t.id as truck_id, t.code as truck_code, t.name as truck_name,
                t.make as truck_make, t.model as truck_model, t.year as truck_year,
                t.capacity_gallons, t.license_plate, t.current_odometer
         FROM drivers d
         LEFT JOIN distribution_centers dc ON d.dc_id = dc.id
         LEFT JOIN trucks t ON t.assigned_driver_id = d.id AND t.status = 'active'
         WHERE d.id = $1`,
        [driverId]
    );
    
    const driverInfo = driverResult.rows[0] || null;
    
    // Get company delivery settings - handle case where columns don't exist yet
    let settings = { delivery_model: 'gallons', track_empties: false, track_truck_inventory: false };
    try {
        const companySettings = await query(
            `SELECT 
                COALESCE(delivery_model, 'gallons') as delivery_model,
                COALESCE(track_empties, false) as track_empties,
                COALESCE(track_truck_inventory, false) as track_truck_inventory
             FROM companies WHERE id = $1`,
            [companyId]
        );
        if (companySettings.rows[0]) {
            settings = companySettings.rows[0];
        }
    } catch (e) {
        // Columns don't exist yet - use defaults (gallons mode)
        console.log('Products feature not migrated yet, using gallons mode');
    }
    
    // If product-based delivery, get the products list
    let products = [];
    if (settings.delivery_model === 'products' || settings.delivery_model === 'mixed') {
        try {
            const productsResult = await query(
                `SELECT id, type, code, name, category, unit, default_price, 
                        gallon_equivalent, is_exchangeable, deposit_amount, sort_order
                 FROM products 
                 WHERE company_id = $1 AND status = 'active'
                 ORDER BY sort_order, category, name`,
                [companyId]
            );
            products = productsResult.rows;
        } catch (e) {
            // Products table doesn't exist yet
            console.log('Products table not created yet');
        }
    }
    
    // Get truck inventory if tracking enabled
    let truckInventory = [];
    if (settings.track_truck_inventory && driverInfo?.truck_id) {
        try {
            const invResult = await query(
                `SELECT ti.product_id, ti.quantity, p.code as product_code, p.name as product_name
                 FROM truck_inventory ti
                 JOIN products p ON ti.product_id = p.id
                 WHERE ti.truck_id = $1 AND p.status = 'active'`,
                [driverInfo.truck_id]
            );
            truckInventory = invResult.rows;
        } catch (e) {
            // Inventory tables don't exist yet
            console.log('Inventory tables not created yet');
        }
    }
    
    return success({
        driver: driverInfo ? {
            id: driverInfo.id,
            code: driverInfo.code,
            name: driverInfo.name,
            phone: driverInfo.phone,
            dcName: driverInfo.dc_name,
            dcCode: driverInfo.dc_code
        } : null,
        truck: driverInfo && driverInfo.truck_id ? {
            id: driverInfo.truck_id,
            code: driverInfo.truck_code,
            name: driverInfo.truck_name,
            make: driverInfo.truck_make,
            model: driverInfo.truck_model,
            year: driverInfo.truck_year,
            capacityGallons: driverInfo.capacity_gallons,
            licensePlate: driverInfo.license_plate,
            currentOdometer: driverInfo.current_odometer,
            inventory: truckInventory
        } : null,
        routes: result.rows,
        today: today,
        settings: {
            deliveryModel: settings.delivery_model || 'gallons',
            trackEmpties: settings.track_empties || false,
            trackInventory: settings.track_truck_inventory || false
        },
        products: products
    });
}

// Get products available for a specific customer (with customer-specific pricing)
async function getCustomerProductsForDriver(companyId, customerId) {
    // Verify customer belongs to company
    const customerCheck = await query(
        'SELECT id, name, code FROM customers WHERE id = $1 AND company_id = $2',
        [customerId, companyId]
    );
    if (customerCheck.rows.length === 0) {
        return error('Customer not found', 404);
    }

    // Get all active products with customer-specific pricing
    try {
        const result = await query(
            `SELECT 
                p.id,
                p.type,
                p.code,
                p.name,
                p.category,
                p.unit,
                p.default_price,
                p.gallon_equivalent,
                p.is_exchangeable,
                p.deposit_amount,
                p.track_inventory,
                p.sort_order,
                cp.custom_price,
                COALESCE(cp.is_enabled, true) as is_enabled,
                COALESCE(cp.custom_price, p.default_price) as effective_price
             FROM products p
             LEFT JOIN customer_products cp ON p.id = cp.product_id AND cp.customer_id = $1
             WHERE p.company_id = $2 AND p.status = 'active'
             AND COALESCE(cp.is_enabled, true) = true
             ORDER BY p.sort_order, p.category, p.name`,
            [customerId, companyId]
        );

        return success({
            customer: customerCheck.rows[0],
            products: result.rows
        });
    } catch (e) {
        // Products table doesn't exist yet
        console.log('Products table not available:', e.message);
        return success({
            customer: customerCheck.rows[0],
            products: []
        });
    }
}

// =====================================================
// ROUTE TEMPLATES
// =====================================================

async function handleTemplates(method, path, companyId, user, event) {
    // GET /templates - List all templates
    if (method === 'GET' && path === '') {
        const result = await query(
            `SELECT rt.*, 
                    dc.name as dc_name,
                    d.name as driver_name,
                    t.name as truck_name,
                    t.code as truck_code,
                    (SELECT COUNT(*) FROM route_template_stops WHERE template_id = rt.id) as stop_count
             FROM route_templates rt
             LEFT JOIN distribution_centers dc ON rt.dc_id = dc.id
             LEFT JOIN drivers d ON rt.assigned_driver_id = d.id
             LEFT JOIN trucks t ON rt.assigned_truck_id = t.id
             WHERE rt.company_id = $1
             ORDER BY rt.day_of_week, rt.name`,
            [companyId]
        );
        return success(result.rows);
    }

    // GET /templates/:id - Get template with stops
    if (method === 'GET' && path.match(/^\/[a-f0-9-]+$/)) {
        const id = path.slice(1);
        const templateResult = await query(
            `SELECT rt.*, 
                    dc.name as dc_name, dc.lat as dc_lat, dc.lng as dc_lng,
                    d.name as driver_name,
                    t.name as truck_name, t.code as truck_code
             FROM route_templates rt
             LEFT JOIN distribution_centers dc ON rt.dc_id = dc.id
             LEFT JOIN drivers d ON rt.assigned_driver_id = d.id
             LEFT JOIN trucks t ON rt.assigned_truck_id = t.id
             WHERE rt.id = $1 AND rt.company_id = $2`,
            [id, companyId]
        );
        
        if (templateResult.rows.length === 0) {
            return error('Template not found', 404);
        }

        const stopsResult = await query(
            `SELECT rts.*, 
                    c.name as customer_name, c.code as customer_code,
                    c.address, c.city, c.state, c.zip,
                    c.lat, c.lng,
                    c.tank_size, c.current_level, c.price_per_gallon,
                    c.phone, c.delivery_instructions as customer_instructions
             FROM route_template_stops rts
             JOIN customers c ON rts.customer_id = c.id
             WHERE rts.template_id = $1
             ORDER BY rts.stop_number`,
            [id]
        );

        return success({
            ...templateResult.rows[0],
            stops: stopsResult.rows
        });
    }

    // POST /templates - Create template
    if (method === 'POST' && path === '') {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const body = parseBody(event);
        const result = await query(
            `INSERT INTO route_templates (company_id, dc_id, name, description, day_of_week, frequency, assigned_driver_id, assigned_truck_id, estimated_miles, estimated_duration_minutes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [companyId, body.dc_id, body.name, body.description, body.day_of_week, body.frequency || 'weekly', body.assigned_driver_id, body.assigned_truck_id, body.estimated_miles || null, body.estimated_duration_minutes || null, body.status || 'active']
        );
        return success(result.rows[0], 201);
    }

    // PUT /templates/:id - Update template
    if (method === 'PUT' && path.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const id = path.slice(1);
        const body = parseBody(event);
        
        // Build dynamic update query
        const updates = [];
        const values = [];
        let paramCount = 0;
        
        if (body.dc_id !== undefined) {
            paramCount++;
            updates.push(`dc_id = $${paramCount}`);
            values.push(body.dc_id);
        }
        if (body.name !== undefined) {
            paramCount++;
            updates.push(`name = $${paramCount}`);
            values.push(body.name);
        }
        if (body.description !== undefined) {
            paramCount++;
            updates.push(`description = $${paramCount}`);
            values.push(body.description);
        }
        if (body.day_of_week !== undefined) {
            paramCount++;
            updates.push(`day_of_week = $${paramCount}`);
            values.push(body.day_of_week);
        }
        if (body.frequency !== undefined) {
            paramCount++;
            updates.push(`frequency = $${paramCount}`);
            values.push(body.frequency);
        }
        if (body.assigned_driver_id !== undefined) {
            paramCount++;
            updates.push(`assigned_driver_id = $${paramCount}`);
            values.push(body.assigned_driver_id);
        }
        if (body.assigned_truck_id !== undefined) {
            paramCount++;
            updates.push(`assigned_truck_id = $${paramCount}`);
            values.push(body.assigned_truck_id);
        }
        if (body.status !== undefined) {
            paramCount++;
            updates.push(`status = $${paramCount}`);
            values.push(body.status);
        }
        if (body.estimated_miles !== undefined) {
            paramCount++;
            updates.push(`estimated_miles = $${paramCount}`);
            values.push(body.estimated_miles);
        }
        if (body.estimated_duration_minutes !== undefined) {
            paramCount++;
            updates.push(`estimated_duration_minutes = $${paramCount}`);
            values.push(body.estimated_duration_minutes);
        }
        
        if (updates.length === 0) {
            return error('No fields to update', 400);
        }
        
        updates.push('updated_at = NOW()');
        values.push(id, companyId);
        
        const result = await query(
            `UPDATE route_templates SET ${updates.join(', ')} WHERE id = $${paramCount + 1} AND company_id = $${paramCount + 2} RETURNING *`,
            values
        );
        
        if (result.rows.length === 0) {
            return error('Template not found', 404);
        }
        return success(result.rows[0]);
    }

    // DELETE /templates/:id - Delete template
    if (method === 'DELETE' && path.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin'])) {
            return error('Admin access required', 403);
        }
        
        const id = path.slice(1);
        await query('DELETE FROM route_templates WHERE id = $1 AND company_id = $2', [id, companyId]);
        return success({ message: 'Template deleted' });
    }

    // POST /templates/:id/stops - Set/update stops for template
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/stops$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const templateId = path.split('/')[1];
        const body = parseBody(event);
        const { stops } = body; // Array of { customer_id, stop_number, delivery_instructions }

        // Verify template exists
        const templateCheck = await query(
            'SELECT id FROM route_templates WHERE id = $1 AND company_id = $2',
            [templateId, companyId]
        );
        if (templateCheck.rows.length === 0) {
            return error('Template not found', 404);
        }

        // Clear existing stops
        await query('DELETE FROM route_template_stops WHERE template_id = $1', [templateId]);

        // Insert new stops
        if (stops && stops.length > 0) {
            for (const stop of stops) {
                await query(
                    `INSERT INTO route_template_stops (template_id, customer_id, stop_number, distance_from_previous, time_from_previous_minutes, delivery_instructions)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [templateId, stop.customer_id, stop.stop_number, stop.distance_from_previous || null, stop.time_from_previous_minutes || null, stop.delivery_instructions || null]
                );
            }

            // Update template stats
            await query(
                `UPDATE route_templates SET total_stops = $1, updated_at = NOW() WHERE id = $2`,
                [stops.length, templateId]
            );
        }

        // Also update customers to reference this template
        const customerIds = stops.map(s => s.customer_id);
        if (customerIds.length > 0) {
            await query(
                `UPDATE customers SET route_template_id = $1, service_type = 'keep_full' WHERE id = ANY($2)`,
                [templateId, customerIds]
            );
        }

        return success({ message: 'Stops updated', count: stops?.length || 0 });
    }

    return error('Not found', 404);
}

// =====================================================
// ROUTE RUNS (Active routes being executed)
// =====================================================

async function handleRuns(method, path, companyId, user, event) {
    // GET /runs/unrouted-customers - Get customers at each DC that aren't on any scheduled route
    if (method === 'GET' && path === '/unrouted-customers') {
        // Get all active customers with their DC
        const customers = await query(
            `SELECT c.id, c.code, c.name, c.preferred_dc_id, dc.name as dc_name
             FROM customers c
             LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
             WHERE c.company_id = $1 AND c.status = 'active' AND c.lat IS NOT NULL`,
            [companyId]
        );

        // Get all customers on scheduled/in_progress routes (today and future)
        const routedCustomers = await query(
            `SELECT DISTINCT rrs.customer_id
             FROM route_run_stops rrs
             JOIN route_runs rr ON rrs.run_id = rr.id
             WHERE rr.company_id = $1 AND rr.status IN ('scheduled', 'in_progress')
             AND rr.scheduled_date >= CURRENT_DATE`,
            [companyId]
        );

        const routedIds = new Set(routedCustomers.rows.map(r => r.customer_id));
        
        // Group unrouted customers by DC
        const unroutedByDC = {};
        for (const c of customers.rows) {
            if (!routedIds.has(c.id)) {
                const dcId = c.preferred_dc_id || 'unassigned';
                if (!unroutedByDC[dcId]) {
                    unroutedByDC[dcId] = {
                        dc_id: dcId,
                        dc_name: c.dc_name || 'Unassigned',
                        customers: []
                    };
                }
                unroutedByDC[dcId].customers.push({
                    id: c.id,
                    code: c.code,
                    name: c.name
                });
            }
        }

        return success(Object.values(unroutedByDC).filter(dc => dc.customers.length > 0));
    }

    // GET /runs - List runs (with filters)
    if (method === 'GET' && path === '') {
        const params = event.queryStringParameters || {};
        let sql = `SELECT rr.*, 
                          rt.name as template_name,
                          dc.name as dc_name,
                          d.name as driver_name,
                          t.name as truck_name, t.code as truck_code
                   FROM route_runs rr
                   LEFT JOIN route_templates rt ON rr.template_id = rt.id
                   LEFT JOIN distribution_centers dc ON rr.dc_id = dc.id
                   LEFT JOIN drivers d ON rr.driver_id = d.id
                   LEFT JOIN trucks t ON rr.truck_id = t.id
                   WHERE rr.company_id = $1`;
        const queryParams = [companyId];
        let paramCount = 1;

        if (params.status) {
            paramCount++;
            sql += ` AND rr.status = $${paramCount}`;
            queryParams.push(params.status);
        }

        if (params.date) {
            paramCount++;
            sql += ` AND rr.scheduled_date = $${paramCount}`;
            queryParams.push(params.date);
        }

        if (params.driver_id) {
            paramCount++;
            sql += ` AND rr.driver_id = $${paramCount}`;
            queryParams.push(params.driver_id);
        }

        sql += ' ORDER BY rr.scheduled_date DESC, rr.created_at DESC LIMIT 100';

        const result = await query(sql, queryParams);
        return success(result.rows);
    }

    // GET /runs/:id - Get run with stops
    if (method === 'GET' && path.match(/^\/[a-f0-9-]+$/)) {
        const id = path.slice(1);
        
        const runResult = await query(
            `SELECT rr.*, 
                    rt.name as template_name,
                    dc.name as dc_name, dc.lat as dc_lat, dc.lng as dc_lng, dc.address as dc_address,
                    d.name as driver_name, d.phone as driver_phone,
                    t.name as truck_name, t.code as truck_code, t.capacity_gallons as truck_capacity
             FROM route_runs rr
             LEFT JOIN route_templates rt ON rr.template_id = rt.id
             LEFT JOIN distribution_centers dc ON rr.dc_id = dc.id
             LEFT JOIN drivers d ON rr.driver_id = d.id
             LEFT JOIN trucks t ON rr.truck_id = t.id
             WHERE rr.id = $1 AND rr.company_id = $2`,
            [id, companyId]
        );
        
        if (runResult.rows.length === 0) {
            return error('Route run not found', 404);
        }

        const stopsResult = await query(
            `SELECT rrs.*, 
                    c.name as customer_name, c.code as customer_code,
                    c.address, c.city, c.state, c.zip,
                    c.lat, c.lng, c.phone,
                    c.delivery_instructions as customer_instructions
             FROM route_run_stops rrs
             JOIN customers c ON rrs.customer_id = c.id
             WHERE rrs.run_id = $1
             ORDER BY rrs.stop_number`,
            [id]
        );

        return success({
            ...runResult.rows[0],
            stops: stopsResult.rows
        });
    }

    // POST /runs - Create a new run (from template or ad-hoc)
    if (method === 'POST' && path === '') {
        if (!requireRole(user, ['admin', 'dispatch', 'driver'])) {
            return error('Access denied', 403);
        }
        
        const body = parseBody(event);
        const { template_id, scheduled_date, dc_id, driver_id, truck_id, name, customer_ids, 
                estimated_miles, estimated_duration, fuel_price_per_gallon } = body;

        let runName = name;
        let dcId = dc_id;
        let driverId = driver_id;
        let truckId = truck_id;
        let stops = [];

        // If from template, copy settings and stops
        if (template_id) {
            const templateResult = await query(
                `SELECT * FROM route_templates WHERE id = $1 AND company_id = $2`,
                [template_id, companyId]
            );
            
            if (templateResult.rows.length === 0) {
                return error('Template not found', 404);
            }

            const template = templateResult.rows[0];
            runName = runName || template.name;
            dcId = dcId || template.dc_id;
            driverId = driverId || template.assigned_driver_id;
            truckId = truckId || template.assigned_truck_id;

            // Get template stops
            const stopsResult = await query(
                `SELECT rts.customer_id, rts.stop_number, c.tank_size, c.current_level, c.price_per_gallon
                 FROM route_template_stops rts
                 JOIN customers c ON rts.customer_id = c.id
                 WHERE rts.template_id = $1
                 ORDER BY rts.stop_number`,
                [template_id]
            );
            stops = stopsResult.rows;
        } else if (customer_ids && customer_ids.length > 0) {
            // Ad-hoc route with specific customers - preserve order from customer_ids
            const customersResult = await query(
                `SELECT id as customer_id, tank_size, current_level, price_per_gallon
                 FROM customers WHERE id = ANY($1) AND company_id = $2`,
                [customer_ids, companyId]
            );
            
            // Create a map for quick lookup
            const customerMap = {};
            customersResult.rows.forEach(c => { customerMap[c.customer_id] = c; });
            
            // Build stops in the exact order of customer_ids (preserves optimization order)
            stops = customer_ids.map((id, idx) => ({
                ...(customerMap[id] || { customer_id: id }),
                stop_number: idx + 1
            })).filter(s => customerMap[s.customer_id]); // Only include customers that exist
        }

        if (!dcId) {
            return error('Distribution center required', 400);
        }

        // Get truck info for fuel calculations
        let truckMpg = 8.0; // Default MPG
        let truckOdometer = null;
        if (truckId) {
            const truckResult = await query(
                `SELECT avg_mpg, mpg, current_odometer FROM trucks WHERE id = $1 AND company_id = $2`,
                [truckId, companyId]
            );
            if (truckResult.rows.length > 0) {
                const truck = truckResult.rows[0];
                truckMpg = parseFloat(truck.avg_mpg) || parseFloat(truck.mpg) || 8.0;
                truckOdometer = truck.current_odometer;
            }
        }

        // Get driver info for labor calculations
        let driverHourlyRate = null;
        let driverOvertimeRate = null;
        if (driverId) {
            const driverResult = await query(
                `SELECT hourly_rate, overtime_rate FROM drivers WHERE id = $1 AND company_id = $2`,
                [driverId, companyId]
            );
            if (driverResult.rows.length > 0) {
                const driver = driverResult.rows[0];
                driverHourlyRate = parseFloat(driver.hourly_rate) || null;
                driverOvertimeRate = parseFloat(driver.overtime_rate) || null;
            }
        }

        // Calculate cost estimates
        const estMiles = parseFloat(estimated_miles) || 0;
        const estDurationMinutes = parseInt(estimated_duration) || 0;
        const fuelPrice = parseFloat(fuel_price_per_gallon) || 3.50;
        
        // Fuel calculations
        const estFuelGallons = truckMpg > 0 ? estMiles / truckMpg : 0;
        const estFuelCost = estFuelGallons * fuelPrice;
        
        // Driver time calculations (add 15 min per stop for delivery time)
        const deliveryTimeMinutes = stops.length * 15;
        const totalEstMinutes = estDurationMinutes + deliveryTimeMinutes;
        const estDriverHours = totalEstMinutes / 60;
        const estDriverCost = driverHourlyRate ? estDriverHours * driverHourlyRate : 0;
        
        // Total costs
        const estTotalCost = estFuelCost + estDriverCost;

        // Create the run with all cost fields
        const runResult = await query(
            `INSERT INTO route_runs (
                company_id, template_id, name, dc_id, driver_id, truck_id, 
                scheduled_date, start_time, total_stops,
                estimated_miles, estimated_duration_minutes,
                truck_mpg, fuel_price_per_gallon, estimated_fuel_gallons, estimated_fuel_cost,
                driver_hourly_rate, driver_overtime_rate, estimated_driver_hours, estimated_driver_cost,
                estimated_total_cost, start_odometer, status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'scheduled') 
             RETURNING *`,
            [
                companyId, template_id || null, runName || 'Ad-hoc Route', dcId, driverId, truckId,
                scheduled_date || new Date().toISOString().split('T')[0], body.start_time || '08:00', stops.length,
                estMiles, totalEstMinutes,
                truckMpg, fuelPrice, estFuelGallons, estFuelCost,
                driverHourlyRate, driverOvertimeRate, estDriverHours, estDriverCost,
                estTotalCost, truckOdometer
            ]
        );

        const run = runResult.rows[0];

        // Create run stops
        for (const stop of stops) {
            await query(
                `INSERT INTO route_run_stops (run_id, customer_id, stop_number, tank_size_gallons, tank_level_before, price_per_gallon, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
                [run.id, stop.customer_id, stop.stop_number, stop.tank_size, stop.current_level, stop.price_per_gallon]
            );
        }

        return success(run, 201);
    }

    // PUT /runs/:id - Update run status
    if (method === 'PUT' && path.match(/^\/[a-f0-9-]+$/)) {
        const id = path.slice(1);
        const body = parseBody(event);
        
        const updates = [];
        const values = [];
        let paramCount = 0;

        if (body.status !== undefined) {
            paramCount++;
            updates.push(`status = $${paramCount}`);
            values.push(body.status);
            
            // Set timestamps based on status
            if (body.status === 'in_progress') {
                paramCount++;
                updates.push(`started_at = $${paramCount}`);
                values.push(new Date().toISOString());
            } else if (body.status === 'completed') {
                paramCount++;
                updates.push(`completed_at = $${paramCount}`);
                values.push(new Date().toISOString());
            }
        }

        if (body.driver_id !== undefined) {
            paramCount++;
            updates.push(`driver_id = $${paramCount}`);
            values.push(body.driver_id);
        }

        if (body.truck_id !== undefined) {
            paramCount++;
            updates.push(`truck_id = $${paramCount}`);
            values.push(body.truck_id);
        }

        if (body.notes !== undefined) {
            paramCount++;
            updates.push(`notes = $${paramCount}`);
            values.push(body.notes);
        }

        updates.push('updated_at = NOW()');
        values.push(id, companyId);

        const result = await query(
            `UPDATE route_runs SET ${updates.join(', ')} WHERE id = $${paramCount + 1} AND company_id = $${paramCount + 2} RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return error('Route run not found', 404);
        }

        // If completed, update stats
        if (body.status === 'completed') {
            await updateRunStats(id);
        }

        return success(result.rows[0]);
    }

    // PUT /runs/:id/stops/:stopId - Update a stop (driver recording delivery)
    if (method === 'PUT' && path.match(/^\/[a-f0-9-]+\/stops\/[a-f0-9-]+$/)) {
        const parts = path.split('/');
        const runId = parts[1];
        const stopId = parts[3];
        const body = parseBody(event);

        // Verify run belongs to company
        const runCheck = await query(
            'SELECT id FROM route_runs WHERE id = $1 AND company_id = $2',
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }

        const result = await query(
            `UPDATE route_run_stops SET 
                status = $1,
                arrived_at = COALESCE($2, arrived_at),
                departed_at = COALESCE($3, departed_at),
                tank_level_after = $4,
                gallons_delivered = $5,
                delivery_total = $6,
                skip_reason = $7,
                notes = $8,
                arrival_lat = $9,
                arrival_lng = $10,
                updated_at = NOW()
             WHERE id = $11 AND run_id = $12 RETURNING *`,
            [
                body.status || 'completed',
                body.arrived_at,
                body.departed_at,
                body.tank_level_after,
                body.gallons_delivered || 0,
                body.delivery_total || 0,
                body.skip_reason,
                body.notes,
                body.arrival_lat,
                body.arrival_lng,
                stopId,
                runId
            ]
        );

        if (result.rows.length === 0) {
            return error('Stop not found', 404);
        }

        const stop = result.rows[0];

        // Update customer's tank level and last delivery info
        if (body.status === 'completed' && body.gallons_delivered > 0) {
            await query(
                `UPDATE customers SET 
                    current_level = $1,
                    last_delivery_date = CURRENT_DATE,
                    last_delivery_gallons = $2,
                    updated_at = NOW()
                 WHERE id = $3`,
                [body.tank_level_after || 100, body.gallons_delivered, stop.customer_id]
            );
        }

        // Update run stats
        await updateRunStats(runId);

        return success(stop);
    }

    // POST /runs/:id/stops/:stopId/complete - Mark stop as completed (mobile-friendly)
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/stops\/[a-f0-9-]+\/complete$/)) {
        const parts = path.split('/');
        const runId = parts[1];
        const stopId = parts[3];
        const body = parseBody(event);

        // Verify run belongs to company and is in progress
        const runCheck = await query(
            'SELECT id, status FROM route_runs WHERE id = $1 AND company_id = $2',
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status !== 'in_progress') {
            return error('Route must be in progress to complete stops', 400);
        }

        // Get stop info for price calculation
        const stopInfo = await query(
            `SELECT rrs.*, c.price_per_gallon 
             FROM route_run_stops rrs 
             JOIN customers c ON rrs.customer_id = c.id 
             WHERE rrs.id = $1 AND rrs.run_id = $2`,
            [stopId, runId]
        );
        if (stopInfo.rows.length === 0) {
            return error('Stop not found', 404);
        }

        const pricePerGallon = parseFloat(stopInfo.rows[0].price_per_gallon) || 0;
        const gallonsDelivered = parseFloat(body.gallons_delivered) || 0;
        const deliveryTotal = gallonsDelivered * pricePerGallon;

        const result = await query(
            `UPDATE route_run_stops SET 
                status = 'completed',
                arrived_at = COALESCE(arrived_at, NOW()),
                departed_at = NOW(),
                tank_level_after = $1,
                gallons_delivered = $2,
                delivery_total = $3,
                notes = $4,
                updated_at = NOW()
             WHERE id = $5 AND run_id = $6 RETURNING *`,
            [
                body.tank_level_after,
                gallonsDelivered,
                deliveryTotal,
                body.notes,
                stopId,
                runId
            ]
        );

        const stop = result.rows[0];

        // Update customer's tank level and last delivery info
        if (gallonsDelivered > 0) {
            await query(
                `UPDATE customers SET 
                    current_level = $1,
                    last_delivery_date = CURRENT_DATE,
                    last_delivery_gallons = $2,
                    updated_at = NOW()
                 WHERE id = $3`,
                [body.tank_level_after || 100, gallonsDelivered, stop.customer_id]
            );

            // Record transaction in customer ledger for billing
            await query(
                `INSERT INTO customer_transactions 
                 (company_id, customer_id, transaction_type, amount, reference_type, reference_id, description, created_by)
                 VALUES ($1, $2, 'delivery', $3, 'stop', $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [companyId, stop.customer_id, deliveryTotal, stopId,
                 `Delivery: ${gallonsDelivered.toFixed(1)} gallons @ $${pricePerGallon.toFixed(3)}/gal`,
                 user.userId]
            );
        }

        // Update run stats
        await updateRunStats(runId);

        return success(stop);
    }

    // POST /runs/:id/stops/:stopId/skip - Mark stop as skipped (mobile-friendly)
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/stops\/[a-f0-9-]+\/skip$/)) {
        const parts = path.split('/');
        const runId = parts[1];
        const stopId = parts[3];
        const body = parseBody(event);

        // Verify run belongs to company and is in progress
        const runCheck = await query(
            'SELECT id, status FROM route_runs WHERE id = $1 AND company_id = $2',
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status !== 'in_progress') {
            return error('Route must be in progress to skip stops', 400);
        }

        const result = await query(
            `UPDATE route_run_stops SET 
                status = 'skipped',
                skip_reason = $1,
                updated_at = NOW()
             WHERE id = $2 AND run_id = $3 RETURNING *`,
            [body.reason || 'Not specified', stopId, runId]
        );

        if (result.rows.length === 0) {
            return error('Stop not found', 404);
        }

        // Update run stats
        await updateRunStats(runId);

        return success(result.rows[0]);
    }

    // POST /runs/:id/duplicate - Duplicate a route run for a new date (repeat tomorrow)
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/duplicate$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const runId = path.split('/')[1];
        const body = parseBody(event);
        const targetDate = body.scheduled_date || new Date(Date.now() + 86400000).toISOString().split('T')[0]; // Default to tomorrow

        // Get the original run
        const originalRun = await query(
            `SELECT * FROM route_runs WHERE id = $1 AND company_id = $2`,
            [runId, companyId]
        );
        if (originalRun.rows.length === 0) {
            return error('Route run not found', 404);
        }

        const run = originalRun.rows[0];

        // Get the original stops (in order)
        const originalStops = await query(
            `SELECT customer_id, stop_number, delivery_instructions 
             FROM route_run_stops WHERE run_id = $1 ORDER BY stop_number`,
            [runId]
        );

        // Create new run
        const newRun = await query(
            `INSERT INTO route_runs (
                company_id, dc_id, name, scheduled_date, status,
                driver_id, truck_id, estimated_miles, estimated_duration_minutes
            ) VALUES ($1, $2, $3, $4, 'scheduled', $5, $6, $7, $8)
            RETURNING *`,
            [
                companyId,
                run.dc_id,
                run.name, // Keep same name
                targetDate,
                body.driver_id || run.driver_id,
                body.truck_id || run.truck_id,
                run.estimated_miles,
                run.estimated_duration_minutes
            ]
        );

        const newRunId = newRun.rows[0].id;

        // Copy stops with fresh tank levels from customers
        for (const stop of originalStops.rows) {
            // Get current tank info for customer
            const customer = await query(
                `SELECT tank_size, current_level, price_per_gallon FROM customers WHERE id = $1`,
                [stop.customer_id]
            );
            const cust = customer.rows[0] || {};

            await query(
                `INSERT INTO route_run_stops (
                    run_id, customer_id, stop_number, status,
                    tank_size_gallons, tank_level_before, price_per_gallon, delivery_instructions
                ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
                [
                    newRunId,
                    stop.customer_id,
                    stop.stop_number,
                    cust.tank_size || 500,
                    cust.current_level || 50,
                    cust.price_per_gallon || 0,
                    stop.delivery_instructions
                ]
            );
        }

        return success({
            message: 'Route duplicated successfully',
            new_run_id: newRunId,
            scheduled_date: targetDate,
            stops_count: originalStops.rows.length
        });
    }

    // POST /runs/:id/stops/:stopId/complete-products - Complete stop with product delivery
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/stops\/[a-f0-9-]+\/complete-products$/)) {
        const parts = path.split('/');
        const runId = parts[1];
        const stopId = parts[3];
        const body = parseBody(event);

        // Verify run belongs to company and is in progress
        const runCheck = await query(
            'SELECT rr.id, rr.status, rr.truck_id FROM route_runs rr WHERE rr.id = $1 AND rr.company_id = $2',
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status !== 'in_progress') {
            return error('Route must be in progress to complete stops', 400);
        }

        const truckId = runCheck.rows[0].truck_id;

        // Get stop info
        const stopInfo = await query(
            `SELECT rrs.*, c.id as customer_id 
             FROM route_run_stops rrs 
             JOIN customers c ON rrs.customer_id = c.id 
             WHERE rrs.id = $1 AND rrs.run_id = $2`,
            [stopId, runId]
        );
        if (stopInfo.rows.length === 0) {
            return error('Stop not found', 404);
        }

        const customerId = stopInfo.rows[0].customer_id;
        const items = body.items || [];
        let itemsTotal = 0;
        let depositsCollected = 0;
        let depositsRefunded = 0;
        let totalGallonEquivalent = 0;
        const deliveredProducts = []; // Track for transaction description

        // Process each item
        for (const item of items) {
            // Get product info with customer-specific pricing
            const productInfo = await query(
                `SELECT p.*, 
                        COALESCE(cp.custom_price, p.default_price) as effective_price,
                        cp.is_enabled
                 FROM products p
                 LEFT JOIN customer_products cp ON p.id = cp.product_id AND cp.customer_id = $1
                 WHERE p.id = $2 AND p.company_id = $3`,
                [customerId, item.product_id, companyId]
            );

            if (productInfo.rows.length === 0) continue;
            
            const product = productInfo.rows[0];
            const qtyDelivered = parseInt(item.quantity_delivered) || 0;
            const qtyCollected = parseInt(item.quantity_collected) || 0;
            const unitPrice = parseFloat(product.effective_price) || 0;
            const lineTotal = qtyDelivered * unitPrice;
            
            // Track for description
            if (qtyDelivered > 0 || qtyCollected > 0) {
                let desc = `${qtyDelivered} ${product.name}`;
                if (qtyCollected > 0) desc += ` (${qtyCollected} returned)`;
                deliveredProducts.push(desc);
            }
            
            // Calculate deposits
            let itemDepositsCollected = 0;
            let itemDepositsRefunded = 0;
            if (product.is_exchangeable && product.deposit_amount > 0) {
                // New deliveries = collect deposit, returns = refund deposit
                if (qtyDelivered > qtyCollected) {
                    itemDepositsCollected = (qtyDelivered - qtyCollected) * product.deposit_amount;
                } else if (qtyCollected > qtyDelivered) {
                    itemDepositsRefunded = (qtyCollected - qtyDelivered) * product.deposit_amount;
                }
            }

            // Insert delivery item record
            await query(
                `INSERT INTO delivery_items 
                 (company_id, stop_id, product_id, quantity_delivered, quantity_collected, 
                  unit_price, line_total, deposit_collected, deposit_refunded, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [companyId, stopId, item.product_id, qtyDelivered, qtyCollected,
                 unitPrice, lineTotal, itemDepositsCollected, itemDepositsRefunded, item.notes]
            );

            itemsTotal += lineTotal;
            depositsCollected += itemDepositsCollected;
            depositsRefunded += itemDepositsRefunded;

            // Calculate gallon equivalent for reporting (only if product has it defined)
            if (product.gallon_equivalent && qtyDelivered > 0) {
                totalGallonEquivalent += qtyDelivered * parseFloat(product.gallon_equivalent);
            }

            // Update truck inventory if tracking enabled
            if (truckId && product.track_inventory) {
                // Decrease inventory for deliveries
                if (qtyDelivered > 0) {
                    await query(
                        `UPDATE truck_inventory 
                         SET quantity = quantity - $1, updated_at = NOW()
                         WHERE truck_id = $2 AND product_id = $3`,
                        [qtyDelivered, truckId, item.product_id]
                    );
                    
                    // Log the change
                    await query(
                        `INSERT INTO truck_inventory_log 
                         (company_id, truck_id, product_id, change_type, quantity_change, stop_id, run_id, user_id)
                         VALUES ($1, $2, $3, 'delivery', $4, $5, $6, $7)`,
                        [companyId, truckId, item.product_id, -qtyDelivered, stopId, runId, user.userId]
                    );
                }

                // Increase inventory for collections (empties)
                if (qtyCollected > 0) {
                    await query(
                        `UPDATE truck_inventory 
                         SET quantity = quantity + $1, updated_at = NOW()
                         WHERE truck_id = $2 AND product_id = $3`,
                        [qtyCollected, truckId, item.product_id]
                    );
                    
                    await query(
                        `INSERT INTO truck_inventory_log 
                         (company_id, truck_id, product_id, change_type, quantity_change, stop_id, run_id, user_id)
                         VALUES ($1, $2, $3, 'collection', $4, $5, $6, $7)`,
                        [companyId, truckId, item.product_id, qtyCollected, stopId, runId, user.userId]
                    );
                }
            }
        }

        // Calculate final delivery total
        const deliveryTotal = itemsTotal + depositsCollected - depositsRefunded;

        // Update the stop record
        const result = await query(
            `UPDATE route_run_stops SET 
                status = 'completed',
                arrived_at = COALESCE(arrived_at, NOW()),
                departed_at = NOW(),
                delivery_model = 'products',
                gallons_delivered = $1,
                delivery_total = $2,
                items_total = $3,
                deposits_collected = $4,
                deposits_refunded = $5,
                notes = $6,
                updated_at = NOW()
             WHERE id = $7 AND run_id = $8 RETURNING *`,
            [totalGallonEquivalent, deliveryTotal, itemsTotal, depositsCollected, depositsRefunded, body.notes, stopId, runId]
        );

        // Update customer record with delivery info
        await query(
            `UPDATE customers SET 
                last_delivery_date = CURRENT_DATE,
                updated_at = NOW()
             WHERE id = $1`,
            [customerId]
        );
        
        // Only update gallon equivalent if products have it (for propane-type products)
        if (totalGallonEquivalent > 0) {
            await query(
                `UPDATE customers SET 
                    last_delivery_gallons = COALESCE(last_delivery_gallons, 0) + $1
                 WHERE id = $2`,
                [totalGallonEquivalent, customerId]
            );
        }

        // Calculate total items delivered and collected
        const totalDelivered = items.reduce((sum, i) => sum + (parseInt(i.quantity_delivered) || 0), 0);
        const totalCollected = items.reduce((sum, i) => sum + (parseInt(i.quantity_collected) || 0), 0);

        // Build detailed transaction description
        const txDescription = deliveredProducts.length > 0 
            ? deliveredProducts.join(', ')
            : `Delivery: $${deliveryTotal.toFixed(2)}`;

        // Record transaction in customer ledger for billing
        await query(
            `INSERT INTO customer_transactions 
             (company_id, customer_id, transaction_type, amount, items_delivered, items_collected, reference_type, reference_id, description, created_by)
             VALUES ($1, $2, 'delivery', $3, $4, $5, 'stop', $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [companyId, customerId, deliveryTotal, totalDelivered, totalCollected, stopId, txDescription, user.userId]
        );

        // Update run stats
        await updateRunStats(runId);

        // Return stop with items
        const deliveryItems = await query(
            `SELECT di.*, p.name as product_name, p.code as product_code
             FROM delivery_items di
             JOIN products p ON di.product_id = p.id
             WHERE di.stop_id = $1`,
            [stopId]
        );

        return success({
            ...result.rows[0],
            items: deliveryItems.rows
        });
    }

    // POST /runs/:id/stops - Add a customer to an existing route
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/stops$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const runId = path.split('/')[1];
        const body = parseBody(event);
        const { customer_id, stop_number, after_stop_id } = body;

        // Verify run belongs to company and is still editable
        const runCheck = await query(
            `SELECT rr.id, rr.status, rr.dc_id FROM route_runs rr WHERE rr.id = $1 AND rr.company_id = $2`,
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status === 'completed' || runCheck.rows[0].status === 'cancelled') {
            return error('Cannot modify a completed or cancelled route', 400);
        }

        // Verify customer exists and belongs to company
        const customerCheck = await query(
            `SELECT id, name, tank_size, current_level, price_per_gallon FROM customers WHERE id = $1 AND company_id = $2`,
            [customer_id, companyId]
        );
        if (customerCheck.rows.length === 0) {
            return error('Customer not found', 404);
        }

        // Check if customer is already on this route
        const existingStop = await query(
            `SELECT id FROM route_run_stops WHERE run_id = $1 AND customer_id = $2`,
            [runId, customer_id]
        );
        if (existingStop.rows.length > 0) {
            return error('Customer is already on this route', 400);
        }

        // Determine stop number
        let newStopNumber = stop_number;
        if (!newStopNumber) {
            if (after_stop_id) {
                // Insert after specific stop
                const afterStop = await query(
                    `SELECT stop_number FROM route_run_stops WHERE id = $1 AND run_id = $2`,
                    [after_stop_id, runId]
                );
                if (afterStop.rows.length > 0) {
                    newStopNumber = afterStop.rows[0].stop_number + 1;
                    // Shift subsequent stops
                    await query(
                        `UPDATE route_run_stops SET stop_number = stop_number + 1 WHERE run_id = $1 AND stop_number >= $2`,
                        [runId, newStopNumber]
                    );
                }
            }
            if (!newStopNumber) {
                // Add at end
                const maxStop = await query(
                    `SELECT COALESCE(MAX(stop_number), 0) as max_num FROM route_run_stops WHERE run_id = $1`,
                    [runId]
                );
                newStopNumber = maxStop.rows[0].max_num + 1;
            }
        }

        const cust = customerCheck.rows[0];
        const result = await query(
            `INSERT INTO route_run_stops (run_id, customer_id, stop_number, tank_size_gallons, tank_level_before, price_per_gallon, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
            [runId, customer_id, newStopNumber, cust.tank_size, cust.current_level, cust.price_per_gallon]
        );

        // Update run total_stops
        await query(`UPDATE route_runs SET total_stops = total_stops + 1, updated_at = NOW() WHERE id = $1`, [runId]);

        return success(result.rows[0]);
    }

    // DELETE /runs/:id/stops/:stopId - Remove a customer from a route
    if (method === 'DELETE' && path.match(/^\/[a-f0-9-]+\/stops\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const parts = path.split('/');
        const runId = parts[1];
        const stopId = parts[3];

        // Verify run belongs to company and is editable
        const runCheck = await query(
            `SELECT id, status FROM route_runs WHERE id = $1 AND company_id = $2`,
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status === 'completed' || runCheck.rows[0].status === 'cancelled') {
            return error('Cannot modify a completed or cancelled route', 400);
        }

        // Get stop number before deleting
        const stopCheck = await query(
            `SELECT stop_number, status FROM route_run_stops WHERE id = $1 AND run_id = $2`,
            [stopId, runId]
        );
        if (stopCheck.rows.length === 0) {
            return error('Stop not found', 404);
        }
        if (stopCheck.rows[0].status === 'completed') {
            return error('Cannot remove a completed stop', 400);
        }

        const removedStopNumber = stopCheck.rows[0].stop_number;

        // Delete the stop
        await query(`DELETE FROM route_run_stops WHERE id = $1`, [stopId]);

        // Renumber subsequent stops
        await query(
            `UPDATE route_run_stops SET stop_number = stop_number - 1 WHERE run_id = $1 AND stop_number > $2`,
            [runId, removedStopNumber]
        );

        // Update run total_stops
        await query(`UPDATE route_runs SET total_stops = total_stops - 1, updated_at = NOW() WHERE id = $1`, [runId]);

        return success({ message: 'Stop removed' });
    }

    // PUT /runs/:id/reorder - Reorder stops on a route
    if (method === 'PUT' && path.match(/^\/[a-f0-9-]+\/reorder$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const runId = path.split('/')[1];
        const body = parseBody(event);
        const { stop_order } = body; // Array of stop IDs in new order

        // Verify run belongs to company and is editable
        const runCheck = await query(
            `SELECT id, status FROM route_runs WHERE id = $1 AND company_id = $2`,
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status === 'completed' || runCheck.rows[0].status === 'cancelled') {
            return error('Cannot modify a completed or cancelled route', 400);
        }

        // Update each stop's position
        for (let i = 0; i < stop_order.length; i++) {
            await query(
                `UPDATE route_run_stops SET stop_number = $1, updated_at = NOW() WHERE id = $2 AND run_id = $3`,
                [i + 1, stop_order[i], runId]
            );
        }

        return success({ message: 'Stops reordered' });
    }

    // POST /runs/:id/reoptimize - Re-optimize an existing route
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/reoptimize$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const runId = path.split('/')[1];

        // Verify run belongs to company and is editable
        const runCheck = await query(
            `SELECT rr.id, rr.status, rr.dc_id, dc.lat as dc_lat, dc.lng as dc_lng
             FROM route_runs rr
             JOIN distribution_centers dc ON rr.dc_id = dc.id
             WHERE rr.id = $1 AND rr.company_id = $2`,
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status === 'completed' || runCheck.rows[0].status === 'cancelled') {
            return error('Cannot modify a completed or cancelled route', 400);
        }

        const run = runCheck.rows[0];

        // Get current stops with pending status only
        const stopsResult = await query(
            `SELECT rrs.id, rrs.customer_id, c.lat, c.lng, c.name
             FROM route_run_stops rrs
             JOIN customers c ON rrs.customer_id = c.id
             WHERE rrs.run_id = $1 AND rrs.status = 'pending'
             ORDER BY rrs.stop_number`,
            [runId]
        );

        if (stopsResult.rows.length < 2) {
            return error('Need at least 2 pending stops to re-optimize', 400);
        }

        const pendingStops = stopsResult.rows;

        // Build locations array with DC as depot
        const depot = { lat: parseFloat(run.dc_lat), lng: parseFloat(run.dc_lng) };
        const locations = [depot, ...pendingStops.map(s => ({ lat: parseFloat(s.lat), lng: parseFloat(s.lng) }))];

        // Use nearest neighbor algorithm to optimize
        const optimizedOrder = nearestNeighborRoute(locations);
        
        // Map back to stop IDs (skip depot at index 0)
        const newOrder = optimizedOrder.slice(1).map(idx => pendingStops[idx - 1].id);

        // Update stop numbers
        for (let i = 0; i < newOrder.length; i++) {
            await query(
                `UPDATE route_run_stops SET stop_number = $1, updated_at = NOW() WHERE id = $2 AND run_id = $3`,
                [i + 1, newOrder[i], runId]
            );
        }

        return success({ message: 'Route re-optimized', new_order: newOrder });
    }

    // DELETE /runs/:id - Delete an entire route (if scheduled)
    if (method === 'DELETE' && path.match(/^\/[a-f0-9-]+$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const runId = path.slice(1);

        // Verify run belongs to company and is deletable
        const runCheck = await query(
            `SELECT id, status FROM route_runs WHERE id = $1 AND company_id = $2`,
            [runId, companyId]
        );
        if (runCheck.rows.length === 0) {
            return error('Route run not found', 404);
        }
        if (runCheck.rows[0].status === 'in_progress') {
            return error('Cannot delete a route that is in progress. Complete or cancel it first.', 400);
        }

        // Delete stops first (cascade should handle this, but being explicit)
        await query(`DELETE FROM route_run_stops WHERE run_id = $1`, [runId]);
        
        // Delete the run
        await query(`DELETE FROM route_runs WHERE id = $1 AND company_id = $2`, [runId, companyId]);

        return success({ message: 'Route deleted' });
    }

    // POST /runs/:id/clone - Clone a route for another day
    if (method === 'POST' && path.match(/^\/[a-f0-9-]+\/clone$/)) {
        if (!requireRole(user, ['admin', 'dispatch'])) {
            return error('Access denied', 403);
        }
        
        const sourceRunId = path.split('/')[1];
        const body = parseBody(event);
        const { scheduled_date, driver_id, truck_id } = body;

        // Get source run
        const sourceRun = await query(
            `SELECT * FROM route_runs WHERE id = $1 AND company_id = $2`,
            [sourceRunId, companyId]
        );
        if (sourceRun.rows.length === 0) {
            return error('Source route not found', 404);
        }

        const src = sourceRun.rows[0];

        // Create new run
        const newRun = await query(
            `INSERT INTO route_runs (
                company_id, template_id, name, dc_id, driver_id, truck_id, 
                scheduled_date, start_time, total_stops,
                estimated_miles, estimated_duration_minutes,
                truck_mpg, fuel_price_per_gallon, estimated_fuel_gallons, estimated_fuel_cost,
                driver_hourly_rate, driver_overtime_rate, estimated_driver_hours, estimated_driver_cost,
                estimated_total_cost, status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'scheduled')
             RETURNING *`,
            [
                companyId, src.template_id, src.name + ' (Copy)', src.dc_id, 
                driver_id || src.driver_id, truck_id || src.truck_id,
                scheduled_date || new Date().toISOString().split('T')[0], src.start_time, src.total_stops,
                src.estimated_miles, src.estimated_duration_minutes,
                src.truck_mpg, src.fuel_price_per_gallon, src.estimated_fuel_gallons, src.estimated_fuel_cost,
                src.driver_hourly_rate, src.driver_overtime_rate, src.estimated_driver_hours, src.estimated_driver_cost,
                src.estimated_total_cost
            ]
        );

        const newRunId = newRun.rows[0].id;

        // Copy stops
        const sourceStops = await query(
            `SELECT customer_id, stop_number, tank_size_gallons, price_per_gallon FROM route_run_stops WHERE run_id = $1 ORDER BY stop_number`,
            [sourceRunId]
        );

        for (const stop of sourceStops.rows) {
            // Get current tank level for customer
            const custResult = await query(`SELECT current_level FROM customers WHERE id = $1`, [stop.customer_id]);
            const currentLevel = custResult.rows[0]?.current_level || 50;

            await query(
                `INSERT INTO route_run_stops (run_id, customer_id, stop_number, tank_size_gallons, tank_level_before, price_per_gallon, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
                [newRunId, stop.customer_id, stop.stop_number, stop.tank_size_gallons, currentLevel, stop.price_per_gallon]
            );
        }

        return success(newRun.rows[0]);
    }

    return error('Not found', 404);
}

// =====================================================
// UPDATE RUN STATS
// =====================================================

async function updateRunStats(runId) {
    const statsResult = await query(
        `SELECT 
            COUNT(*) as total_stops,
            COUNT(*) FILTER (WHERE status IN ('completed', 'skipped')) as stops_completed,
            COALESCE(SUM(gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(delivery_total), 0) as total_revenue
         FROM route_run_stops WHERE run_id = $1`,
        [runId]
    );

    const stats = statsResult.rows[0];
    await query(
        `UPDATE route_runs SET 
            stops_completed = $1,
            total_gallons_delivered = $2,
            total_revenue = $3,
            updated_at = NOW()
         WHERE id = $4`,
        [stats.stops_completed, stats.total_gallons, stats.total_revenue, runId]
    );
}

// =====================================================
// OPTIMIZE STOPS
// =====================================================

async function optimizeStops(companyId, event) {
    const body = parseBody(event);
    const { dc_id, customer_ids, use_google = true } = body;

    if (!dc_id) {
        return error('Distribution center required', 400);
    }

    if (!customer_ids || customer_ids.length < 2) {
        return error('At least 2 customers required', 400);
    }

    // Get DC location
    const dcResult = await query(
        'SELECT id, name, lat, lng FROM distribution_centers WHERE id = $1 AND company_id = $2',
        [dc_id, companyId]
    );
    if (dcResult.rows.length === 0 || !dcResult.rows[0].lat) {
        return error('Distribution center not found or missing coordinates', 400);
    }
    const dc = dcResult.rows[0];

    // Get customer locations
    const customersResult = await query(
        `SELECT id, name, lat, lng, address, city, state, tank_size, current_level 
         FROM customers WHERE id = ANY($1) AND company_id = $2 AND lat IS NOT NULL`,
        [customer_ids, companyId]
    );

    if (customersResult.rows.length < 2) {
        return error('Not enough customers with valid coordinates', 400);
    }

    const customers = customersResult.rows;
    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

    let optimizedStops = [];
    let totalMiles = 0;
    let totalDriveMinutes = 0;
    let method = 'haversine';
    let polyline = null;

    // Try Google Directions API optimization (best for <= 25 waypoints)
    if (use_google && GOOGLE_MAPS_API_KEY && customers.length <= 25) {
        try {
            const waypointStr = customers.map(c => `${c.lat},${c.lng}`).join('|');
            const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${dc.lat},${dc.lng}&destination=${dc.lat},${dc.lng}&waypoints=optimize:true|${encodeURIComponent(waypointStr)}&key=${GOOGLE_MAPS_API_KEY}`;
            
            
            const response = await fetch(url);
            const data = await response.json();
            
            
            
            if (data.routes?.[0]) {
                
                
            }

            if (data.status === 'OK' && data.routes[0]) {
                const route = data.routes[0];
                const optimizedOrder = route.waypoint_order;
                
                // Calculate totals from legs
                for (const leg of route.legs) {
                    totalMiles += leg.distance.value * 0.000621371;
                    totalDriveMinutes += leg.duration.value / 60;
                }

                // Build stops in optimized order
                for (let i = 0; i < optimizedOrder.length; i++) {
                    const custIdx = optimizedOrder[i];
                    const cust = customers[custIdx];
                    const leg = route.legs[i];
                    
                    optimizedStops.push({
                        customer_id: cust.id,
                        customer_name: cust.name,
                        address: cust.address,
                        city: cust.city,
                        state: cust.state,
                        lat: parseFloat(cust.lat),
                        lng: parseFloat(cust.lng),
                        tank_size: cust.tank_size,
                        current_level: cust.current_level,
                        stop_number: i + 1,
                        distance_from_previous: Math.round(leg.distance.value * 0.000621371 * 10) / 10,
                        time_from_previous_minutes: Math.round(leg.duration.value / 60)
                    });
                }

                method = 'google_directions';
                polyline = route.overview_polyline?.points;
                
                console.log(`Google optimization: ${customers.length} stops, ${totalMiles.toFixed(1)} miles, ${totalDriveMinutes.toFixed(0)} min`);
                
            }
        } catch (err) {
            console.error('Google Directions API error:', err);
        }
    }

    // Fallback to local optimization with advanced algorithms
    if (optimizedStops.length === 0) {
        const depot = { lat: parseFloat(dc.lat), lng: parseFloat(dc.lng) };
        
        // Use advanced optimization with priority awareness, 2-opt, and or-opt
        const priorityWeight = body.priority_weight || 0.25; // Balance between distance and urgency
        const optimized = optimizeRouteAdvanced(customers, depot, {
            priorityWeight,
            use2Opt: true,
            useOrOpt: customers.length >= 4
        });
        
        let prevLat = depot.lat;
        let prevLng = depot.lng;

        for (let i = 0; i < optimized.length; i++) {
            const cust = optimized[i];
            const dist = haversineDistance(prevLat, prevLng, parseFloat(cust.lat), parseFloat(cust.lng));
            const timeMin = (dist / 35) * 60; // Assume 35 mph average
            
            totalMiles += dist;
            totalDriveMinutes += timeMin;
            
            // Calculate urgency for this stop
            const urgency = calculateUrgency(cust);
            const urgencyLevel = urgency > 80 ? 'critical' : urgency > 50 ? 'high' : urgency > 30 ? 'medium' : 'low';
            
            optimizedStops.push({
                customer_id: cust.id,
                customer_name: cust.name,
                address: cust.address,
                city: cust.city,
                state: cust.state,
                lat: parseFloat(cust.lat),
                lng: parseFloat(cust.lng),
                tank_size: cust.tank_size,
                current_level: cust.current_level,
                urgency_score: Math.round(urgency),
                urgency_level: urgencyLevel,
                stop_number: i + 1,
                distance_from_previous: Math.round(dist * 10) / 10,
                time_from_previous_minutes: Math.round(timeMin)
            });

            prevLat = parseFloat(cust.lat);
            prevLng = parseFloat(cust.lng);
        }

        // Add return to depot distance
        const returnDist = haversineDistance(prevLat, prevLng, depot.lat, depot.lng);
        totalMiles += returnDist;
        totalDriveMinutes += (returnDist / 35) * 60;
        
        method = 'advanced_local';
        console.log(`Advanced optimization: ${customers.length} stops, ${totalMiles.toFixed(1)} miles (priority_weight: ${priorityWeight})`);
    }

    // Estimate stop time (default 15 min per stop)
    const stopTimeMinutes = optimizedStops.length * 15;
    const totalTimeMinutes = totalDriveMinutes + stopTimeMinutes;

    // Count priority levels
    const priorityStats = {
        critical: optimizedStops.filter(s => s.urgency_level === 'critical').length,
        high: optimizedStops.filter(s => s.urgency_level === 'high').length,
        medium: optimizedStops.filter(s => s.urgency_level === 'medium').length,
        low: optimizedStops.filter(s => s.urgency_level === 'low').length
    };

    return success({
        optimization_method: method,
        google_api_used: method === 'google_directions',
        stops: optimizedStops,
        summary: {
            total_stops: optimizedStops.length,
            total_miles: Math.round(totalMiles * 10) / 10,
            estimated_drive_time_minutes: Math.round(totalDriveMinutes),
            estimated_stop_time_minutes: stopTimeMinutes,
            estimated_total_time_minutes: Math.round(totalTimeMinutes),
            priority_stops: priorityStats
        },
        distribution_center: {
            id: dc.id,
            name: dc.name,
            lat: parseFloat(dc.lat),
            lng: parseFloat(dc.lng)
        },
        polyline: polyline
    });
}

// Haversine distance in miles
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

// Calculate urgency score for a customer (higher = more urgent)
function calculateUrgency(customer) {
    const level = parseFloat(customer.current_level) || 50;
    const tankSize = parseFloat(customer.tank_size) || 500;
    
    // Base urgency from tank level (0-100 scale, inverted)
    let urgency = 100 - level;
    
    // Critical urgency boost for very low tanks
    if (level <= 10) urgency += 50;
    else if (level <= 20) urgency += 30;
    else if (level <= 30) urgency += 15;
    
    // Larger tanks = more urgent (they use more)
    if (tankSize >= 1000) urgency += 10;
    else if (tankSize >= 500) urgency += 5;
    
    return urgency;
}

// Build distance matrix for a set of locations
function buildDistanceMatrix(locations) {
    const n = locations.length;
    const matrix = [];
    for (let i = 0; i < n; i++) {
        matrix[i] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) {
                matrix[i][j] = 0;
            } else {
                matrix[i][j] = haversineDistance(
                    locations[i].lat, locations[i].lng,
                    locations[j].lat, locations[j].lng
                );
            }
        }
    }
    return matrix;
}

// Calculate total route distance
function calculateRouteDistance(route, matrix) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
        total += matrix[route[i]][route[i + 1]];
    }
    return total;
}

// 2-opt improvement - reverses segments to reduce crossings
function twoOptImprove(route, matrix, maxIterations = 500) {
    let improved = true;
    let iterations = 0;
    let bestRoute = [...route];
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        
        for (let i = 1; i < bestRoute.length - 2; i++) {
            for (let j = i + 1; j < bestRoute.length - 1; j++) {
                // Calculate improvement from reversing segment [i, j]
                const a = bestRoute[i - 1];
                const b = bestRoute[i];
                const c = bestRoute[j];
                const d = bestRoute[j + 1];
                
                const currentDist = matrix[a][b] + matrix[c][d];
                const newDist = matrix[a][c] + matrix[b][d];
                
                if (newDist < currentDist - 0.01) {
                    // Reverse the segment
                    const newRoute = bestRoute.slice(0, i);
                    const reversed = bestRoute.slice(i, j + 1).reverse();
                    const rest = bestRoute.slice(j + 1);
                    bestRoute = [...newRoute, ...reversed, ...rest];
                    improved = true;
                }
            }
        }
    }
    
    return bestRoute;
}

// Or-opt improvement - moves sequences of 1-3 stops to better positions
function orOptImprove(route, matrix) {
    let improved = true;
    let bestRoute = [...route];
    
    while (improved) {
        improved = false;
        
        // Try moving sequences of 1, 2, or 3 consecutive stops
        for (let seqLen = 1; seqLen <= 3; seqLen++) {
            for (let i = 1; i < bestRoute.length - seqLen - 1; i++) {
                for (let j = 1; j < bestRoute.length - 1; j++) {
                    if (j >= i - 1 && j <= i + seqLen) continue; // Skip overlapping positions
                    
                    // Calculate current cost of sequence at position i
                    const before = bestRoute[i - 1];
                    const seqStart = bestRoute[i];
                    const seqEnd = bestRoute[i + seqLen - 1];
                    const after = bestRoute[i + seqLen];
                    
                    const currentCost = matrix[before][seqStart] + matrix[seqEnd][after];
                    
                    // Calculate new cost if sequence moved to position j
                    const insertBefore = bestRoute[j];
                    const insertAfter = bestRoute[j + 1];
                    
                    // Cost to remove sequence
                    const removeCost = -currentCost + matrix[before][after];
                    
                    // Cost to insert sequence
                    const insertCost = matrix[insertBefore][seqStart] + matrix[seqEnd][insertAfter] - matrix[insertBefore][insertAfter];
                    
                    if (removeCost + insertCost < -0.01) {
                        // Move the sequence
                        const seq = bestRoute.splice(i, seqLen);
                        const newJ = j > i ? j - seqLen : j;
                        bestRoute.splice(newJ + 1, 0, ...seq);
                        improved = true;
                        break;
                    }
                }
                if (improved) break;
            }
            if (improved) break;
        }
    }
    
    return bestRoute;
}

// Nearest Neighbor with priority awareness
function nearestNeighborWithPriority(customers, depot, priorityWeight = 0.3) {
    const unvisited = customers.map((c, idx) => ({
        ...c,
        idx,
        lat: parseFloat(c.lat),
        lng: parseFloat(c.lng),
        urgency: calculateUrgency(c)
    }));
    
    const route = [];
    let current = { lat: depot.lat, lng: depot.lng };
    
    // Find max distance for normalization
    let maxDist = 0;
    for (const c of unvisited) {
        const d = haversineDistance(current.lat, current.lng, c.lat, c.lng);
        if (d > maxDist) maxDist = d;
    }
    maxDist = maxDist || 1;

    while (unvisited.length > 0) {
        let bestIdx = 0;
        let bestScore = Infinity;

        for (let i = 0; i < unvisited.length; i++) {
            const c = unvisited[i];
            const dist = haversineDistance(current.lat, current.lng, c.lat, c.lng);
            
            // Normalized distance (0-1)
            const normalizedDist = dist / maxDist;
            
            // Normalized urgency (0-1, inverted so high urgency = low score)
            const normalizedUrgency = 1 - (c.urgency / 150);
            
            // Combined score (lower is better)
            // priorityWeight controls balance between distance and urgency
            const score = (1 - priorityWeight) * normalizedDist + priorityWeight * normalizedUrgency;
            
            if (score < bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        const best = unvisited.splice(bestIdx, 1)[0];
        route.push(best);
        current = { lat: best.lat, lng: best.lng };
    }

    return route;
}

// Full optimization pipeline
function optimizeRouteAdvanced(customers, depot, options = {}) {
    const { priorityWeight = 0.3, use2Opt = true, useOrOpt = true } = options;
    
    if (customers.length === 0) return [];
    if (customers.length === 1) return [customers[0]];
    
    // Step 1: Build initial route with priority-aware nearest neighbor
    let route = nearestNeighborWithPriority(customers, depot, priorityWeight);
    
    if (route.length < 3) return route;
    
    // Step 2: Build distance matrix for improvements
    const locations = [depot, ...route.map(c => ({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) }))];
    const matrix = buildDistanceMatrix(locations);
    
    // Convert route to indices (0 = depot, 1..n = customers)
    let routeIndices = [0, ...route.map((_, i) => i + 1), 0]; // Start and end at depot
    
    // Step 3: Apply 2-opt improvement
    if (use2Opt) {
        routeIndices = twoOptImprove(routeIndices, matrix);
    }
    
    // Step 4: Apply Or-opt improvement
    if (useOrOpt && route.length >= 4) {
        routeIndices = orOptImprove(routeIndices, matrix);
    }
    
    // Convert back to customer objects (remove depot indices)
    const optimizedRoute = routeIndices
        .filter(i => i !== 0)
        .map(i => route[i - 1]);
    
    return optimizedRoute;
}

// Legacy: Nearest Neighbor optimization (kept for compatibility)
function nearestNeighborOptimize(customers, depot) {
    // Use the advanced optimizer with default settings
    return optimizeRouteAdvanced(customers, depot, { priorityWeight: 0.2 });
}

// Nearest Neighbor that returns indices (for re-optimization)
function nearestNeighborRoute(locations) {
    // locations[0] is the depot
    const depot = locations[0];
    const stops = locations.slice(1);
    const n = stops.length;
    
    const visited = new Array(n).fill(false);
    const route = [0]; // Start with depot index
    let current = depot;
    
    for (let i = 0; i < n; i++) {
        let nearestIdx = -1;
        let nearestDist = Infinity;
        
        for (let j = 0; j < n; j++) {
            if (visited[j]) continue;
            const dist = haversineDistance(
                current.lat, current.lng,
                stops[j].lat, stops[j].lng
            );
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestIdx = j;
            }
        }
        
        if (nearestIdx >= 0) {
            visited[nearestIdx] = true;
            route.push(nearestIdx + 1); // +1 because stops are offset from locations
            current = stops[nearestIdx];
        }
    }
    
    return route;
}
