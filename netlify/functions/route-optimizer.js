// Route Optimization API
// Uses Google Maps APIs for accurate route optimization
const { query } = require('./utils/db');
const { requireAuth } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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

        // POST /route-optimizer/optimize - Optimize stops using Google APIs
        if (method === 'POST' && path === '/optimize') {
            return await optimizeWithGoogle(companyId, event);
        }

        // POST /route-optimizer/preview - Preview optimization without saving
        if (method === 'POST' && path === '/preview') {
            return await previewOptimization(companyId, event);
        }

        // POST /route-optimizer/distance-matrix - Get distance matrix
        if (method === 'POST' && path === '/distance-matrix') {
            return await getDistanceMatrix(event);
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
// GOOGLE DISTANCE MATRIX API
// =====================================================

async function fetchGoogleDistanceMatrix(origins, destinations) {
    if (!GOOGLE_MAPS_API_KEY) {
        console.warn('Google Maps API key not configured, using Haversine fallback');
        return null;
    }

    try {
        // Format locations for Google API
        const originStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
        const destStr = destinations.map(d => `${d.lat},${d.lng}`).join('|');

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(originStr)}&destinations=${encodeURIComponent(destStr)}&units=imperial&key=${GOOGLE_MAPS_API_KEY}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            console.error('Google Distance Matrix error:', data.status, data.error_message);
            return null;
        }

        return data;
    } catch (err) {
        console.error('Google API fetch error:', err);
        return null;
    }
}

// Build full distance matrix using Google API
async function buildGoogleDistanceMatrix(locations) {
    const n = locations.length;
    
    // Google Distance Matrix API has limits: 25 origins x 25 destinations per request
    // For larger sets, we need to batch
    const MAX_ELEMENTS = 25;
    
    if (n <= MAX_ELEMENTS) {
        // Single request
        const result = await fetchGoogleDistanceMatrix(locations, locations);
        if (!result) return null;

        const matrix = {
            distances: [], // miles
            durations: []  // minutes
        };

        for (let i = 0; i < n; i++) {
            matrix.distances[i] = [];
            matrix.durations[i] = [];
            for (let j = 0; j < n; j++) {
                const element = result.rows[i].elements[j];
                if (element.status === 'OK') {
                    // Convert meters to miles, seconds to minutes
                    matrix.distances[i][j] = element.distance.value * 0.000621371;
                    matrix.durations[i][j] = element.duration.value / 60;
                } else {
                    // Fallback to Haversine for this pair
                    matrix.distances[i][j] = haversineDistance(
                        locations[i].lat, locations[i].lng,
                        locations[j].lat, locations[j].lng
                    );
                    matrix.durations[i][j] = matrix.distances[i][j] / 35 * 60; // Assume 35mph
                }
            }
        }

        return matrix;
    } else {
        // Batch requests for larger matrices
        console.log(`Building distance matrix for ${n} locations in batches...`);
        
        const matrix = {
            distances: Array(n).fill(null).map(() => Array(n).fill(0)),
            durations: Array(n).fill(null).map(() => Array(n).fill(0))
        };

        // Process in chunks
        for (let i = 0; i < n; i += MAX_ELEMENTS) {
            const originChunk = locations.slice(i, Math.min(i + MAX_ELEMENTS, n));
            
            for (let j = 0; j < n; j += MAX_ELEMENTS) {
                const destChunk = locations.slice(j, Math.min(j + MAX_ELEMENTS, n));
                
                const result = await fetchGoogleDistanceMatrix(originChunk, destChunk);
                
                if (result) {
                    for (let oi = 0; oi < originChunk.length; oi++) {
                        for (let di = 0; di < destChunk.length; di++) {
                            const element = result.rows[oi].elements[di];
                            const globalI = i + oi;
                            const globalJ = j + di;
                            
                            if (element.status === 'OK') {
                                matrix.distances[globalI][globalJ] = element.distance.value * 0.000621371;
                                matrix.durations[globalI][globalJ] = element.duration.value / 60;
                            } else {
                                matrix.distances[globalI][globalJ] = haversineDistance(
                                    locations[globalI].lat, locations[globalI].lng,
                                    locations[globalJ].lat, locations[globalJ].lng
                                );
                                matrix.durations[globalI][globalJ] = matrix.distances[globalI][globalJ] / 35 * 60;
                            }
                        }
                    }
                } else {
                    // Fallback for this chunk
                    for (let oi = 0; oi < originChunk.length; oi++) {
                        for (let di = 0; di < destChunk.length; di++) {
                            const globalI = i + oi;
                            const globalJ = j + di;
                            matrix.distances[globalI][globalJ] = haversineDistance(
                                locations[globalI].lat, locations[globalI].lng,
                                locations[globalJ].lat, locations[globalJ].lng
                            );
                            matrix.durations[globalI][globalJ] = matrix.distances[globalI][globalJ] / 35 * 60;
                        }
                    }
                }
            }
        }

        return matrix;
    }
}

