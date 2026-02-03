// Route Optimization API
// Implements route optimization using Nearest Neighbor + 2-opt algorithms
const { query } = require('./utils/db');
const { requireAuth } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/route-optimizer', '');
    const method = event.httpMethod;

    try {
        // Resolve tenant
        const tenant = await resolveTenant(event);
        if (!tenant.resolved) {
            return error('Company not found', 404);
        }
        const companyId = tenant.company.id;

        // Auth required
        const authResult = requireAuth(event);
        if (authResult.error) {
            return error(authResult.error, authResult.status);
        }

        // POST /route-optimizer/optimize/:routeId - Optimize an existing route
        if (method === 'POST' && path.match(/^\/optimize\/[a-f0-9-]+$/)) {
            const routeId = path.split('/')[2];
            return await optimizeRoute(companyId, routeId, event);
        }

        // POST /route-optimizer/preview - Preview optimization without saving
        if (method === 'POST' && path === '/preview') {
            return await previewOptimization(companyId, event);
        }

        // POST /route-optimizer/calculate - Calculate costs for a route
        if (method === 'POST' && path === '/calculate') {
            return await calculateRouteCosts(companyId, event);
        }

        // GET /route-optimizer/settings - Get optimization settings
        if (method === 'GET' && path === '/settings') {
            return await getOptimizationSettings(companyId);
        }

        // PUT /route-optimizer/settings - Update optimization settings
        if (method === 'PUT' && path === '/settings') {
            return await updateOptimizationSettings(companyId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Route optimizer error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// HAVERSINE DISTANCE CALCULATION
// =====================================================

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

// =====================================================
// BUILD DISTANCE MATRIX
// =====================================================

function buildDistanceMatrix(locations) {
    const n = locations.length;
    const matrix = Array(n).fill(null).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = haversineDistance(
                locations[i].lat, locations[i].lng,
                locations[j].lat, locations[j].lng
            );
            matrix[i][j] = dist;
            matrix[j][i] = dist;
        }
    }
    
    return matrix;
}

// =====================================================
// NEAREST NEIGHBOR ALGORITHM
// =====================================================

function nearestNeighbor(distanceMatrix, startIndex = 0) {
    const n = distanceMatrix.length;
    const visited = new Set([startIndex]);
    const route = [startIndex];
    let current = startIndex;
    
    while (visited.size < n) {
        let nearest = -1;
        let nearestDist = Infinity;
        
        for (let i = 0; i < n; i++) {
            if (!visited.has(i) && distanceMatrix[current][i] < nearestDist) {
                nearest = i;
                nearestDist = distanceMatrix[current][i];
            }
        }
        
        if (nearest !== -1) {
            route.push(nearest);
            visited.add(nearest);
            current = nearest;
        }
    }
    
    return route;
}

// =====================================================
// 2-OPT IMPROVEMENT ALGORITHM
// =====================================================

function twoOptImprove(route, distanceMatrix, maxIterations = 1000) {
    let improved = true;
    let iterations = 0;
    let bestRoute = [...route];
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        
        for (let i = 1; i < bestRoute.length - 2; i++) {
            for (let j = i + 1; j < bestRoute.length - 1; j++) {
                // Calculate current distance
                const currentDist = 
                    distanceMatrix[bestRoute[i - 1]][bestRoute[i]] +
                    distanceMatrix[bestRoute[j]][bestRoute[j + 1]];
                
                // Calculate new distance if we reverse segment
                const newDist = 
                    distanceMatrix[bestRoute[i - 1]][bestRoute[j]] +
                    distanceMatrix[bestRoute[i]][bestRoute[j + 1]];
                
                if (newDist < currentDist - 0.001) {
                    // Reverse the segment between i and j
                    const newRoute = [...bestRoute];
                    let left = i;
                    let right = j;
                    while (left < right) {
                        [newRoute[left], newRoute[right]] = [newRoute[right], newRoute[left]];
                        left++;
                        right--;
                    }
                    bestRoute = newRoute;
                    improved = true;
                }
            }
        }
    }
    
    return { route: bestRoute, iterations };
}

