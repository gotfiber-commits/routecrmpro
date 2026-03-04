// ═══════════════════════════════════════════════════════════════════
// netlify/functions/ors-routing.js
// Serverless proxy for OpenRouteService API
// Keeps API key server-side, handles rate limiting
// ═══════════════════════════════════════════════════════════════════

const ORS_BASE_URL = 'https://api.openrouteservice.org';

// Simple in-memory rate limiter (resets per function cold start)
const rateLimiter = {
  directions: { count: 0, resetTime: Date.now() + 60000, limit: 38 },
  matrix: { count: 0, resetTime: Date.now() + 60000, limit: 18 }
};

function checkRateLimit(type) {
  const limiter = rateLimiter[type];
  if (Date.now() > limiter.resetTime) {
    limiter.count = 0;
    limiter.resetTime = Date.now() + 60000;
  }
  if (limiter.count >= limiter.limit) {
    return false;
  }
  limiter.count++;
  return true;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ORS_API_KEY not configured in environment variables' })
    };
  }

  try {
    const { action, payload } = JSON.parse(event.body);

    // ─── ACTION: MATRIX ─────────────────────────────────────────────
    // Returns driving distance & duration between all pairs of locations
    // Used by the optimizer to build real road-based cost matrix
    if (action === 'matrix') {
      if (!checkRateLimit('matrix')) {
        return {
          statusCode: 429, headers,
          body: JSON.stringify({ error: 'Rate limit reached for matrix API. Wait 60s.' })
        };
      }

      const { locations, metrics } = payload;
      // locations = [[lng, lat], ...] — NOTE: ORS uses [longitude, latitude] order!

      if (!locations || locations.length < 2) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Need at least 2 locations' }) };
      }

      if (locations.length > 50) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: `Max 50 locations on free tier. Got ${locations.length}.` })
        };
      }

      const response = await fetch(`${ORS_BASE_URL}/v2/matrix/driving-car`, {
        method: 'POST',
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations,
          metrics: metrics || ['distance', 'duration'],
          units: 'mi'
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        return { statusCode: response.status, headers, body: JSON.stringify({ error: `ORS Matrix error`, details: errText }) };
      }

      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ─── ACTION: DIRECTIONS ─────────────────────────────────────────
    // Returns GeoJSON route geometry for map display
    if (action === 'directions') {
      if (!checkRateLimit('directions')) {
        return {
          statusCode: 429, headers,
          body: JSON.stringify({ error: 'Rate limit reached for directions API. Wait 60s.' })
        };
      }

      const { coordinates } = payload;
      if (!coordinates || coordinates.length < 2) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Need at least 2 coordinates' }) };
      }

      if (coordinates.length > 50) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: `Max 50 waypoints. Got ${coordinates.length}. Split into segments.` })
        };
      }

      const response = await fetch(`${ORS_BASE_URL}/v2/directions/driving-car/geojson`, {
        method: 'POST',
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates, instructions: true, units: 'mi' })
      });

      if (!response.ok) {
        const errText = await response.text();
        return { statusCode: response.status, headers, body: JSON.stringify({ error: `ORS Directions error`, details: errText }) };
      }

      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ─── ACTION: DIRECTIONS-BATCH ───────────────────────────────────
    // Gets road directions for multiple truck routes sequentially
    if (action === 'directions-batch') {
      const { routes } = payload;
      if (!routes || routes.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least 1 route required' }) };
      }

      const results = [];
      for (const route of routes) {
        if (!checkRateLimit('directions')) {
          results.push({ truckId: route.truckId, error: 'Rate limited — retry in 60s' });
          continue;
        }
        if (!route.coordinates || route.coordinates.length < 2) {
          results.push({ truckId: route.truckId, error: 'Need at least 2 waypoints' });
          continue;
        }

        try {
          const response = await fetch(`${ORS_BASE_URL}/v2/directions/driving-car/geojson`, {
            method: 'POST',
            headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinates: route.coordinates, instructions: true, units: 'mi' })
          });

          if (response.ok) {
            const data = await response.json();
            results.push({ truckId: route.truckId, geojson: data });
          } else {
            results.push({ truckId: route.truckId, error: await response.text() });
          }
        } catch (err) {
          results.push({ truckId: route.truckId, error: err.message });
        }

        // Respectful delay between sequential requests
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      return { statusCode: 200, headers, body: JSON.stringify({ routes: results }) };
    }

    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `Unknown action: ${action}. Use 'matrix', 'directions', or 'directions-batch'` })
    };

  } catch (err) {
    console.error('ORS routing error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', message: err.message }) };
  }
};
