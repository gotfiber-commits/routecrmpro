// Route Optimization API
// Solves Vehicle Routing Problem using Nearest Neighbor + 2-opt improvement
const { query } = require('./utils/db');
const { requireAuth } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');

// Default costs (can be overridden)
const DEFAULT_FUEL_PRICE = 3.50; // $ per gallon
const DEFAULT_AVG_SPEED = 35; // mph (accounts for stops, traffic)
const DEFAULT_STOP_DURATION = 20; // minutes per delivery

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/optimize-route', '');
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

        if (authResult.user.companyId !== companyId) {
            return error('Unauthorized', 403);
        }

        // POST /optimize-route - Optimize a set of stops
        if (method === 'POST' && path === '') {
            return await optimizeRoute(companyId, event);
        }

        // POST /optimize-route/:routeId - Optimize existing route
        if (method === 'POST' && path.match(/^\/[a-f0-9-]+$/)) {
            const routeId = path.slice(1);
            return await optimizeExistingRoute(companyId, routeId, event);
        }

        // GET /optimize-route/estimate - Get cost estimate for stops
        if (method === 'POST' && path === '/estimate') {
            return await getRouteEstimate(companyId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Route optimization error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// HAVERSINE DISTANCE (miles)
// =====================================================
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth's radius in miles
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
            visited.add(nearest);
            route.push(nearest);
            current = nearest;
        }
    }
    
    // Return to start (distribution center)
    route.push(startIndex);
    return route;
}

// =====================================================
// 2-OPT IMPROVEMENT
// =====================================================
function twoOpt(route, distanceMatrix, maxIterations = 1000) {
    let improved = true;
    let iterations = 0;
    let bestRoute = [...route];
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        
        for (let i = 1; i < bestRoute.length - 2; i++) {
            for (let j = i + 1; j < bestRoute.length - 1; j++) {
                const delta = calculateTwoOptDelta(bestRoute, distanceMatrix, i, j);
                
                if (delta < -0.001) { // Small threshold to avoid floating point issues
                    // Reverse the segment between i and j
                    bestRoute = twoOptSwap(bestRoute, i, j);
                    improved = true;
                }
            }
        }
    }
    
    return bestRoute;
}

function calculateTwoOptDelta(route, distanceMatrix, i, j) {
    const a = route[i - 1];
    const b = route[i];
    const c = route[j];
    const d = route[j + 1];
    
    const currentDist = distanceMatrix[a][b] + distanceMatrix[c][d];
    const newDist = distanceMatrix[a][c] + distanceMatrix[b][d];
    
    return newDist - currentDist;
}

function twoOptSwap(route, i, j) {
    const newRoute = route.slice(0, i);
    const reversed = route.slice(i, j + 1).reverse();
    const rest = route.slice(j + 1);
    return [...newRoute, ...reversed, ...rest];
}

// =====================================================
// CALCULATE ROUTE METRICS
// =====================================================
function calculateRouteMetrics(route, distanceMatrix, locations, options = {}) {
    const {
        fuelPrice = DEFAULT_FUEL_PRICE,
        truckMpg = 8,
        avgSpeed = DEFAULT_AVG_SPEED,
        stopDuration = DEFAULT_STOP_DURATION
    } = options;
    
    let totalMiles = 0;
    const segments = [];
    
    for (let i = 0; i < route.length - 1; i++) {
        const fromIdx = route[i];
        const toIdx = route[i + 1];
        const distance = distanceMatrix[fromIdx][toIdx];
        totalMiles += distance;
        
        segments.push({
            from: locations[fromIdx],
            to: locations[toIdx],
            distance: Math.round(distance * 100) / 100,
            estimatedTime: Math.round((distance / avgSpeed) * 60) // minutes
        });
    }
    
    // Number of actual stops (excluding depot start/end)
    const numStops = route.length - 2;
    
    // Calculate costs
    const fuelGallons = totalMiles / truckMpg;
    const fuelCost = fuelGallons * fuelPrice;
    
    // Calculate time
    const driveTimeMinutes = (totalMiles / avgSpeed) * 60;
    const stopTimeMinutes = numStops * stopDuration;
    const totalTimeMinutes = driveTimeMinutes + stopTimeMinutes;
    
    return {
        totalMiles: Math.round(totalMiles * 100) / 100,
        fuelGallons: Math.round(fuelGallons * 100) / 100,
        fuelCost: Math.round(fuelCost * 100) / 100,
        driveTimeMinutes: Math.round(driveTimeMinutes),
        stopTimeMinutes: Math.round(stopTimeMinutes),
        totalTimeMinutes: Math.round(totalTimeMinutes),
        totalTimeFormatted: formatDuration(totalTimeMinutes),
        numStops,
        segments
    };
}