// =====================================================
// GOOGLE DIRECTIONS API - WAYPOINT OPTIMIZATION
// =====================================================

async function optimizeWaypointsWithGoogle(origin, destination, waypoints) {
    if (!GOOGLE_MAPS_API_KEY) {
        return null;
    }

    try {
        // Google Directions API can optimize up to 25 waypoints
        if (waypoints.length > 25) {
            console.log('Too many waypoints for Google optimization, using local algorithm');
            return null;
        }

        const waypointStr = waypoints.map(w => `${w.lat},${w.lng}`).join('|');
        
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&waypoints=optimize:true|${encodeURIComponent(waypointStr)}&key=${GOOGLE_MAPS_API_KEY}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            console.error('Google Directions error:', data.status, data.error_message);
            return null;
        }

        // Extract optimized order
        const route = data.routes[0];
        const optimizedOrder = route.waypoint_order; // Array of indices in optimal order

        // Calculate totals from legs
        let totalDistance = 0;
        let totalDuration = 0;
        const legs = route.legs;

        for (const leg of legs) {
            totalDistance += leg.distance.value * 0.000621371; // meters to miles
            totalDuration += leg.duration.value / 60; // seconds to minutes
        }

        return {
            optimizedOrder,
            totalDistance,
            totalDuration,
            legs: legs.map(leg => ({
                distance: leg.distance.value * 0.000621371,
                duration: leg.duration.value / 60,
                start_address: leg.start_address,
                end_address: leg.end_address
            })),
            polyline: route.overview_polyline?.points
        };
    } catch (err) {
        console.error('Google Directions API error:', err);
        return null;
    }
}

// =====================================================
// HAVERSINE FALLBACK
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

// Build Haversine-based distance matrix (fallback)
function buildHaversineDistanceMatrix(locations) {
    const n = locations.length;
    const distances = Array(n).fill(null).map(() => Array(n).fill(0));
    const durations = Array(n).fill(null).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = haversineDistance(
                locations[i].lat, locations[i].lng,
                locations[j].lat, locations[j].lng
            );
            distances[i][j] = dist;
            distances[j][i] = dist;
            // Estimate duration at 35 mph average
            durations[i][j] = (dist / 35) * 60;
            durations[j][i] = durations[i][j];
        }
    }
    
    return { distances, durations };
}

// =====================================================
// NEAREST NEIGHBOR + 2-OPT ALGORITHMS
// =====================================================

