// Route Optimization Utilities
// Algorithms: Nearest Neighbor + 2-Opt Improvement
// Includes fuel costs, mileage, and time estimates

/**
 * Calculate distance between two points using Haversine formula
 * Returns distance in miles
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959; // Earth's radius in miles
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

/**
 * Calculate total route distance
 * @param {Array} stops - Array of {lat, lng} objects
 * @param {Object} depot - Starting point {lat, lng}
 * @returns {number} Total distance in miles
 */
function calculateRouteDistance(stops, depot) {
    if (!stops || stops.length === 0) return 0;
    
    let totalDistance = 0;
    
    // Distance from depot to first stop
    totalDistance += haversineDistance(depot.lat, depot.lng, stops[0].lat, stops[0].lng);
    
    // Distance between consecutive stops
    for (let i = 0; i < stops.length - 1; i++) {
        totalDistance += haversineDistance(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
    }
    
    // Distance from last stop back to depot
    totalDistance += haversineDistance(stops[stops.length - 1].lat, stops[stops.length - 1].lng, depot.lat, depot.lng);
    
    return totalDistance;
}

/**
 * Build distance matrix between all points
 */
function buildDistanceMatrix(points) {
    const n = points.length;
    const matrix = Array(n).fill(null).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = haversineDistance(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
            matrix[i][j] = dist;
            matrix[j][i] = dist;
        }
    }
    
    return matrix;
}

/**
 * Nearest Neighbor Algorithm
 * Greedy algorithm that always visits the nearest unvisited stop
 * @param {Array} stops - Array of stop objects with lat, lng
 * @param {Object} depot - Starting point {lat, lng}
 * @returns {Array} Optimized order of stops
 */
function nearestNeighbor(stops, depot) {
    if (!stops || stops.length <= 1) return stops;
    
    // Add depot as first point (index 0)
    const allPoints = [depot, ...stops];
    const distMatrix = buildDistanceMatrix(allPoints);
    
    const n = stops.length;
    const visited = new Set([0]); // Start at depot (index 0)
    const route = [];
    let current = 0;
    
    while (route.length < n) {
        let nearest = null;
        let nearestDist = Infinity;
        
        for (let i = 1; i <= n; i++) { // Skip depot (index 0)
            if (!visited.has(i) && distMatrix[current][i] < nearestDist) {
                nearest = i;
                nearestDist = distMatrix[current][i];
            }
        }
        
        if (nearest !== null) {
            visited.add(nearest);
            route.push(nearest - 1); // Adjust index back to stops array
            current = nearest;
        }
    }
    
    return route.map(i => stops[i]);
}

/**
 * 2-Opt Improvement Algorithm
 * Iteratively improves route by reversing segments
 * @param {Array} stops - Array of stop objects with lat, lng
 * @param {Object} depot - Starting point {lat, lng}
 * @param {number} maxIterations - Maximum improvement iterations
 * @returns {Array} Improved order of stops
 */
function twoOptImprove(stops, depot, maxIterations = 100) {
    if (!stops || stops.length <= 2) return stops;
    
    let bestRoute = [...stops];
    let bestDistance = calculateRouteDistance(bestRoute, depot);
    let improved = true;
    let iterations = 0;
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        
        for (let i = 0; i < bestRoute.length - 1; i++) {
            for (let j = i + 2; j < bestRoute.length; j++) {
                // Create new route by reversing segment between i and j
                const newRoute = [
                    ...bestRoute.slice(0, i + 1),
                    ...bestRoute.slice(i + 1, j + 1).reverse(),
                    ...bestRoute.slice(j + 1)
                ];
                
                const newDistance = calculateRouteDistance(newRoute, depot);
                
                if (newDistance < bestDistance - 0.01) { // Small threshold to avoid floating point issues
                    bestRoute = newRoute;
                    bestDistance = newDistance;
                    improved = true;
                }
            }
        }
    }
    
    return bestRoute;
}