function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hours === 0) return `${mins}m`;
    return `${hours}h ${mins}m`;
}

// =====================================================
// OPTIMIZE ROUTE
// =====================================================
async function optimizeRoute(companyId, event) {
    const body = parseBody(event);
    const { 
        dc_id, 
        customer_ids, 
        order_ids,
        truck_id,
        fuel_price,
        return_to_depot = true 
    } = body;

    if (!dc_id) {
        return error('Distribution center ID required', 400);
    }

    if ((!customer_ids || customer_ids.length === 0) && (!order_ids || order_ids.length === 0)) {
        return error('At least one customer or order required', 400);
    }

    // Get distribution center (depot)
    const dcResult = await query(
        'SELECT id, name, lat, lng, address, city, state FROM distribution_centers WHERE id = $1 AND company_id = $2',
        [dc_id, companyId]
    );

    if (dcResult.rows.length === 0) {
        return error('Distribution center not found', 404);
    }

    const depot = dcResult.rows[0];
    if (!depot.lat || !depot.lng) {
        return error('Distribution center is missing GPS coordinates', 400);
    }

    // Get truck info if provided
    let truckMpg = 8;
    let truck = null;
    if (truck_id) {
        const truckResult = await query(
            'SELECT * FROM trucks WHERE id = $1 AND company_id = $2',
            [truck_id, companyId]
        );
        if (truckResult.rows.length > 0) {
            truck = truckResult.rows[0];
            truckMpg = parseFloat(truck.mpg) || 8;
        }
    }

    // Get stops (customers or orders)
    let stops = [];
    
    if (order_ids && order_ids.length > 0) {
        // Get customers from orders
        const ordersResult = await query(`
            SELECT o.id as order_id, o.order_number, o.gallons_requested,
                   c.id as customer_id, c.name, c.address, c.city, c.state, c.lat, c.lng
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            WHERE o.id = ANY($1) AND o.company_id = $2
        `, [order_ids, companyId]);
        
        stops = ordersResult.rows.map(row => ({
            id: row.customer_id,
            order_id: row.order_id,
            order_number: row.order_number,
            name: row.name,
            address: row.address,
            city: row.city,
            state: row.state,
            lat: parseFloat(row.lat),
            lng: parseFloat(row.lng),
            gallons: row.gallons_requested,
            type: 'customer'
        }));
    } else if (customer_ids && customer_ids.length > 0) {
        const customersResult = await query(`
            SELECT id, name, address, city, state, lat, lng
            FROM customers
            WHERE id = ANY($1) AND company_id = $2
        `, [customer_ids, companyId]);
        
        stops = customersResult.rows.map(row => ({
            id: row.id,
            name: row.name,
            address: row.address,
            city: row.city,
            state: row.state,
            lat: parseFloat(row.lat),
            lng: parseFloat(row.lng),
            type: 'customer'
        }));
    }

    // Filter stops with valid coordinates
    stops = stops.filter(s => s.lat && s.lng && !isNaN(s.lat) && !isNaN(s.lng));

    if (stops.length === 0) {
        return error('No stops with valid GPS coordinates', 400);
    }

    // Build locations array: depot first, then stops
    const locations = [
        { 
            id: depot.id, 
            name: depot.name, 
            address: depot.address,
            city: depot.city,
            state: depot.state,
            lat: parseFloat(depot.lat), 
            lng: parseFloat(depot.lng), 
            type: 'depot' 
        },
        ...stops
    ];

    // Build distance matrix
    const distanceMatrix = buildDistanceMatrix(locations);

    // Run optimization
    const nnRoute = nearestNeighbor(distanceMatrix, 0);
    const optimizedRoute = twoOpt(nnRoute, distanceMatrix);

    // Calculate metrics for both routes (to show improvement)
    const originalMetrics = calculateRouteMetrics(nnRoute, distanceMatrix, locations, {
        fuelPrice: fuel_price || DEFAULT_FUEL_PRICE,
        truckMpg
    });

    const optimizedMetrics = calculateRouteMetrics(optimizedRoute, distanceMatrix, locations, {
        fuelPrice: fuel_price || DEFAULT_FUEL_PRICE,
        truckMpg
    });

    // Build ordered stops list
    const orderedStops = optimizedRoute.slice(1, -1).map((idx, stopNum) => ({
        stop_number: stopNum + 1,
        ...locations[idx]
    }));

    // Calculate savings
    const milesSaved = originalMetrics.totalMiles - optimizedMetrics.totalMiles;
    const costSaved = originalMetrics.fuelCost - optimizedMetrics.fuelCost;
    const timeSaved = originalMetrics.totalTimeMinutes - optimizedMetrics.totalTimeMinutes;

    return success({
        depot: locations[0],
        stops: orderedStops,
        metrics: optimizedMetrics,
        original_metrics: originalMetrics,
        savings: {
            miles: Math.round(milesSaved * 100) / 100,
            fuel_cost: Math.round(costSaved * 100) / 100,
            time_minutes: Math.round(timeSaved),
            percentage: originalMetrics.totalMiles > 0 
                ? Math.round((milesSaved / originalMetrics.totalMiles) * 100) 
                : 0
        },
        truck: truck ? {
            id: truck.id,
            code: truck.code,
            name: truck.name,
            mpg: truckMpg,
            capacity: truck.capacity_gallons
        } : null,
        route_order: optimizedRoute.map(idx => locations[idx].id),
        algorithm: '2-opt'
    });
}