function nearestNeighbor(matrix, startIndex = 0) {
    const n = matrix.length;
    const visited = new Set([startIndex]);
    const route = [startIndex];
    let current = startIndex;
    
    while (visited.size < n) {
        let nearest = -1;
        let nearestDist = Infinity;
        
        for (let i = 0; i < n; i++) {
            if (!visited.has(i) && matrix[current][i] < nearestDist) {
                nearest = i;
                nearestDist = matrix[current][i];
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

function twoOptImprove(route, matrix, maxIterations = 1000) {
    let improved = true;
    let iterations = 0;
    let bestRoute = [...route];
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        
        for (let i = 1; i < bestRoute.length - 2; i++) {
            for (let j = i + 1; j < bestRoute.length - 1; j++) {
                const currentDist = 
                    matrix[bestRoute[i - 1]][bestRoute[i]] +
                    matrix[bestRoute[j]][bestRoute[j + 1]];
                
                const newDist = 
                    matrix[bestRoute[i - 1]][bestRoute[j]] +
                    matrix[bestRoute[i]][bestRoute[j + 1]];
                
                if (newDist < currentDist - 0.001) {
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

function calculateTotalDistance(route, matrix) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
        total += matrix[route[i]][route[i + 1]];
    }
    // Return to start
    if (route.length > 1) {
        total += matrix[route[route.length - 1]][route[0]];
    }
    return total;
}

function calculateTotalDuration(route, durationMatrix) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
        total += durationMatrix[route[i]][route[i + 1]];
    }
    if (route.length > 1) {
        total += durationMatrix[route[route.length - 1]][route[0]];
    }
    return total;
}

// =====================================================
// MAIN OPTIMIZATION FUNCTION
// =====================================================

async function optimizeWithGoogle(companyId, event) {
    const body = parseBody(event);
    const { dc_id, customer_ids, stops, truck_id, use_google = true } = body;

    if (!dc_id) {
        return error('Distribution center ID required', 400);
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

    // Get customers/stops to optimize
    let customersToOptimize = [];
    
    if (customer_ids && customer_ids.length > 0) {
        const customerResult = await query(`
            SELECT id, name, address, city, state, lat, lng, tank_size, current_level
            FROM customers 
            WHERE id = ANY($1) AND company_id = $2 AND lat IS NOT NULL AND lng IS NOT NULL
        `, [customer_ids, companyId]);
        customersToOptimize = customerResult.rows;
    } else if (stops && stops.length > 0) {
        // Stops already provided with lat/lng
        customersToOptimize = stops.filter(s => s.lat && s.lng);
    }

    if (customersToOptimize.length === 0) {
        return error('No valid stops with GPS coordinates', 400);
    }

    // Get truck info if provided
    let truckMpg = 8;
    if (truck_id) {
        const truckResult = await query('SELECT mpg FROM trucks WHERE id = $1', [truck_id]);
        if (truckResult.rows.length > 0 && truckResult.rows[0].mpg) {
            truckMpg = truckResult.rows[0].mpg;
        }
    }

    // Get company settings
    const settings = await getCompanySettings(companyId);

    // Build locations array (DC first)
    const locations = [
        { 
            id: 'dc', 
            lat: parseFloat(dc.lat), 
            lng: parseFloat(dc.lng), 
            name: dc.name,
            type: 'dc'
        },
        ...customersToOptimize.map(c => ({
            id: c.id || c.customer_id,
            lat: parseFloat(c.lat),
            lng: parseFloat(c.lng),
            name: c.name || c.customer_name,
            address: c.address,
            city: c.city,
            state: c.state,
            tank_size: c.tank_size,
            current_level: c.current_level,
            type: 'customer'
        }))
    ];

    let optimizedRoute;
    let totalDistance;
    let totalDuration;
    let method = 'haversine';
    let polyline = null;

    // Try Google Directions API first (best for <= 25 waypoints)
    if (use_google && GOOGLE_MAPS_API_KEY && customersToOptimize.length <= 25) {
        console.log('Attempting Google Directions API optimization...');
        
        const googleResult = await optimizeWaypointsWithGoogle(
            { lat: parseFloat(dc.lat), lng: parseFloat(dc.lng) },
            { lat: parseFloat(dc.lat), lng: parseFloat(dc.lng) }, // Return to DC
            customersToOptimize.map(c => ({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) }))
        );

        if (googleResult) {
            method = 'google_directions';
            optimizedRoute = [0, ...googleResult.optimizedOrder.map(i => i + 1)]; // +1 because DC is index 0
            totalDistance = googleResult.totalDistance;
            totalDuration = googleResult.totalDuration;
            polyline = googleResult.polyline;
            
            console.log(`Google optimization successful: ${totalDistance.toFixed(1)} miles, ${totalDuration.toFixed(0)} min`);
        }
    }

    // Fallback: Use Distance Matrix + local optimization
    if (!optimizedRoute) {
        console.log('Using Distance Matrix + local optimization...');
        
        // Try Google Distance Matrix first
        let matrix = null;
        if (use_google && GOOGLE_MAPS_API_KEY) {
            matrix = await buildGoogleDistanceMatrix(locations);
            if (matrix) {
                method = 'google_distance_matrix';
            }
        }

        // Fallback to Haversine
        if (!matrix) {
            matrix = buildHaversineDistanceMatrix(locations);
            method = 'haversine';
        }

        // Run optimization algorithms
        const nnRoute = nearestNeighbor(matrix.distances, 0);
        const { route: improvedRoute } = twoOptImprove(nnRoute, matrix.distances);
        
        optimizedRoute = improvedRoute;
        totalDistance = calculateTotalDistance(optimizedRoute, matrix.distances);
        totalDuration = calculateTotalDuration(optimizedRoute, matrix.durations);
    }

    // Calculate costs
    const fuelGallons = totalDistance / truckMpg;
    const fuelCost = fuelGallons * (settings.fuel_price || 3.50);
    const stopTime = customersToOptimize.length * (settings.stop_time || 15);
    const totalTime = totalDuration + stopTime;
    const laborCost = (totalTime / 60) * (settings.driver_hourly_rate || 25);

    // Build optimized stops list
    const optimizedStops = optimizedRoute
        .filter(i => i !== 0) // Exclude DC
        .map((locIndex, stopNum) => ({
            stop_number: stopNum + 1,
            customer_id: locations[locIndex].id,
            customer_name: locations[locIndex].name,
            address: locations[locIndex].address,
            city: locations[locIndex].city,
            state: locations[locIndex].state,
            lat: locations[locIndex].lat,
            lng: locations[locIndex].lng,
            tank_size: locations[locIndex].tank_size,
            current_level: locations[locIndex].current_level
        }));

    return success({
        optimization_method: method,
        google_api_used: method.startsWith('google'),
        total_stops: customersToOptimize.length,
        total_miles: Math.round(totalDistance * 100) / 100,
        total_drive_time_minutes: Math.round(totalDuration),
        total_stop_time_minutes: stopTime,
        total_time_minutes: Math.round(totalTime),
        fuel_gallons: Math.round(fuelGallons * 100) / 100,
        fuel_cost: Math.round(fuelCost * 100) / 100,
        labor_cost: Math.round(laborCost * 100) / 100,
        total_cost: Math.round((fuelCost + laborCost) * 100) / 100,
        stops: optimizedStops,
        distribution_center: {
            id: dc.id,
            name: dc.name,
            lat: parseFloat(dc.lat),
            lng: parseFloat(dc.lng)
        },
        polyline: polyline, // For drawing route on map
        settings_used: {
            mpg: truckMpg,
            fuel_price: settings.fuel_price || 3.50,
            stop_time_minutes: settings.stop_time || 15,
            driver_hourly_rate: settings.driver_hourly_rate || 25
        }
    });
}

// =====================================================
// PREVIEW OPTIMIZATION
// =====================================================

async function previewOptimization(companyId, event) {
    // Same as optimizeWithGoogle but doesn't save anything
    return await optimizeWithGoogle(companyId, event);
}

// =====================================================
// GET DISTANCE MATRIX (for frontend use)
// =====================================================

async function getDistanceMatrix(event) {
    const body = parseBody(event);
    const { locations } = body;

    if (!locations || locations.length < 2) {
        return error('At least 2 locations required', 400);
    }

    // Try Google first
    if (GOOGLE_MAPS_API_KEY) {
        const matrix = await buildGoogleDistanceMatrix(locations);
        if (matrix) {
            return success({
                method: 'google',
                locations: locations.length,
                distances: matrix.distances,
                durations: matrix.durations
            });
        }
    }

    // Fallback to Haversine
    const matrix = buildHaversineDistanceMatrix(locations);
    return success({
        method: 'haversine',
        locations: locations.length,
        distances: matrix.distances,
        durations: matrix.durations
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
    return success({
        ...settings,
        google_api_configured: !!GOOGLE_MAPS_API_KEY
    });
}

async function updateOptimizationSettings(companyId, event) {
    const body = parseBody(event);
    const { fuel_price, default_mpg, avg_speed, driver_hourly_rate, stop_time } = body;

    const current = await query('SELECT settings FROM companies WHERE id = $1', [companyId]);
    const currentSettings = current.rows[0]?.settings || {};

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
