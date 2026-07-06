// =====================================================
// IMPORT API - Customer & Delivery History Import
// =====================================================
// Handles CSV/JSON imports for customers and their delivery history
// to populate the prediction system with historical data

const { query } = require('./utils/db');
const { success, error, parseBody } = require('./utils/response');
const { authenticateRequest } = require('./utils/auth');

exports.handler = async (event) => {
    try {
        const { user, companyId, role } = await authenticateRequest(event);
        if (!user) return error('Unauthorized', 401);

        // Only admin can import
        if (role !== 'admin') {
            return error('Admin access required for imports', 403);
        }

        const method = event.httpMethod;
        const path = event.path.replace('/.netlify/functions/import', '');

        // =====================================================
        // GET /import/template - Get import template format
        // =====================================================
        if (method === 'GET' && path === '/template') {
            const templateType = event.queryStringParameters?.type || 'customers';
            
            if (templateType === 'customers') {
                return success({
                    description: 'Customer import template',
                    instructions: [
                        'Required fields: code, name, address, city, state, zip',
                        'Optional fields: contact_name, email, phone, customer_type, tank_size, current_level, price_per_gallon, payment_terms, delivery_instructions, auto_delivery, minimum_level, lat, lng',
                        'customer_type options: residential, commercial, industrial',
                        'If lat/lng not provided, address will be geocoded automatically',
                        'code must be unique per company'
                    ],
                    columns: [
                        { name: 'code', required: true, description: 'Unique customer code (e.g., CUST001)', example: 'CUST001' },
                        { name: 'name', required: true, description: 'Customer/Business name', example: 'Smith Residence' },
                        { name: 'contact_name', required: false, description: 'Primary contact person', example: 'John Smith' },
                        { name: 'email', required: false, description: 'Email address', example: 'john@example.com' },
                        { name: 'phone', required: false, description: 'Phone number', example: '555-123-4567' },
                        { name: 'address', required: true, description: 'Street address', example: '123 Main St' },
                        { name: 'city', required: true, description: 'City', example: 'Springfield' },
                        { name: 'state', required: true, description: 'State (2-letter)', example: 'IL' },
                        { name: 'zip', required: true, description: 'ZIP code', example: '62701' },
                        { name: 'lat', required: false, description: 'Latitude (if known)', example: '39.7817' },
                        { name: 'lng', required: false, description: 'Longitude (if known)', example: '-89.6501' },
                        { name: 'customer_type', required: false, description: 'residential/commercial/industrial', example: 'residential' },
                        { name: 'tank_size', required: false, description: 'Tank capacity in gallons', example: '500' },
                        { name: 'current_level', required: false, description: 'Current tank level %', example: '50' },
                        { name: 'price_per_gallon', required: false, description: 'Customer price per gallon', example: '2.50' },
                        { name: 'payment_terms', required: false, description: 'Payment terms', example: 'net30' },
                        { name: 'delivery_instructions', required: false, description: 'Special instructions', example: 'Gate code 1234' },
                        { name: 'auto_delivery', required: false, description: 'Auto-delivery enabled (true/false)', example: 'true' },
                        { name: 'minimum_level', required: false, description: 'Minimum level before delivery %', example: '20' },
                        { name: 'dc_code', required: false, description: 'Preferred DC code (must exist)', example: 'DC001' }
                    ],
                    sampleCSV: 'code,name,contact_name,email,phone,address,city,state,zip,customer_type,tank_size,current_level,price_per_gallon\nCUST001,Smith Residence,John Smith,john@example.com,555-123-4567,123 Main St,Springfield,IL,62701,residential,500,50,2.50\nCUST002,ABC Company,Jane Doe,jane@abc.com,555-987-6543,456 Oak Ave,Springfield,IL,62702,commercial,1000,35,2.25'
                });
            }
            
            if (templateType === 'delivery_history') {
                return success({
                    description: 'Delivery history import template',
                    instructions: [
                        'Required fields: customer_code, delivery_date, gallons_delivered',
                        'Optional fields: tank_level_before, tank_level_after, price_per_gallon, revenue, notes',
                        'customer_code must match an existing customer',
                        'delivery_date format: YYYY-MM-DD',
                        'This data is used to train the prediction system'
                    ],
                    columns: [
                        { name: 'customer_code', required: true, description: 'Customer code (must exist)', example: 'CUST001' },
                        { name: 'delivery_date', required: true, description: 'Date of delivery (YYYY-MM-DD)', example: '2024-01-15' },
                        { name: 'gallons_delivered', required: true, description: 'Gallons delivered', example: '150.5' },
                        { name: 'tank_level_before', required: false, description: 'Tank % before delivery', example: '20' },
                        { name: 'tank_level_after', required: false, description: 'Tank % after delivery', example: '85' },
                        { name: 'price_per_gallon', required: false, description: 'Price charged per gallon', example: '2.50' },
                        { name: 'revenue', required: false, description: 'Total revenue (or calculated from gallons * price)', example: '376.25' },
                        { name: 'notes', required: false, description: 'Delivery notes', example: 'Regular fill-up' }
                    ],
                    sampleCSV: 'customer_code,delivery_date,gallons_delivered,tank_level_before,tank_level_after,price_per_gallon,revenue\nCUST001,2024-01-15,150.5,20,85,2.50,376.25\nCUST001,2024-02-20,175.0,15,90,2.50,437.50\nCUST002,2024-01-10,400.0,25,75,2.25,900.00'
                });
            }

            return error('Invalid template type. Use: customers or delivery_history', 400);
        }

        // =====================================================
        // POST /import/customers - Import customers from CSV/JSON
        // =====================================================
        if (method === 'POST' && path === '/customers') {
            const body = parseBody(event);
            const { data, update_existing = true } = body;

            if (!Array.isArray(data) || data.length === 0) {
                return error('data array required with customer records', 400);
            }

            // Get existing DCs for matching dc_code
            const dcsResult = await query(
                'SELECT id, code, name FROM distribution_centers WHERE company_id = $1',
                [companyId]
            );
            const dcMap = {};
            dcsResult.rows.forEach(dc => {
                dcMap[dc.code?.toUpperCase()] = dc.id;
                dcMap[dc.name?.toUpperCase()] = dc.id;
            });

            // Get first DC as default
            const defaultDcId = dcsResult.rows[0]?.id || null;

            const results = {
                created: 0,
                updated: 0,
                errors: [],
                processed: 0
            };

            for (const row of data) {
                results.processed++;
                
                try {
                    // Validate required fields
                    if (!row.code || !row.name || !row.address || !row.city || !row.state || !row.zip) {
                        results.errors.push({
                            row: results.processed,
                            code: row.code || 'unknown',
                            error: 'Missing required fields (code, name, address, city, state, zip)'
                        });
                        continue;
                    }

                    // Determine DC
                    let dcId = defaultDcId;
                    if (row.dc_code && dcMap[row.dc_code.toUpperCase()]) {
                        dcId = dcMap[row.dc_code.toUpperCase()];
                    }

                    // Check if customer exists
                    const existingResult = await query(
                        'SELECT id FROM customers WHERE company_id = $1 AND code = $2',
                        [companyId, row.code]
                    );

                    const customerData = {
                        code: row.code,
                        name: row.name,
                        contact_name: row.contact_name || null,
                        email: row.email || null,
                        phone: row.phone || null,
                        address: row.address,
                        city: row.city,
                        state: row.state,
                        zip: row.zip,
                        lat: row.lat ? parseFloat(row.lat) : null,
                        lng: row.lng ? parseFloat(row.lng) : null,
                        customer_type: row.customer_type || 'residential',
                        tank_size: parseInt(row.tank_size) || 500,
                        current_level: parseFloat(row.current_level) || 50,
                        price_per_gallon: parseFloat(row.price_per_gallon) || 2.50,
                        payment_terms: row.payment_terms || 'net30',
                        delivery_instructions: row.delivery_instructions || null,
                        auto_delivery: row.auto_delivery === 'true' || row.auto_delivery === true,
                        minimum_level: parseInt(row.minimum_level) || 20,
                        preferred_dc_id: dcId
                    };

                    if (existingResult.rows.length > 0) {
                        // Update existing
                        if (update_existing) {
                            await query(`
                                UPDATE customers SET
                                    name = $1, contact_name = $2, email = $3, phone = $4,
                                    address = $5, city = $6, state = $7, zip = $8,
                                    lat = COALESCE($9, lat), lng = COALESCE($10, lng),
                                    customer_type = $11, tank_size = $12, current_level = $13,
                                    price_per_gallon = $14, payment_terms = $15, delivery_instructions = $16,
                                    auto_delivery = $17, minimum_level = $18, preferred_dc_id = COALESCE($19, preferred_dc_id),
                                    updated_at = NOW()
                                WHERE id = $20
                            `, [
                                customerData.name, customerData.contact_name, customerData.email, customerData.phone,
                                customerData.address, customerData.city, customerData.state, customerData.zip,
                                customerData.lat, customerData.lng,
                                customerData.customer_type, customerData.tank_size, customerData.current_level,
                                customerData.price_per_gallon, customerData.payment_terms, customerData.delivery_instructions,
                                customerData.auto_delivery, customerData.minimum_level, customerData.preferred_dc_id,
                                existingResult.rows[0].id
                            ]);
                            results.updated++;
                        }
                    } else {
                        // Create new
                        await query(`
                            INSERT INTO customers (
                                company_id, preferred_dc_id, code, name, contact_name, email, phone,
                                address, city, state, zip, lat, lng,
                                customer_type, tank_size, current_level, price_per_gallon,
                                payment_terms, delivery_instructions, auto_delivery, minimum_level, status
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'active')
                        `, [
                            companyId, customerData.preferred_dc_id, customerData.code, customerData.name,
                            customerData.contact_name, customerData.email, customerData.phone,
                            customerData.address, customerData.city, customerData.state, customerData.zip,
                            customerData.lat, customerData.lng,
                            customerData.customer_type, customerData.tank_size, customerData.current_level,
                            customerData.price_per_gallon, customerData.payment_terms, customerData.delivery_instructions,
                            customerData.auto_delivery, customerData.minimum_level
                        ]);
                        results.created++;
                    }
                } catch (err) {
                    results.errors.push({
                        row: results.processed,
                        code: row.code || 'unknown',
                        error: err.message
                    });
                }
            }

            return success({
                message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`,
                results
            });
        }

        // =====================================================
        // POST /import/delivery-history - Import delivery history
        // =====================================================
        if (method === 'POST' && path === '/delivery-history') {
            const body = parseBody(event);
            const { data } = body;

            if (!Array.isArray(data) || data.length === 0) {
                return error('data array required with delivery records', 400);
            }

            // Get customer code to ID mapping
            const customersResult = await query(
                'SELECT id, code FROM customers WHERE company_id = $1',
                [companyId]
            );
            const customerMap = {};
            customersResult.rows.forEach(c => {
                customerMap[c.code?.toUpperCase()] = c.id;
            });

            // Get first DC as default for route runs
            const dcResult = await query(
                'SELECT id FROM distribution_centers WHERE company_id = $1 LIMIT 1',
                [companyId]
            );
            const defaultDcId = dcResult.rows[0]?.id;

            if (!defaultDcId) {
                return error('No distribution center found. Create a DC first.', 400);
            }

            const results = {
                created: 0,
                errors: [],
                processed: 0
            };

            // Group deliveries by date for efficient route_run creation
            const deliveriesByDate = {};
            for (const row of data) {
                const date = row.delivery_date;
                if (!deliveriesByDate[date]) {
                    deliveriesByDate[date] = [];
                }
                deliveriesByDate[date].push(row);
            }

            // Process each date's deliveries
            for (const [dateStr, deliveries] of Object.entries(deliveriesByDate)) {
                try {
                    // Create a route_run for this date (for imported historical data)
                    const routeRunResult = await query(`
                        INSERT INTO route_runs (
                            company_id, dc_id, name, scheduled_date, 
                            status, total_stops, stops_completed, completed_at
                        ) VALUES ($1, $2, $3, $4, 'completed', $5, $5, $6)
                        RETURNING id
                    `, [
                        companyId, 
                        defaultDcId, 
                        `Imported History - ${dateStr}`,
                        dateStr,
                        deliveries.length,
                        new Date(dateStr + 'T18:00:00') // Assume completed end of day
                    ]);
                    
                    const routeRunId = routeRunResult.rows[0].id;
                    let stopNumber = 0;
                    let totalGallons = 0;
                    let totalRevenue = 0;

                    for (const row of deliveries) {
                        results.processed++;
                        stopNumber++;

                        try {
                            // Validate required fields
                            if (!row.customer_code || !row.delivery_date || !row.gallons_delivered) {
                                results.errors.push({
                                    row: results.processed,
                                    customer_code: row.customer_code || 'unknown',
                                    error: 'Missing required fields (customer_code, delivery_date, gallons_delivered)'
                                });
                                continue;
                            }

                            // Find customer
                            const customerId = customerMap[row.customer_code.toUpperCase()];
                            if (!customerId) {
                                results.errors.push({
                                    row: results.processed,
                                    customer_code: row.customer_code,
                                    error: 'Customer not found. Import customers first.'
                                });
                                continue;
                            }

                            const gallons = parseFloat(row.gallons_delivered) || 0;
                            const pricePerGallon = parseFloat(row.price_per_gallon) || 2.50;
                            const revenue = parseFloat(row.revenue) || (gallons * pricePerGallon);

                            totalGallons += gallons;
                            totalRevenue += revenue;

                            // Create route_run_stop for this delivery
                            await query(`
                                INSERT INTO route_run_stops (
                                    run_id, customer_id, stop_number,
                                    tank_level_before, tank_level_after,
                                    gallons_delivered, price_per_gallon, delivery_total,
                                    status, arrived_at, departed_at, notes
                                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11)
                            `, [
                                routeRunId,
                                customerId,
                                stopNumber,
                                parseFloat(row.tank_level_before) || null,
                                parseFloat(row.tank_level_after) || null,
                                gallons,
                                pricePerGallon,
                                revenue,
                                new Date(dateStr + 'T12:00:00'), // Assume midday arrival
                                new Date(dateStr + 'T12:15:00'), // Assume 15 min stop
                                row.notes || 'Imported from history'
                            ]);

                            // Update customer's last_delivery_date if this is more recent
                            await query(`
                                UPDATE customers 
                                SET last_delivery_date = GREATEST(COALESCE(last_delivery_date, '1900-01-01'), $1::DATE)
                                WHERE id = $2
                            `, [dateStr, customerId]);

                            results.created++;
                        } catch (err) {
                            results.errors.push({
                                row: results.processed,
                                customer_code: row.customer_code || 'unknown',
                                error: err.message
                            });
                        }
                    }

                    // Update route_run totals
                    await query(`
                        UPDATE route_runs 
                        SET total_gallons_delivered = $1, total_revenue = $2
                        WHERE id = $3
                    `, [totalGallons, totalRevenue, routeRunId]);

                } catch (err) {
                    results.errors.push({
                        date: dateStr,
                        error: 'Failed to create route run: ' + err.message
                    });
                }
            }

            return success({
                message: `Import complete: ${results.created} deliveries imported, ${results.errors.length} errors`,
                results,
                nextStep: 'Run predictions refresh to calculate customer consumption patterns'
            });
        }

        // =====================================================
        // POST /import/validate - Validate import data before importing
        // =====================================================
        if (method === 'POST' && path === '/validate') {
            const body = parseBody(event);
            const { type, data } = body;

            if (!Array.isArray(data) || data.length === 0) {
                return error('data array required', 400);
            }

            const validation = {
                valid: true,
                total_rows: data.length,
                errors: [],
                warnings: []
            };

            if (type === 'customers') {
                const requiredFields = ['code', 'name', 'address', 'city', 'state', 'zip'];
                const codes = new Set();

                data.forEach((row, idx) => {
                    const rowNum = idx + 1;
                    
                    // Check required fields
                    for (const field of requiredFields) {
                        if (!row[field]) {
                            validation.errors.push(`Row ${rowNum}: Missing required field '${field}'`);
                            validation.valid = false;
                        }
                    }

                    // Check for duplicate codes
                    if (row.code) {
                        if (codes.has(row.code.toUpperCase())) {
                            validation.errors.push(`Row ${rowNum}: Duplicate code '${row.code}'`);
                            validation.valid = false;
                        }
                        codes.add(row.code.toUpperCase());
                    }

                    // Warnings
                    if (!row.lat || !row.lng) {
                        validation.warnings.push(`Row ${rowNum} (${row.code}): No lat/lng - will need geocoding`);
                    }
                });
            }

            if (type === 'delivery_history') {
                const requiredFields = ['customer_code', 'delivery_date', 'gallons_delivered'];

                // Get existing customer codes
                const customersResult = await query(
                    'SELECT code FROM customers WHERE company_id = $1',
                    [companyId]
                );
                const validCodes = new Set(customersResult.rows.map(c => c.code.toUpperCase()));

                data.forEach((row, idx) => {
                    const rowNum = idx + 1;
                    
                    // Check required fields
                    for (const field of requiredFields) {
                        if (!row[field]) {
                            validation.errors.push(`Row ${rowNum}: Missing required field '${field}'`);
                            validation.valid = false;
                        }
                    }

                    // Check customer exists
                    if (row.customer_code && !validCodes.has(row.customer_code.toUpperCase())) {
                        validation.errors.push(`Row ${rowNum}: Customer code '${row.customer_code}' not found`);
                        validation.valid = false;
                    }

                    // Validate date format
                    if (row.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.delivery_date)) {
                        validation.errors.push(`Row ${rowNum}: Invalid date format '${row.delivery_date}' - use YYYY-MM-DD`);
                        validation.valid = false;
                    }
                });
            }

            return success(validation);
        }

        return error('Not found', 404);

    } catch (err) {
        console.error('Import API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};