// =====================================================
// CALCULATE ROUTE TOTAL DISTANCE
// =====================================================

function calculateTotalDistance(route, distanceMatrix, returnToStart = true) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
        total += distanceMatrix[route[i]][route[i + 1]];
    }
    // Return to start (distribution center)
    if (returnToStart && route.length > 1) {
        total += distanceMatrix[route[route.length - 1]][route[0]];
    }
    return total;
}

// =====================================================
// OPTIMIZE ROUTE
// =====================================================

async function optimizeRoute(companyId, routeId, event) {
    const body = parseBody(event);
    const { apply = false } = body; // Whether to save the optimization

    // Get route with DC info
    const routeResult = await query(`
        SELECT r.*, dc.lat as dc_lat, dc.lng as dc_lng, dc.name as dc_name,
               t.mpg as truck_mpg, t.capacity_gallons as truck_capacity
        FROM routes r
        JOIN distribution_centers dc ON r.dc_id = dc.id
        LEFT JOIN trucks t ON r.truck_id = t.id
        WHERE r.id = $1 AND r.company_id = $2
    `, [routeId, companyId]);

    if (routeResult.rows.length === 0) {
        return error('Route not found', 404);
    }

    const route = routeResult.rows[0];

    if (!route.dc_lat || !route.dc_lng) {
        return error('Distribution center does not have GPS coordinates', 400);
    }

    // Get all stops with customer locations
    const stopsResult = await query(`
        SELECT rs.*, o.id as order_id, o.gallons_requested,
               c.id as customer_id, c.name as customer_name, c.address, c.city, c.state,
               c.lat, c.lng
        FROM route_stops rs
        JOIN orders o ON rs.order_id = o.id
        JOIN customers c ON o.customer_id = c.id
        WHERE rs.route_id = $1
        ORDER BY rs.stop_number
    `, [routeId]);

    if (stopsResult.rows.length === 0) {
        return error('Route has no stops', 400);
    }

    // Filter stops with valid coordinates
    const validStops = stopsResult.rows.filter(s => s.lat && s.lng);
    
    if (validStops.length === 0) {
        return error('No stops have GPS coordinates', 400);
    }

    // Get optimization settings
    const settings = await getCompanySettings(companyId);

    // Build locations array: DC first, then all stops
    const locations = [
        { id: 'dc', lat: parseFloat(route.dc_lat), lng: parseFloat(route.dc_lng), name: route.dc_name },
        ...validStops.map(s => ({
            id: s.id,
            order_id: s.order_id,
            customer_id: s.customer_id,
            lat: parseFloat(s.lat),
            lng: parseFloat(s.lng),
            name: s.customer_name,
            address: s.address,
            city: s.city,
            state: s.state,
            gallons: s.gallons_requested
        }))
    ];

    // Build distance matrix
    const distanceMatrix = buildDistanceMatrix(locations);

    // Calculate original distance (current order)
    const originalOrder = locations.map((_, i) => i);
    const originalDistance = calculateTotalDistance(originalOrder, distanceMatrix);

    // Run Nearest Neighbor algorithm (start from DC which is index 0)
    const nnRoute = nearestNeighbor(distanceMatrix, 0);

    // Improve with 2-opt
    const { route: optimizedRoute, iterations } = twoOptImprove(nnRoute, distanceMatrix);

    // Calculate optimized distance
    const optimizedDistance = calculateTotalDistance(optimizedRoute, distanceMatrix);

    // Calculate savings
    const distanceSaved = originalDistance - optimizedDistance;
    const percentSaved = (distanceSaved / originalDistance) * 100;

    // Calculate costs
    const mpg = route.truck_mpg || settings.default_mpg || 8;
    const fuelPrice = settings.fuel_price || 3.50;
    const avgSpeed = settings.avg_speed || 35; // mph
    const driverHourlyRate = settings.driver_hourly_rate || 25;
    const stopTime = settings.stop_time || 15; // minutes per stop

    const originalFuelGallons = originalDistance / mpg;
    const optimizedFuelGallons = optimizedDistance / mpg;
    const fuelSaved = originalFuelGallons - optimizedFuelGallons;
    const fuelCostSaved = fuelSaved * fuelPrice;

    const originalDriveTime = (originalDistance / avgSpeed) * 60; // minutes
    const optimizedDriveTime = (optimizedDistance / avgSpeed) * 60;
    const totalStopTime = validStops.length * stopTime;
    
    const originalTotalTime = originalDriveTime + totalStopTime;
    const optimizedTotalTime = optimizedDriveTime + totalStopTime;
    const timeSaved = originalTotalTime - optimizedTotalTime;

    const laborCostSaved = (timeSaved / 60) * driverHourlyRate;
    const totalCostSaved = fuelCostSaved + laborCostSaved;

    // Map optimized route back to stops
    const optimizedStops = optimizedRoute
        .filter(i => i !== 0) // Remove DC
        .map((locIndex, stopNum) => ({
            stop_number: stopNum + 1,
            ...locations[locIndex]
        }));

    // If apply is true, save the optimized order
    if (apply) {
        for (const stop of optimizedStops) {
            await query(`
                UPDATE route_stops SET stop_number = $1 WHERE id = $2
            `, [stop.stop_number, stop.id]);
        }

        // Update route stats
        await query(`
            UPDATE routes SET 
                is_optimized = true,
                original_miles = $1,
                optimized_miles = $2,
                total_miles = $2,
                estimated_duration = $3
            WHERE id = $4
        `, [originalDistance, optimizedDistance, Math.round(optimizedTotalTime), routeId]);
    }

    return success({
        route_id: routeId,
        applied: apply,
        algorithm: 'Nearest Neighbor + 2-opt',
        iterations: iterations,
        
        original: {
            distance_miles: Math.round(originalDistance * 100) / 100,
            drive_time_minutes: Math.round(originalDriveTime),
            total_time_minutes: Math.round(originalTotalTime),
            fuel_gallons: Math.round(originalFuelGallons * 100) / 100,
            fuel_cost: Math.round(originalFuelGallons * fuelPrice * 100) / 100
        },
        
        optimized: {
            distance_miles: Math.round(optimizedDistance * 100) / 100,
            drive_time_minutes: Math.round(optimizedDriveTime),
            total_time_minutes: Math.round(optimizedTotalTime),
            fuel_gallons: Math.round(optimizedFuelGallons * 100) / 100,
            fuel_cost: Math.round(optimizedFuelGallons * fuelPrice * 100) / 100
        },
        
        savings: {
            distance_miles: Math.round(distanceSaved * 100) / 100,
            distance_percent: Math.round(percentSaved * 10) / 10,
            time_minutes: Math.round(timeSaved),
            fuel_gallons: Math.round(fuelSaved * 100) / 100,
            fuel_cost: Math.round(fuelCostSaved * 100) / 100,
            labor_cost: Math.round(laborCostSaved * 100) / 100,
            total_cost: Math.round(totalCostSaved * 100) / 100
        },
        
        settings_used: {
            mpg: mpg,
            fuel_price: fuelPrice,
            avg_speed: avgSpeed,
            driver_hourly_rate: driverHourlyRate,
            stop_time_minutes: stopTime
        },
        
        stops: optimizedStops,
        
        distribution_center: {
            name: route.dc_name,
            lat: parseFloat(route.dc_lat),
            lng: parseFloat(route.dc_lng)
        }
    });
}

