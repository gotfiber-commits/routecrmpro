// Verizon Connect (Fleetmatics) Integration API
const { query } = require('./utils/db');
const { requireAuth, requireRole } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');

// Verizon Connect API Base URL
const VERIZON_API_BASE = 'https://fim.api.us.fleetmatics.com/cmd/v1';
const VERIZON_AUTH_URL = 'https://fim.api.us.fleetmatics.com/token';

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    // Authenticate user
    const authResult = requireAuth(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }

    const user = authResult.user;
    const companyId = user.companyId;
    const path = event.path.replace('/.netlify/functions/fleetmatics', '');
    const method = event.httpMethod;

    try {
        // GET /fleetmatics/status - Check integration status
        if (method === 'GET' && path === '/status') {
            return await getIntegrationStatus(companyId);
        }

        // POST /fleetmatics/connect - Save API credentials
        if (method === 'POST' && path === '/connect') {
            if (!requireRole(user, ['admin'])) {
                return error('Admin access required', 403);
            }
            return await connectIntegration(companyId, event);
        }

        // DELETE /fleetmatics/disconnect - Remove integration
        if (method === 'DELETE' && path === '/disconnect') {
            if (!requireRole(user, ['admin'])) {
                return error('Admin access required', 403);
            }
            return await disconnectIntegration(companyId);
        }

        // GET /fleetmatics/vehicles - Get all vehicles from Verizon
        if (method === 'GET' && path === '/vehicles') {
            return await getVehicles(companyId);
        }

        // GET /fleetmatics/vehicles/:id - Get single vehicle details
        if (method === 'GET' && path.match(/^\/vehicles\/[^/]+$/)) {
            const vehicleId = path.split('/')[2];
            return await getVehicleDetails(companyId, vehicleId);
        }

        // GET /fleetmatics/vehicles/:id/location - Get real-time location
        if (method === 'GET' && path.match(/^\/vehicles\/[^/]+\/location$/)) {
            const vehicleId = path.split('/')[2];
            return await getVehicleLocation(companyId, vehicleId);
        }

        // GET /fleetmatics/vehicles/:id/trips - Get trip history
        if (method === 'GET' && path.match(/^\/vehicles\/[^/]+\/trips$/)) {
            const vehicleId = path.split('/')[2];
            return await getVehicleTrips(companyId, vehicleId, event);
        }

        // POST /fleetmatics/sync - Sync all vehicle locations to trucks table
        if (method === 'POST' && path === '/sync') {
            return await syncVehicleLocations(companyId);
        }

        // GET /fleetmatics/drivers - Get drivers from Verizon
        if (method === 'GET' && path === '/drivers') {
            return await getDrivers(companyId);
        }

        // POST /fleetmatics/link-truck - Link Verizon vehicle to local truck
        if (method === 'POST' && path === '/link-truck') {
            if (!requireRole(user, ['admin', 'dispatch'])) {
                return error('Access denied', 403);
            }
            return await linkTruckToVehicle(companyId, event);
        }

        // GET /fleetmatics/alerts - Get recent alerts
        if (method === 'GET' && path === '/alerts') {
            return await getAlerts(companyId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Fleetmatics API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// INTEGRATION MANAGEMENT
// =====================================================

async function getIntegrationStatus(companyId) {
    const result = await query(
        `SELECT 
            fleetmatics_enabled,
            fleetmatics_username,
            fleetmatics_last_sync,
            fleetmatics_vehicle_count
         FROM companies WHERE id = $1`,
        [companyId]
    );

    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    const company = result.rows[0];
    
    return success({
        enabled: company.fleetmatics_enabled || false,
        connected: !!company.fleetmatics_username,
        username: company.fleetmatics_username || null,
        last_sync: company.fleetmatics_last_sync || null,
        vehicle_count: company.fleetmatics_vehicle_count || 0
    });
}

async function connectIntegration(companyId, event) {
    const body = parseBody(event);
    const { username, password, api_key } = body;

    if (!username || !password) {
        return error('Username and password required', 400);
    }

    // Test the credentials by getting an access token
    try {
        const token = await getAccessToken(username, password, api_key);
        
        if (!token) {
            return error('Invalid credentials - could not authenticate with Verizon Connect', 401);
        }

        // Store credentials (encrypted in production)
        await query(
            `UPDATE companies SET 
                fleetmatics_enabled = true,
                fleetmatics_username = $1,
                fleetmatics_password_encrypted = $2,
                fleetmatics_api_key = $3,
                fleetmatics_last_sync = NULL,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [username, password, api_key || null, companyId] // Note: In production, encrypt the password!
        );

        // Do initial sync
        const syncResult = await syncVehicleLocations(companyId);

        return success({
            message: 'Successfully connected to Verizon Connect',
            vehicles_synced: syncResult.body ? JSON.parse(syncResult.body).vehicles_updated : 0
        });

    } catch (err) {
        console.error('Verizon Connect authentication error:', err);
        return error('Failed to connect: ' + err.message, 400);
    }
}

async function disconnectIntegration(companyId) {
    await query(
        `UPDATE companies SET 
            fleetmatics_enabled = false,
            fleetmatics_username = NULL,
            fleetmatics_password_encrypted = NULL,
            fleetmatics_api_key = NULL,
            fleetmatics_last_sync = NULL,
            fleetmatics_vehicle_count = 0,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [companyId]
    );

    // Clear vehicle links
    await query(
        `UPDATE trucks SET fleetmatics_vehicle_id = NULL WHERE company_id = $1`,
        [companyId]
    );

    return success({ message: 'Verizon Connect integration disconnected' });
}

// =====================================================
// VERIZON CONNECT API CALLS
// =====================================================

async function getAccessToken(username, password, apiKey) {
    // Verizon Connect uses OAuth2 or Basic Auth depending on the API version
    // This is a simplified example - actual implementation depends on your Verizon contract
    
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    
    const response = await fetch(VERIZON_AUTH_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
        throw new Error('Authentication failed');
    }

    const data = await response.json();
    return data.access_token;
}

async function makeVerizonRequest(companyId, endpoint, method = 'GET', body = null) {
    // Get stored credentials
    const result = await query(
        `SELECT fleetmatics_username, fleetmatics_password_encrypted, fleetmatics_api_key
         FROM companies WHERE id = $1 AND fleetmatics_enabled = true`,
        [companyId]
    );

    if (result.rows.length === 0) {
        throw new Error('Verizon Connect integration not configured');
    }

    const { fleetmatics_username, fleetmatics_password_encrypted, fleetmatics_api_key } = result.rows[0];
    
    // Get access token
    const token = await getAccessToken(fleetmatics_username, fleetmatics_password_encrypted, fleetmatics_api_key);

    const response = await fetch(`${VERIZON_API_BASE}${endpoint}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Verizon API error: ${response.status} - ${errorText}`);
    }

    return response.json();
}

// =====================================================
// VEHICLE ENDPOINTS
// =====================================================

async function getVehicles(companyId) {
    try {
        const data = await makeVerizonRequest(companyId, '/vehicles');
        
        // Map to our format
        const vehicles = (data.vehicles || data.Vehicle || []).map(v => ({
            id: v.VehicleId || v.id,
            name: v.VehicleName || v.name,
            vin: v.VIN || v.vin,
            license_plate: v.LicensePlate || v.licensePlate,
            make: v.Make || v.make,
            model: v.Model || v.model,
            year: v.Year || v.year,
            status: v.Status || v.status,
            odometer: v.Odometer || v.odometer,
            fuel_level: v.FuelLevel || v.fuelLevel,
            last_location: {
                lat: v.Latitude || v.latitude || (v.Location && v.Location.Latitude),
                lng: v.Longitude || v.longitude || (v.Location && v.Location.Longitude),
                timestamp: v.LastLocationTime || v.lastLocationTime,
                speed: v.Speed || v.speed,
                heading: v.Heading || v.heading
            }
        }));

        return success({ 
            vehicles,
            count: vehicles.length,
            synced_at: new Date().toISOString()
        });

    } catch (err) {
        return error('Failed to fetch vehicles: ' + err.message, 500);
    }
}

async function getVehicleDetails(companyId, vehicleId) {
    try {
        const data = await makeVerizonRequest(companyId, `/vehicles/${vehicleId}`);
        return success(data);
    } catch (err) {
        return error('Failed to fetch vehicle details: ' + err.message, 500);
    }
}

async function getVehicleLocation(companyId, vehicleId) {
    try {
        const data = await makeVerizonRequest(companyId, `/vehicles/${vehicleId}/location`);
        
        return success({
            vehicle_id: vehicleId,
            location: {
                lat: data.Latitude || data.latitude,
                lng: data.Longitude || data.longitude,
                timestamp: data.Timestamp || data.timestamp || new Date().toISOString(),
                speed: data.Speed || data.speed || 0,
                heading: data.Heading || data.heading || 0,
                ignition: data.IgnitionStatus || data.ignition || 'unknown',
                address: data.Address || data.address || null
            }
        });

    } catch (err) {
        return error('Failed to fetch vehicle location: ' + err.message, 500);
    }
}

async function getVehicleTrips(companyId, vehicleId, event) {
    const params = event.queryStringParameters || {};
    const startDate = params.start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = params.end_date || new Date().toISOString().split('T')[0];

    try {
        const data = await makeVerizonRequest(
            companyId, 
            `/vehicles/${vehicleId}/trips?startDate=${startDate}&endDate=${endDate}`
        );
        
        const trips = (data.trips || data.Trips || []).map(t => ({
            id: t.TripId || t.id,
            start_time: t.StartTime || t.startTime,
            end_time: t.EndTime || t.endTime,
            start_location: t.StartLocation || t.startLocation,
            end_location: t.EndLocation || t.endLocation,
            distance_miles: t.DistanceMiles || t.distance,
            duration_minutes: t.DurationMinutes || t.duration,
            idle_time_minutes: t.IdleTimeMinutes || t.idleTime,
            max_speed: t.MaxSpeed || t.maxSpeed,
            fuel_used: t.FuelUsed || t.fuelUsed
        }));

        return success({ 
            vehicle_id: vehicleId,
            trips,
            period: { start_date: startDate, end_date: endDate }
        });

    } catch (err) {
        return error('Failed to fetch trips: ' + err.message, 500);
    }
}

// =====================================================
// SYNC & LINKING
// =====================================================

async function syncVehicleLocations(companyId) {
    try {
        // Get vehicles from Verizon
        const verizonData = await makeVerizonRequest(companyId, '/vehicles');
        const vehicles = verizonData.vehicles || verizonData.Vehicle || [];

        let updated = 0;
        let errors = [];

        // Update each linked truck
        for (const v of vehicles) {
            const vehicleId = v.VehicleId || v.id;
            const lat = v.Latitude || v.latitude || (v.Location && v.Location.Latitude);
            const lng = v.Longitude || v.longitude || (v.Location && v.Location.Longitude);
            const odometer = v.Odometer || v.odometer;
            const speed = v.Speed || v.speed;

            if (lat && lng) {
                try {
                    const result = await query(
                        `UPDATE trucks SET 
                            current_lat = $1,
                            current_lng = $2,
                            current_odometer = COALESCE($3, current_odometer),
                            current_speed = $4,
                            last_location_update = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                         WHERE company_id = $5 AND fleetmatics_vehicle_id = $6
                         RETURNING id`,
                        [lat, lng, odometer, speed, companyId, vehicleId]
                    );
                    
                    if (result.rows.length > 0) {
                        updated++;
                    }
                } catch (dbErr) {
                    errors.push({ vehicle_id: vehicleId, error: dbErr.message });
                }
            }
        }

        // Update sync timestamp and vehicle count
        await query(
            `UPDATE companies SET 
                fleetmatics_last_sync = CURRENT_TIMESTAMP,
                fleetmatics_vehicle_count = $1
             WHERE id = $2`,
            [vehicles.length, companyId]
        );

        return success({
            message: 'Sync completed',
            vehicles_found: vehicles.length,
            vehicles_updated: updated,
            errors: errors.length > 0 ? errors : undefined,
            synced_at: new Date().toISOString()
        });

    } catch (err) {
        return error('Sync failed: ' + err.message, 500);
    }
}

async function linkTruckToVehicle(companyId, event) {
    const body = parseBody(event);
    const { truck_id, fleetmatics_vehicle_id } = body;

    if (!truck_id) {
        return error('Truck ID required', 400);
    }

    // Update the truck with the Verizon vehicle ID
    const result = await query(
        `UPDATE trucks SET 
            fleetmatics_vehicle_id = $1,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND company_id = $3
         RETURNING id, code, name, fleetmatics_vehicle_id`,
        [fleetmatics_vehicle_id || null, truck_id, companyId]
    );

    if (result.rows.length === 0) {
        return error('Truck not found', 404);
    }

    // If linking (not unlinking), sync the location immediately
    if (fleetmatics_vehicle_id) {
        try {
            const locationData = await makeVerizonRequest(
                companyId, 
                `/vehicles/${fleetmatics_vehicle_id}/location`
            );
            
            const lat = locationData.Latitude || locationData.latitude;
            const lng = locationData.Longitude || locationData.longitude;
            
            if (lat && lng) {
                await query(
                    `UPDATE trucks SET current_lat = $1, current_lng = $2 WHERE id = $3`,
                    [lat, lng, truck_id]
                );
            }
        } catch (err) {
            console.log('Could not sync initial location:', err.message);
        }
    }

    return success({
        message: fleetmatics_vehicle_id ? 'Truck linked to Verizon vehicle' : 'Truck unlinked',
        truck: result.rows[0]
    });
}

// =====================================================
// DRIVERS & ALERTS
// =====================================================

async function getDrivers(companyId) {
    try {
        const data = await makeVerizonRequest(companyId, '/drivers');
        
        const drivers = (data.drivers || data.Driver || []).map(d => ({
            id: d.DriverId || d.id,
            name: d.DriverName || d.name,
            email: d.Email || d.email,
            phone: d.Phone || d.phone,
            license_number: d.LicenseNumber || d.licenseNumber,
            assigned_vehicle_id: d.AssignedVehicleId || d.vehicleId,
            status: d.Status || d.status
        }));

        return success({ drivers, count: drivers.length });

    } catch (err) {
        return error('Failed to fetch drivers: ' + err.message, 500);
    }
}

async function getAlerts(companyId, event) {
    const params = event.queryStringParameters || {};
    const hours = parseInt(params.hours) || 24;
    const vehicleId = params.vehicle_id;

    try {
        let endpoint = `/alerts?hours=${hours}`;
        if (vehicleId) {
            endpoint += `&vehicleId=${vehicleId}`;
        }

        const data = await makeVerizonRequest(companyId, endpoint);
        
        const alerts = (data.alerts || data.Alert || []).map(a => ({
            id: a.AlertId || a.id,
            type: a.AlertType || a.type,
            severity: a.Severity || a.severity,
            vehicle_id: a.VehicleId || a.vehicleId,
            vehicle_name: a.VehicleName || a.vehicleName,
            driver_name: a.DriverName || a.driverName,
            message: a.Message || a.message,
            location: {
                lat: a.Latitude || a.latitude,
                lng: a.Longitude || a.longitude,
                address: a.Address || a.address
            },
            timestamp: a.Timestamp || a.timestamp,
            acknowledged: a.Acknowledged || a.acknowledged || false
        }));

        return success({ 
            alerts,
            count: alerts.length,
            period_hours: hours
        });

    } catch (err) {
        return error('Failed to fetch alerts: ' + err.message, 500);
    }
}
