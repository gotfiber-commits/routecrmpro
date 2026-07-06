# RouteCRMPro Setup Guide

Complete setup guide for deploying RouteCRMPro - a multi-tenant SaaS platform for propane and gas delivery operations.

---

## Prerequisites

- GitHub account
- Netlify account (free tier works)
- Neon PostgreSQL account (free tier works)
- Google Cloud account (for Maps API)

---

## Step 1: Database Setup (Neon PostgreSQL)

### 1.1 Create Neon Account & Project
1. Go to [neon.tech](https://neon.tech) and sign up
2. Create a new project (e.g., "routecrmpro")
3. Copy your connection string from the dashboard

### 1.2 Initialize Database Schema
In Neon Console, click **SQL Editor** and run these files in order:

1. **`sql/schema.sql`** - Creates core tables (companies, users, customers, orders, routes, etc.)
2. **`sql/enhanced-profiles.sql`** - Adds 60+ extended fields for trucks and drivers

### 1.3 Verify Setup
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' ORDER BY table_name;
```

Expected tables: `companies`, `customers`, `distribution_centers`, `drivers`, `orders`, `route_stops`, `routes`, `super_admins`, `trucks`, `users`

---

## Step 2: Google Maps API Setup

### 2.1 Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project
3. Enable billing

### 2.2 Enable These APIs
- **Maps JavaScript API**
- **Places API**
- **Directions API**
- **Geocoding API**

### 2.3 Create & Restrict API Key
1. Credentials → Create Credentials → API Key
2. Restrict to HTTP referrers: `*.netlify.app/*`, `localhost:*`
3. Restrict to the 4 APIs above

---

## Step 3: Deploy to Netlify

### 3.1 Connect Repository
1. Push code to GitHub
2. In Netlify: Add new site → Import from Git → Select repo

### 3.2 Build Settings
- **Build command:** (leave empty)
- **Publish directory:** `public`
- **Functions directory:** `netlify/functions`

### 3.3 Environment Variables
Add in Netlify → Site settings → Environment variables:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `postgresql://user:pass@host/db?sslmode=require` |
| `JWT_SECRET` | Random 32+ character string |
| `GOOGLE_MAPS_API_KEY` | Your Google Maps API key |

Generate JWT secret: `openssl rand -base64 32`

### 3.4 Deploy
Click Deploy - Netlify builds automatically on each push.

---

## Step 4: Initial Access

### Super Admin Panel
- URL: `https://your-site.netlify.app/admin.html`
- Default login: `admin` / `admin123`
- **Change password immediately!**

### Create a Company (Tenant)
1. In admin panel, click "Create Company"
2. Enter company name, subdomain, admin email/password
3. Company can now access: `https://your-site.netlify.app/?tenant=SUBDOMAIN`

---

## Step 5: Company Setup Workflow

Once logged into a company account:

### 1. Add Distribution Center(s)
- Sidebar → Distribution Centers → + Add DC
- Enter code, name, address (use autocomplete!)
- Address autocomplete automatically captures lat/lng coordinates

### 2. Add Customers
- Sidebar → Customers → + Add Customer
- Enter code, name, address (use autocomplete!)
- Select preferred DC
- Set tank size (default 500 gal)

### 3. Generate Routes
- Sidebar → Generate Routes
- Select a Distribution Center
- All customers for that DC appear on map
- Click "Generate Routes" to create optimized delivery routes

---

## File Structure

```
routecrmpro-saas/
├── public/
│   ├── index.html          # Login portal
│   ├── app.html            # Main application (React)
│   └── admin.html          # Super admin panel
├── netlify/functions/      # Serverless API
│   ├── auth.js             # Authentication
│   ├── data.js             # CRUD for all entities
│   ├── routes-v2.js        # Route optimization
│   └── utils/              # Shared utilities
├── sql/
│   ├── schema.sql          # Core database tables
│   └── enhanced-profiles.sql # Extended truck/driver fields
└── package.json
```

---

## Troubleshooting

### Login Issues
- Verify DATABASE_URL in Netlify env vars
- Check super_admins table exists and has admin user
- Reset password with: `sql/reset-admin-password.sql`

### Map Not Loading
- Check GOOGLE_MAPS_API_KEY is set
- Verify API key allows your domain
- Confirm all 4 Google APIs are enabled

### Routes Not Generating
- Customers must have lat/lng coordinates
- Customers must be assigned to the selected DC
- Check Google Directions API is enabled

### Reset Admin Password
```sql
UPDATE super_admins 
SET password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3.rjViVaRF1tpBRiC1S2'
WHERE username = 'admin';
-- Resets to: admin / admin123
```

---

## Quick Reference

| URL | Purpose |
|-----|---------|
| `/` | Login portal |
| `/app.html?tenant=X` | Company application |
| `/admin.html` | Super admin panel |

| Default Credentials | |
|-----|-----|
| Super Admin | admin / admin123 |