// =====================================================
// PREVIEW OPTIMIZATION (without existing route)
// =====================================================

async function previewOptimization(companyId, event) {
    const body = parseBody(event);
    const { dc_id, order_ids, truck_id } = body;

    if (!dc_id) {
        return error('Distribution center ID required', 400);
    }

    if (!order_ids || order_ids.length === 0) {
        return error('At least one order is required', 400);
    }

    // Get DC
    const dcResult = await query(`
        SELECT * FROM distribution_centers WHERE id = $1 AND company_id = $2
    `, [dc_id, companyId]);

    if (dcResult.rows.length === 0) {
        return error('Distribution center not found', 404);
    }

    const dc = dcResult.rows[0];

    if (!dc.lat || !dc.lng) {
        return error('Distribution center does not have GPS coordinates', 400);
    }

    // Get orders with customer locations
    const ordersResult = await query(`
        SELECT o.*, c.name as customer_name, c.address, c.city, c.state, c.lat, c.lng
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        WHERE o.id = ANY($1) AND o.company_id = $2
    `, [order_ids, companyId]);

    const validOrders = ordersResult.rows.filter(o => o.lat && o.lng);

    if (validOrders.length === 0) {
        return error('No orders have GPS coordinates', 400);
    }

    // Get truck MPG if provided
    let truckMpg = null;
    if (truck_id) {
        const truckResult = await query('SELECT mpg FROM trucks WHERE id = $1', [truck_id]);
        if (truckResult.rows.length > 0) {
            truckMpg = truckResult.rows[0].mpg;
        }
    }

    // Get settings
    const settings = await getCompanySettings(companyId);

    // Build locations
    const locations = [
        { id: 'dc', lat: parseFloat(dc.lat), lng: parseFloat(dc.lng), name: dc.name },
        ...validOrders.map(o => ({
            id: o.id,
            lat: parseFloat(o.lat),
            lng: parseFloat(o.lng),
            name: o.customer_name,
            address: o.address,
            city: o.city,
            state: o.state,
            gallons: o.gallons_requested
        }))
    ];

    // Build distance matrix
    const distanceMatrix = buildDistanceMatrix(locations);

    // Run optimization
    const nnRoute = nearestNeighbor(distanceMatrix, 0);
    const { route: optimizedRoute } = twoOptImprove(nnRoute, distanceMatrix);
    const optimizedDistance = calculateTotalDistance(optimizedRoute, distanceMatrix);

    // Calculate costs
    const mpg = truckMpg || settings.default_mpg || 8;
    const fuelPrice = settings.fuel_price || 3.50;
    const avgSpeed = settings.avg_speed || 35;
    const stopTime = settings.stop_time || 15;

    const fuelGallons = optimizedDistance / mpg;
    const driveTime = (optimizedDistance / avgSpeed) * 60;
    const totalTime = driveTime + (validOrders.length * stopTime);

    // Map to stops
    const optimizedStops = optimizedRoute
        .filter(i => i !== 0)
        .map((locIndex, stopNum) => ({
            stop_number: stopNum + 1,
            ...locations[locIndex]
        }));

    return success({
        preview: true,
        total_stops: validOrders.length,
        distance_miles: Math.round(optimizedDistance * 100) / 100,
        drive_time_minutes: Math.round(driveTime),
        total_time_minutes: Math.round(totalTime),
        fuel_gallons: Math.round(fuelGallons * 100) / 100,
        fuel_cost: Math.round(fuelGallons * fuelPrice * 100) / 100,
        total_gallons_to_deliver: validOrders.reduce((sum, o) => sum + (o.gallons_requested || 0), 0),
        stops: optimizedStops,
        distribution_center: {
            id: dc.id,
            name: dc.name,
            lat: parseFloat(dc.lat),
            lng: parseFloat(dc.lng)
        }
    });
}

