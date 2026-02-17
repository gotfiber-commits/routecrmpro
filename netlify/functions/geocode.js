// Geocoding API - Converts addresses to lat/lng coordinates using Google Maps
const { success, error } = require('./utils/response');

exports.handler = async (event) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return error('Method not allowed', 405);
    }

    try {
        const { address, city, state, zip } = JSON.parse(event.body || '{}');
        
        // Build full address string
        const parts = [address, city, state, zip].filter(Boolean);
        if (parts.length === 0) {
            return error('Address is required', 400);
        }
        
        const fullAddress = parts.join(', ');
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        
        if (!apiKey) {
            return error('Google Maps API key not configured', 500);
        }
        
        // Call Google Geocoding API
        const encodedAddress = encodeURIComponent(fullAddress);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const location = data.results[0].geometry.location;
            const formattedAddress = data.results[0].formatted_address;
            
            return success({
                lat: location.lat,
                lng: location.lng,
                formatted_address: formattedAddress,
                original_query: fullAddress
            });
        } else if (data.status === 'ZERO_RESULTS') {
            return error('Address not found. Please check the address and try again.', 404);
        } else if (data.status === 'REQUEST_DENIED') {
            console.error('Google API error:', data.error_message);
            return error('Geocoding service unavailable. Check API key configuration.', 500);
        } else {
            console.error('Geocoding failed:', data.status, data.error_message);
            return error(`Geocoding failed: ${data.status}`, 500);
        }
        
    } catch (err) {
        console.error('Geocode error:', err);
        return error('Failed to geocode address', 500);
    }
};
