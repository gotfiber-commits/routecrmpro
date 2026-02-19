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

    // Fallback to local optimization with Haversine distances
    if (optimizedStops.length === 0) {
        console.log('Using local Haversine optimization...');
        
        const depot = { lat: parseFloat(dc.lat), lng: parseFloat(dc.lng) };
        const optimized = nearestNeighborOptimize(customers, depot);
        
        let prevLat = depot.lat;
        let prevLng = depot.lng;

        for (let i = 0; i < optimized.length; i++) {
            const cust = optimized[i];
            const dist = haversineDistance(prevLat, prevLng, parseFloat(cust.lat), parseFloat(cust.lng));
            const timeMin = (dist / 35) * 60; // Assume 35 mph average
            
            totalMiles += dist;
            totalDriveMinutes += timeMin;
            
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
        
        method = 'haversine';
    }

    // Estimate stop time (default 15 min per stop)
    const stopTimeMinutes = optimizedStops.length * 15;
    const totalTimeMinutes = totalDriveMinutes + stopTimeMinutes;

    return success({
        optimization_method: method,
        google_api_used: method === 'google_directions',
        stops: optimizedStops,
        summary: {
            total_stops: optimizedStops.length,
            total_miles: Math.round(totalMiles * 10) / 10,
            estimated_drive_time_minutes: Math.round(totalDriveMinutes),
            estimated_stop_time_minutes: stopTimeMinutes,
            estimated_total_time_minutes: Math.round(totalTimeMinutes)
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

// Nearest Neighbor optimization
function nearestNeighborOptimize(customers, depot) {
    const unvisited = [...customers];
    const route = [];
    let current = { lat: depot.lat, lng: depot.lng };

    while (unvisited.length > 0) {
        let nearestIdx = 0;
        let nearestDist = Infinity;

        for (let i = 0; i < unvisited.length; i++) {
            const dist = haversineDistance(
                current.lat, current.lng,
                parseFloat(unvisited[i].lat), parseFloat(unvisited[i].lng)
            );
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestIdx = i;
            }
        }

        const nearest = unvisited.splice(nearestIdx, 1)[0];
        route.push(nearest);
        current = { lat: parseFloat(nearest.lat), lng: parseFloat(nearest.lng) };
    }

    return route;
}
