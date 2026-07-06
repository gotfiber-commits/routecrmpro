# RouteCRMPro Environment Variables
# Copy this to .env and fill in your values

# Neon PostgreSQL connection string
# Get this from your Neon dashboard
DATABASE_URL=postgres://user:password@ep-example.region.aws.neon.tech/neondb?sslmode=require

# JWT Secret - use a strong random string in production
# Generate with: openssl rand -base64 32
# IMPORTANT: This must be the same across all environments
# Default for development: development-secret-key-change-in-production
JWT_SECRET=development-secret-key-change-in-production

# Google Maps API Key (for geocoding and maps)
# Get this from Google Cloud Console - enable Maps JavaScript API, Places API, and Geocoding API
GOOGLE_MAPS_API_KEY=your-google-maps-api-key

# Optional: Stripe keys for billing (future)
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...
