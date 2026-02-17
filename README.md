# RouteCRMPro Multi-Tenant SaaS

A complete multi-tenant distribution management system for propane and gas delivery operations.

## Features

- **Route-Based Delivery**: Generate optimized routes for all customers at a distribution center
- **Multi-Tenant**: Each company gets isolated data with their own subdomain
- **Interactive Maps**: Google Maps integration with address autocomplete
- **Click-to-Add**: Add customers directly by clicking businesses on the map
- **Comprehensive Profiles**: 60+ fields for trucks and drivers including compliance tracking
- **Order Management**: Track individual deliveries and billing
- **Weather Integration**: Live radar overlay and forecasts

## Tech Stack

- **Frontend**: React (CDN-based, single HTML file)
- **Backend**: Netlify Functions (Node.js serverless)
- **Database**: Neon PostgreSQL
- **Maps**: Google Maps JavaScript API + Places + Directions
- **Auth**: JWT tokens with bcrypt password hashing

## Quick Start

### 1. Database Setup
1. Create free database at [neon.tech](https://neon.tech)
2. Run `sql/schema.sql` in SQL Editor
3. Run `sql/enhanced-profiles.sql` for extended fields

### 2. Google Maps API
1. Enable Maps JavaScript, Places, Directions, Geocoding APIs
2. Create API key with domain restrictions

### 3. Deploy to Netlify
Set environment variables:
```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SECRET=your-secure-random-string-32-chars
GOOGLE_MAPS_API_KEY=your-google-api-key
```

### 4. Access
- **Admin Panel**: `/admin.html` (login: admin / admin123)
- **Create Company**: Add tenant in admin panel
- **Company App**: `/?tenant=subdomain`

## Documentation

- **[SETUP_GUIDE.md](SETUP_GUIDE.md)** - Detailed deployment instructions
- **[USER_GUIDE.md](USER_GUIDE.md)** - How to use the application

## Core Workflow

1. **Distribution Centers**: Add your warehouses/depots with addresses
2. **Customers**: Add customers with addresses (autocomplete captures coordinates)
3. **Generate Routes**: Select DC → Generate optimized routes for all customers
4. **Orders**: Track individual deliveries and billing

## File Structure

```
├── public/
│   ├── index.html      # Login portal
│   ├── app.html        # Main application
│   └── admin.html      # Super admin panel
├── netlify/functions/  # Serverless API
│   ├── auth.js         # Authentication
│   ├── data.js         # CRUD operations
│   └── routes-v2.js    # Route optimization
├── sql/
│   ├── schema.sql      # Core tables
│   └── enhanced-profiles.sql  # Extended fields
└── package.json
```

## Default Credentials

| Portal | Username | Password |
|--------|----------|----------|
| Super Admin | admin | admin123 |

**Change immediately after first login!**
