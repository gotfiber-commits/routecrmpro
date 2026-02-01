# RouteCRMPro Multi-Tenant SaaS

A complete multi-tenant distribution management system for propane delivery operations.

## Tech Stack
- **Frontend**: React (CDN)
- **Backend**: Netlify Functions (Node.js)
- **Database**: Neon PostgreSQL
- **Auth**: JWT tokens

## Quick Setup

### 1. Database (Neon)
1. Create free database at [neon.tech](https://neon.tech)
2. Run `sql/schema.sql` in Neon SQL Editor
3. Copy your connection string

### 2. Environment Variables
Set in Netlify Dashboard or `.env`:
```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SECRET=your-secure-random-string
```

### 3. Create Super Admin
```bash
npm install
node scripts/setup-db.js
```
Copy the generated SQL and run in Neon.

### 4. Deploy
```bash
netlify deploy --prod
```

## Usage

### Super Admin Portal
- URL: `yoursite.com/admin.html`
- Login: `superadmin` / `superadmin123`
- Create companies, manage plans, set up admins

### Tenant App
- URL: `yoursite.com/?tenant=company-slug`
- Company admins create users for their team
- Roles: admin, driver, dispatch, accounting, payroll

## API Structure

```
/.netlify/functions/
  super-auth    - Super admin login
  companies     - Company CRUD (super admin)
  auth          - Tenant user login
  data          - All tenant operations
```

## Plan Limits

| Plan | Users | DCs | Trucks |
|------|-------|-----|--------|
| Trial | 5 | 1 | 5 |
| Starter | 10 | 2 | 15 |
| Professional | 50 | 10 | 50 |
| Enterprise | ∞ | ∞ | ∞ |