// =====================================================
// OPTIMIZE EXISTING ROUTE
// =====================================================
async function optimizeExistingRoute(companyId, routeId, event) {
    const body = parseBody(event) || {};
    const { fuel_price } = body;

    // Get route with DC
    const routeResult = await query(`
        SELECT r.*, dc.id as dc_id, dc.name as dc_name, dc.lat as dc_lat, dc.lng as dc_lng,
               dc.address as dc_address, dc.city as dc_city, dc.state as dc_state,
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
        return error('Distribution center is missing GPS coordinates', 400);
    }

    // Get route stops with customer info
    const stopsResult = await query(`
        SELECT rs.*, o.order_number, o.gallons_requested,
               c.id as customer_id, c.name, c.address, c.city, c.state, c.lat, c.lng
        FROM route_stops rs
        JOIN orders o ON rs.order_id = o.id
        JOIN customers c ON o.customer_id = c.id
        WHERE rs.route_id = $1
        ORDER BY rs.stop_number
    `, [routeId]);

    if (stopsResult.rows.length === 0) {
        return error('Route has no stops to optimize', 400);
    }

    // Filter valid stops
    const stops = stopsResult.rows
        .filter(s => s.lat && s.lng)
        .map(s => ({
            id: s.customer_id,
            order_id: s.order_id,
            route_stop_id: s.id,
            order_number: s.order_number,
            name: s.name,
            address: s.address,
            city: s.city,
            state: s.state,
            lat: parseFloat(s.lat),
            lng: parseFloat(s.lng),
            gallons: s.gallons_requested,
            original_stop_number: s.stop_number,
            type: 'customer'
        }));

    if (stops.length === 0) {
        return error('No stops with valid GPS coordinates', 400);
    }

    // Build locations array
    const locations = [
        {
            id: route.dc_id,
            name: route.dc_name,
            address: route.dc_address,
            city: route.dc_city,
            state: route.dc_state,
            lat: parseFloat(route.dc_lat),
            lng: parseFloat(route.dc_lng),
            type: 'depot'
        },
        ...stops
    ];

    // Build distance matrix and optimize
    const distanceMatrix = buildDistanceMatrix(locations);
    const nnRoute = nearestNeighbor(distanceMatrix, 0);
    const optimizedRoute = twoOpt(nnRoute, distanceMatrix);

    const truckMpg = parseFloat(route.truck_mpg) || 8;

    const originalMetrics = calculateRouteMetrics(nnRoute, distanceMatrix, locations, {
        fuelPrice: fuel_price || DEFAULT_FUEL_PRICE,
        truckMpg
    });

    const optimizedMetrics = calculateRouteMetrics(optimizedRoute, distanceMatrix, locations, {
        fuelPrice: fuel_price || DEFAULT_FUEL_PRICE,
        truckMpg
    });

    // Update route_stops with new order
    const orderedStops = optimizedRoute.slice(1, -1).map((idx, stopNum) => ({
        stop_number: stopNum + 1,
        ...locations[idx]
    }));

    // Update database with optimized order
    for (const stop of orderedStops) {
        if (stop.route_stop_id) {
            await query(
                'UPDATE route_stops SET stop_number = $1 WHERE id = $2',
                [stop.stop_number, stop.route_stop_id]
            );
        }
    }

    // Update route totals
    await query(`
        UPDATE routes 
        SET total_miles = $1, 
            estimated_duration = $2, 
            is_optimized = true,
            original_miles = $3,
            optimized_miles = $1
        WHERE id = $4
    `, [optimizedMetrics.totalMiles, optimizedMetrics.totalTimeMinutes, originalMetrics.totalMiles, routeId]);

    const milesSaved = originalMetrics.totalMiles - optimizedMetrics.totalMiles;

    return success({
        route_id: routeId,
        depot: locations[0],
        stops: orderedStops,
        metrics: optimizedMetrics,
        original_metrics: originalMetrics,
        savings: {
            miles: Math.round(milesSaved * 100) / 100,
            fuel_cost: Math.round((originalMetrics.fuelCost - optimizedMetrics.fuelCost) * 100) / 100,
            time_minutes: Math.round(originalMetrics.totalTimeMinutes - optimizedMetrics.totalTimeMinutes),
            percentage: originalMetrics.totalMiles > 0 
                ? Math.round((milesSaved / originalMetrics.totalMiles) * 100) 
                : 0
        },
        message: 'Route optimized and saved'
    });
}

// =====================================================
// GET ROUTE ESTIMATE (without saving)
// =====================================================
async function getRouteEstimate(companyId, event) {
    const body = parseBody(event);
    const { dc_id, customer_ids, truck_id, fuel_price } = body;

    if (!dc_id || !customer_ids || customer_ids.length === 0) {
        return error('Distribution center and at least one customer required', 400);
    }

    // Get DC
    const dcResult = await query(
        'SELECT id, name, lat, lng FROM distribution_centers WHERE id = $1 AND company_id = $2',
        [dc_id, companyId]
    );

    if (dcResult.rows.length === 0 || !dcResult.rows[0].lat) {
        return error('Distribution center not found or missing coordinates', 400);
    }

    // Get customers
    const customersResult = await query(`
        SELECT id, name, lat, lng FROM customers 
        WHERE id = ANY($1) AND company_id = $2 AND lat IS NOT NULL AND lng IS NOT NULL
    `, [customer_ids, companyId]);

    if (customersResult.rows.length === 0) {
        return error('No customers with valid coordinates', 400);
    }

    // Get truck MPG
    let truckMpg = 8;
    if (truck_id) {
        const truckResult = await query('SELECT mpg FROM trucks WHERE id = $1', [truck_id]);
        if (truckResult.rows.length > 0) {
            truckMpg = parseFloat(truckResult.rows[0].mpg) || 8;
        }
    }

    // Build locations and matrix
    const locations = [
        { ...dcResult.rows[0], lat: parseFloat(dcResult.rows[0].lat), lng: parseFloat(dcResult.rows[0].lng) },
        ...customersResult.rows.map(c => ({ ...c, lat: parseFloat(c.lat), lng: parseFloat(c.lng) }))
    ];

    const distanceMatrix = buildDistanceMatrix(locations);
    const optimizedRoute = twoOpt(nearestNeighbor(distanceMatrix, 0), distanceMatrix);

    const metrics = calculateRouteMetrics(optimizedRoute, distanceMatrix, locations, {
        fuelPrice: fuel_price || DEFAULT_FUEL_PRICE,
        truckMpg
    });

    return success({
        estimate: {
            miles: metrics.totalMiles,
            fuel_gallons: metrics.fuelGallons,
            fuel_cost: metrics.fuelCost,
            drive_time: metrics.driveTimeMinutes,
            stop_time: metrics.stopTimeMinutes,
            total_time: metrics.totalTimeMinutes,
            total_time_formatted: metrics.totalTimeFormatted,
            num_stops: metrics.numStops
        }
    });
}