/**
 * Full route optimization combining algorithms
 * @param {Array} stops - Array of stop objects with lat, lng, and other data
 * @param {Object} depot - Distribution center {lat, lng}
 * @param {Object} options - Optimization options
 * @returns {Object} Optimization results
 */
function optimizeRoute(stops, depot, options = {}) {
    const {
        fuelPricePerGallon = 3.50,
        truckMpg = 8,
        avgSpeedMph = 35,
        stopDurationMinutes = 20,
        driverHourlyRate = 25
    } = options;
    
    if (!stops || stops.length === 0) {
        return {
            success: false,
            error: 'No stops to optimize'
        };
    }
    
    if (!depot || !depot.lat || !depot.lng) {
        return {
            success: false,
            error: 'Distribution center location required'
        };
    }
    
    // Filter stops with valid coordinates
    const validStops = stops.filter(s => s.lat && s.lng);
    
    if (validStops.length === 0) {
        return {
            success: false,
            error: 'No stops have valid GPS coordinates'
        };
    }
    
    // Calculate original distance (if stops have an order)
    const originalDistance = calculateRouteDistance(validStops, depot);
    
    // Step 1: Nearest Neighbor for initial solution
    const nnRoute = nearestNeighbor(validStops, depot);
    const nnDistance = calculateRouteDistance(nnRoute, depot);
    
    // Step 2: 2-Opt improvement
    const optimizedStops = twoOptImprove(nnRoute, depot);
    const optimizedDistance = calculateRouteDistance(optimizedStops, depot);
    
    // Calculate costs and times
    const fuelGallons = optimizedDistance / truckMpg;
    const fuelCost = fuelGallons * fuelPricePerGallon;
    const drivingTimeHours = optimizedDistance / avgSpeedMph;
    const stopTimeHours = (validStops.length * stopDurationMinutes) / 60;
    const totalTimeHours = drivingTimeHours + stopTimeHours;
    const laborCost = totalTimeHours * driverHourlyRate;
    const totalCost = fuelCost + laborCost;
    
    // Calculate savings
    const milesSaved = originalDistance - optimizedDistance;
    const percentSaved = originalDistance > 0 ? (milesSaved / originalDistance) * 100 : 0;
    const fuelSaved = milesSaved / truckMpg;
    const costSaved = fuelSaved * fuelPricePerGallon;
    
    // Build route segments with distances and times
    const segments = [];
    let cumulativeDistance = 0;
    let cumulativeTime = 0;
    
    // First segment: Depot to first stop
    const firstDist = haversineDistance(depot.lat, depot.lng, optimizedStops[0].lat, optimizedStops[0].lng);
    cumulativeDistance += firstDist;
    cumulativeTime += (firstDist / avgSpeedMph) * 60; // Convert to minutes
    
    segments.push({
        from: 'Distribution Center',
        to: optimizedStops[0].name || optimizedStops[0].customer_name || 'Stop 1',
        distance: firstDist,
        estimatedMinutes: Math.round((firstDist / avgSpeedMph) * 60),
        cumulativeDistance: cumulativeDistance,
        cumulativeMinutes: Math.round(cumulativeTime)
    });
    
    // Middle segments
    for (let i = 0; i < optimizedStops.length - 1; i++) {
        const dist = haversineDistance(
            optimizedStops[i].lat, optimizedStops[i].lng,
            optimizedStops[i + 1].lat, optimizedStops[i + 1].lng
        );
        cumulativeDistance += dist;
        cumulativeTime += (dist / avgSpeedMph) * 60 + stopDurationMinutes;
        
        segments.push({
            from: optimizedStops[i].name || optimizedStops[i].customer_name || `Stop ${i + 1}`,
            to: optimizedStops[i + 1].name || optimizedStops[i + 1].customer_name || `Stop ${i + 2}`,
            distance: dist,
            estimatedMinutes: Math.round((dist / avgSpeedMph) * 60),
            cumulativeDistance: cumulativeDistance,
            cumulativeMinutes: Math.round(cumulativeTime)
        });
    }
    
    // Last segment: Last stop back to depot
    const lastStop = optimizedStops[optimizedStops.length - 1];
    const returnDist = haversineDistance(lastStop.lat, lastStop.lng, depot.lat, depot.lng);
    cumulativeDistance += returnDist;
    cumulativeTime += (returnDist / avgSpeedMph) * 60 + stopDurationMinutes;
    
    segments.push({
        from: lastStop.name || lastStop.customer_name || `Stop ${optimizedStops.length}`,
        to: 'Distribution Center',
        distance: returnDist,
        estimatedMinutes: Math.round((returnDist / avgSpeedMph) * 60),
        cumulativeDistance: cumulativeDistance,
        cumulativeMinutes: Math.round(cumulativeTime)
    });
    
    // Assign stop numbers to optimized stops
    const numberedStops = optimizedStops.map((stop, index) => ({
        ...stop,
        stop_number: index + 1,
        estimated_arrival_minutes: segments[index]?.cumulativeMinutes || 0
    }));
    
    return {
        success: true,
        original: {
            distance: Math.round(originalDistance * 10) / 10,
            stops: validStops
        },
        optimized: {
            distance: Math.round(optimizedDistance * 10) / 10,
            stops: numberedStops,
            segments: segments
        },
        savings: {
            miles: Math.round(milesSaved * 10) / 10,
            percent: Math.round(percentSaved * 10) / 10,
            fuelGallons: Math.round(fuelSaved * 10) / 10,
            fuelCost: Math.round(costSaved * 100) / 100
        },
        costs: {
            totalMiles: Math.round(optimizedDistance * 10) / 10,
            fuelGallons: Math.round(fuelGallons * 10) / 10,
            fuelCost: Math.round(fuelCost * 100) / 100,
            laborCost: Math.round(laborCost * 100) / 100,
            totalCost: Math.round(totalCost * 100) / 100
        },
        time: {
            drivingMinutes: Math.round(drivingTimeHours * 60),
            stopMinutes: Math.round(stopTimeHours * 60),
            totalMinutes: Math.round(totalTimeHours * 60),
            totalHours: Math.round(totalTimeHours * 10) / 10
        },
        parameters: {
            fuelPricePerGallon,
            truckMpg,
            avgSpeedMph,
            stopDurationMinutes,
            driverHourlyRate
        }
    };
}