// =====================================================
// CALCULATE ROUTE COSTS
// =====================================================

async function calculateRouteCosts(companyId, event) {
    const body = parseBody(event);
    const { distance_miles, num_stops, truck_id } = body;

    if (!distance_miles) {
        return error('Distance required', 400);
    }

    const settings = await getCompanySettings(companyId);

    // Get truck MPG if provided
    let mpg = settings.default_mpg || 8;
    if (truck_id) {
        const truckResult = await query('SELECT mpg FROM trucks WHERE id = $1', [truck_id]);
        if (truckResult.rows.length > 0 && truckResult.rows[0].mpg) {
            mpg = truckResult.rows[0].mpg;
        }
    }

    const fuelPrice = settings.fuel_price || 3.50;
    const avgSpeed = settings.avg_speed || 35;
    const driverRate = settings.driver_hourly_rate || 25;
    const stopTime = settings.stop_time || 15;

    const fuelGallons = distance_miles / mpg;
    const fuelCost = fuelGallons * fuelPrice;
    const driveTime = (distance_miles / avgSpeed) * 60;
    const totalStopTime = (num_stops || 0) * stopTime;
    const totalTime = driveTime + totalStopTime;
    const laborCost = (totalTime / 60) * driverRate;
    const totalCost = fuelCost + laborCost;

    return success({
        distance_miles: distance_miles,
        fuel_gallons: Math.round(fuelGallons * 100) / 100,
        fuel_cost: Math.round(fuelCost * 100) / 100,
        drive_time_minutes: Math.round(driveTime),
        stop_time_minutes: totalStopTime,
        total_time_minutes: Math.round(totalTime),
        labor_cost: Math.round(laborCost * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        settings_used: {
            mpg, fuel_price: fuelPrice, avg_speed: avgSpeed,
            driver_hourly_rate: driverRate, stop_time_minutes: stopTime
        }
    });
}

// =====================================================
// OPTIMIZATION SETTINGS
// =====================================================

async function getCompanySettings(companyId) {
    const result = await query(`
        SELECT settings FROM companies WHERE id = $1
    `, [companyId]);

    const settings = result.rows[0]?.settings || {};
    
    return {
        fuel_price: settings.fuel_price || 3.50,
        default_mpg: settings.default_mpg || 8,
        avg_speed: settings.avg_speed || 35,
        driver_hourly_rate: settings.driver_hourly_rate || 25,
        stop_time: settings.stop_time || 15
    };
}

async function getOptimizationSettings(companyId) {
    const settings = await getCompanySettings(companyId);
    return success(settings);
}

async function updateOptimizationSettings(companyId, event) {
    const body = parseBody(event);
    const { fuel_price, default_mpg, avg_speed, driver_hourly_rate, stop_time } = body;

    // Get current settings
    const current = await query('SELECT settings FROM companies WHERE id = $1', [companyId]);
    const currentSettings = current.rows[0]?.settings || {};

    // Merge new settings
    const newSettings = {
        ...currentSettings,
        ...(fuel_price !== undefined && { fuel_price: parseFloat(fuel_price) }),
        ...(default_mpg !== undefined && { default_mpg: parseFloat(default_mpg) }),
        ...(avg_speed !== undefined && { avg_speed: parseFloat(avg_speed) }),
        ...(driver_hourly_rate !== undefined && { driver_hourly_rate: parseFloat(driver_hourly_rate) }),
        ...(stop_time !== undefined && { stop_time: parseInt(stop_time) })
    };

    await query(`
        UPDATE companies SET settings = $1 WHERE id = $2
    `, [JSON.stringify(newSettings), companyId]);

    return success({
        message: 'Settings updated',
        settings: {
            fuel_price: newSettings.fuel_price || 3.50,
            default_mpg: newSettings.default_mpg || 8,
            avg_speed: newSettings.avg_speed || 35,
            driver_hourly_rate: newSettings.driver_hourly_rate || 25,
            stop_time: newSettings.stop_time || 15
        }
    });
}