/**
 * Cluster stops by geographic proximity (for multi-truck scenarios)
 * Uses simple k-means style clustering
 */
function clusterStops(stops, numClusters) {
    if (!stops || stops.length === 0 || numClusters <= 0) {
        return [];
    }
    
    if (stops.length <= numClusters) {
        return stops.map(stop => [stop]);
    }
    
    // Initialize centroids using k-means++ style
    const centroids = [];
    const validStops = stops.filter(s => s.lat && s.lng);
    
    // First centroid is random
    centroids.push(validStops[Math.floor(Math.random() * validStops.length)]);
    
    // Subsequent centroids chosen based on distance
    while (centroids.length < numClusters) {
        let maxDist = -1;
        let farthest = null;
        
        for (const stop of validStops) {
            const minDistToCentroid = Math.min(...centroids.map(c => 
                haversineDistance(stop.lat, stop.lng, c.lat, c.lng)
            ));
            if (minDistToCentroid > maxDist) {
                maxDist = minDistToCentroid;
                farthest = stop;
            }
        }
        
        if (farthest) centroids.push(farthest);
    }
    
    // Assign stops to nearest centroid
    const clusters = Array(numClusters).fill(null).map(() => []);
    
    for (const stop of validStops) {
        let nearestCluster = 0;
        let nearestDist = Infinity;
        
        for (let i = 0; i < centroids.length; i++) {
            const dist = haversineDistance(stop.lat, stop.lng, centroids[i].lat, centroids[i].lng);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestCluster = i;
            }
        }
        
        clusters[nearestCluster].push(stop);
    }
    
    return clusters.filter(c => c.length > 0);
}

module.exports = {
    haversineDistance,
    calculateRouteDistance,
    nearestNeighbor,
    twoOptImprove,
    optimizeRoute,
    clusterStops
};
